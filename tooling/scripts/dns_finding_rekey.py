#!/usr/bin/env python3
"""Re-key a Domain batch's DNS findings after its grouping changed. DRY RUN BY DEFAULT.

WHY

An SPF, DMARC, DNSSEC or zone-transfer finding of a Domain batch has no url,
host or ip, so its Vulnerability id is keyed on the batch root the check ran on
(`stable_vuln_id(type, "", root, ...)`, graph_db/mixins/recon/vuln_mixin.py).
When the grouping moves that root, the next scan writes the finding under a NEW
id, and everything that names the old one is left behind:

  - the `:Muted` label and the mute properties on the node;
  - the Priority Board layers (`triage_*`), a person's DECISION included;
  - `NodeFilterExemption.nodeKey` (an un-mute: orphaned, the rule hides the
    finding again), `Remediation.findingIds`, `CapturedHttpTransaction.findingId`.

The roots move twice: in release B a batch root that was a public suffix
(`co.uk`, from the old last-two-labels rule) becomes its registrable domain
(`acme.co.uk`); in release D a deeper scan root's checks move to its org. In both
the new key is the org of the batch hosts under the old root, by the Public
Suffix List. A single-domain project keys these findings on "" and never moves.

WHAT IT DOES

For every DNS finding hanging off a Domain whose name its id was keyed on:
  - one org under the old root  -> re-keyed to that org's id;
  - no org (a removed root)     -> left alone; the next full recon prunes it;
  - several orgs (co.uk held acme.co.uk AND other.co.uk) -> listed, NOT
    re-keyed: the old finding was about the suffix itself, and a mute or a
    verdict on it says nothing about either org's mail records.

A re-key renames the node's id in place when no node holds the new id yet (the
upgrade order: run this before the first scan on the new release), so every
layer, the mute and `stale_since` stay exactly as they were. When a scan already
wrote the new id, the triage layers move as one block from one node (a person's
decision first, then a review), the mute is carried with its provenance, and the
old node is deleted, as tooling/scripts/triage_graph_migrate.py merges
duplicates. It never computes a score and never writes `updated_at`; the next
publish recombines.

  # what it would do, per project, changing nothing (the default)
  python tooling/scripts/dns_finding_rekey.py --all

  # after a Neo4j and Postgres backup, with the services stopped
  docker compose stop agent webapp recon-orchestrator
  python tooling/scripts/dns_finding_rekey.py --all --apply
  docker compose start agent webapp recon-orchestrator

It needs the Neo4j driver, psycopg (DATABASE_URL) and the pinned
publicsuffixlist (recon/requirements.txt). The agent image has the first two:

  docker run --rm --network CART-network -v "$PWD:/repo" -w /repo \\
    -e PYTHONPATH=/repo -e NEO4J_URI=bolt://neo4j:7687 -e NEO4J_USER -e NEO4J_PASSWORD \\
    -e DATABASE_URL --entrypoint sh CART-agent -c \\
    'pip install -q "$(grep ^publicsuffixlist== recon/requirements.txt | cut -d" " -f1)" \\
     && python tooling/scripts/dns_finding_rekey.py --all'

Idempotent: a second run finds nothing to re-key.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from graph_db.mixins.recon.vuln_mixin import stable_vuln_id  # noqa: E402
from tooling.scripts.triage_graph_migrate import (  # noqa: E402
    MUTE_PROPS, MUTE_PROVENANCE_PROPS, TRIAGE_PROPS, services_are_up,
)

#: The domain-level checks whose id is keyed on the batch root
#: (recon/helpers/security_checks.py run_dns_checks).
DNS_TYPES = ("spf_missing", "dmarc_missing", "dnssec_missing", "zone_transfer")

PROJECTS = """
    SELECT id, user_id, domain_batch_hosts
      FROM projects
     WHERE domain_batch_mode {scope}
     ORDER BY created_at
"""

DNS_FINDINGS = """
MATCH (d:Domain {user_id: $uid, project_id: $pid})-[:HAS_VULNERABILITY]->
      (v:Vulnerability {user_id: $uid, project_id: $pid})
WHERE v.type IN $types AND coalesce(v.url, '') = ''
  AND v.hostname IS NULL AND v.matched_ip IS NULL
RETURN DISTINCT d.name AS domain, v.id AS id, v.type AS type
ORDER BY id
"""

READ_PAIR = """
MATCH (v:Vulnerability {user_id: $uid, project_id: $pid})
WHERE v.id IN [$old, $new]
RETURN v.id AS id, v:Muted AS muted, properties(v) AS props
"""

RENAME = """
MATCH (v:Vulnerability {id: $old, user_id: $uid, project_id: $pid})
SET v.id = $new
RETURN count(v) AS n
"""

MERGE_ONTO_NEW = """
MATCH (keep:Vulnerability {id: $new, user_id: $uid, project_id: $pid})
MATCH (dead:Vulnerability {id: $old, user_id: $uid, project_id: $pid})
{remove}SET keep += $carried
FOREACH (_ IN CASE WHEN $mute THEN [1] ELSE [] END | SET keep:Muted)
DETACH DELETE dead
RETURN count(keep) AS n
"""


def _under(host: str, root: str) -> bool:
    return host == root or host.endswith("." + root)


def _hosts(entries) -> list[str]:
    out = []
    for raw in entries or []:
        host = str(raw or "").strip().lower().rstrip(".")
        if host.startswith("*."):
            host = host[2:]
        if host:
            out.append(host)
    return out


def new_root_for(old_root: str, batch_hosts, org_domain) -> tuple[str | None, list[str]]:
    """(the org the old root's checks move to, every org found), by the PSL.

    The orgs of the batch hosts at or under the old root, plus the old root's own
    org (a deep root keeps one even with no host listed under it).
    """
    old = old_root.lower()
    orgs = {org_domain(h) for h in _hosts(batch_hosts) if _under(h, old)}
    orgs.add(org_domain(old))
    orgs.discard(None)
    found = sorted(orgs)
    return (found[0] if len(found) == 1 else None), found


def plan_project(session, project: dict, org_domain) -> dict:
    """The re-keys one project needs. Reads the graph; writes nothing."""
    uid, pid = project["user_id"], project["id"]
    rekeys, ambiguous = [], []
    for row in session.run(DNS_FINDINGS, uid=uid, pid=pid, types=list(DNS_TYPES)):
        old_root = row["domain"]
        # Only a finding whose id really is keyed on this root: a single-domain
        # finding, or one a writer keyed otherwise, is not this script's.
        if stable_vuln_id(row["type"], "", old_root, uid, pid) != row["id"]:
            continue
        new_root, orgs = new_root_for(old_root, project.get("domain_batch_hosts"), org_domain)
        if new_root is None:
            if len(orgs) > 1:
                ambiguous.append({"id": row["id"], "type": row["type"], "old_root": old_root,
                                  "orgs": orgs})
            continue
        new_id = stable_vuln_id(row["type"], "", new_root, uid, pid)
        if new_id != row["id"]:
            rekeys.append({"old_id": row["id"], "new_id": new_id, "type": row["type"],
                           "old_root": old_root, "new_root": new_root})
    return {"rekeys": rekeys, "ambiguous": ambiguous}


def _block_rank(props: dict) -> int:
    """Which node's triage block survives: a person's decision, then a review
    (as `_PERSON_DECIDED` and the review verdicts in triage_mixin.py)."""
    if (props.get("triage_source") == "human"
            and props.get("triage_status") in ("confirmed", "likely_noise")):
        return 0
    if props.get("triage_ai_verdict") not in (None, "not_reviewed"):
        return 1
    if any(props.get(p) is not None for p in TRIAGE_PROPS):
        return 2
    return 3


def rekey_graph(session, uid: str, pid: str, rekey: dict) -> str:
    """Move one finding to its new id. Returns 'renamed', 'merged' or 'gone'."""
    nodes = {r["id"]: r for r in session.run(
        READ_PAIR, uid=uid, pid=pid, old=rekey["old_id"], new=rekey["new_id"])}
    old, new = nodes.get(rekey["old_id"]), nodes.get(rekey["new_id"])
    if old is None:
        return "gone"
    if new is None:
        session.run(RENAME, uid=uid, pid=pid, old=rekey["old_id"], new=rekey["new_id"])
        return "renamed"

    old_props, new_props = dict(old["props"] or {}), dict(new["props"] or {})
    # The layers move as ONE block from ONE node: mixing them would pair one
    # node's review with the other's evidence hash, or a decision with a base it
    # was never made on.
    take_old = _block_rank(old_props) < _block_rank(new_props)
    carried = {p: old_props[p] for p in TRIAGE_PROPS if take_old and old_props.get(p) is not None}
    cleared = [p for p in TRIAGE_PROPS if take_old and p in new_props]
    inherits_mute = bool(old["muted"]) and not new["muted"]
    if inherits_mute:
        carried.update({p: old_props[p] for p in MUTE_PROPS if old_props.get(p) is not None})
    else:
        for p in MUTE_PROVENANCE_PROPS:
            carried.pop(p, None)
    remove = f"REMOVE {', '.join('keep.' + p for p in cleared)}\n" if cleared else ""
    session.run(MERGE_ONTO_NEW.replace("{remove}", remove), uid=uid, pid=pid, old=rekey["old_id"],
                new=rekey["new_id"], carried=carried, mute=inherits_mute)
    return "merged"


def rekey_postgres(cursor, pid: str, rekey: dict) -> None:
    """Point every row that names the old id at the new one."""
    params = {"pid": pid, "old": rekey["old_id"], "new": rekey["new_id"], "label": "Vulnerability"}
    # (project_id, label, node_key) is unique: an exemption the new id already
    # has makes the old one redundant.
    cursor.execute(
        """
        UPDATE node_filter_exemptions e SET node_key = %(new)s
         WHERE e.project_id = %(pid)s AND e.label = %(label)s AND e.node_key = %(old)s
           AND NOT EXISTS (SELECT 1 FROM node_filter_exemptions x
                            WHERE x.project_id = %(pid)s AND x.label = %(label)s
                              AND x.node_key = %(new)s)
        """, params)
    cursor.execute(
        """
        DELETE FROM node_filter_exemptions
         WHERE project_id = %(pid)s AND label = %(label)s AND node_key = %(old)s
        """, params)
    cursor.execute(
        """
        UPDATE remediations
           SET finding_ids = CASE WHEN %(new)s = ANY(finding_ids)
                                  THEN array_remove(finding_ids, %(old)s)
                                  ELSE array_replace(finding_ids, %(old)s, %(new)s) END
         WHERE project_id = %(pid)s AND %(old)s = ANY(finding_ids)
        """, params)
    cursor.execute(
        """
        UPDATE captured_http_transactions SET finding_id = %(new)s
         WHERE project_id = %(pid)s AND finding_id = %(old)s
        """, params)


def run(conn, driver, project_id: str | None, apply: bool, org_domain, out=print) -> dict:
    """Plan every batch project and, with `apply`, re-key it. Returns the plan."""
    if project_id is not None and not project_id.strip():
        raise ValueError("a blank project id; pass --all to mean every project")
    with conn.cursor() as cur:
        cur.execute(PROJECTS.format(scope="AND id = %(pid)s" if project_id else ""),
                    {"pid": project_id} if project_id else {})
        cols = [c[0] for c in cur.description]
        projects = [dict(zip(cols, row)) for row in cur.fetchall()]

    summary = {}
    with driver.session() as session:
        for project in projects:
            pid, uid = project["id"], project["user_id"]
            plan = plan_project(session, project, org_domain)
            for a in plan["ambiguous"]:
                out(f"[dns rekey] {pid}: {a['type']} on {a['old_root']} covers several orgs "
                    f"({', '.join(a['orgs'])}); left alone, review it by hand")
            for r in plan["rekeys"]:
                out(f"[dns rekey] {pid}: {r['type']} {r['old_root']} -> {r['new_root']}  "
                    f"{r['old_id']} -> {r['new_id']}{'' if apply else ' (dry run)'}")
            outcomes = []
            if apply and plan["rekeys"]:
                # Postgres first: a run that dies after it re-plans the same
                # re-keys (the graph still holds the old ids) and its updates
                # are no-ops the second time. The other order would leave rows
                # naming an id no re-run can find again.
                with conn.cursor() as cur:
                    for r in plan["rekeys"]:
                        rekey_postgres(cur, pid, r)
                conn.commit()
                for r in plan["rekeys"]:
                    outcomes.append(rekey_graph(session, uid, pid, r))
            if plan["rekeys"] or plan["ambiguous"]:
                summary[pid] = {**plan, "outcomes": outcomes}
    total = sum(len(p["rekeys"]) for p in summary.values())
    out(f"[dns rekey] {'re-keyed' if apply else 'would re-key'} {total} finding(s) "
        f"in {len(summary)} project(s)")
    return summary


def _org_domain():
    """recon's PSL helper, loaded by path: importing the recon.helpers package
    would pull in the scan dependencies (dnspython) this script does not need."""
    import importlib.util
    path = REPO_ROOT / "recon" / "helpers" / "public_suffix.py"
    spec = importlib.util.spec_from_file_location("_rekey_public_suffix", path)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except ImportError as e:
        raise SystemExit(
            f"publicsuffixlist is required ({e}). Install the version pinned in "
            "recon/requirements.txt; see this script's docstring.")
    return module.org_domain


def _connect():
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        raise SystemExit("DATABASE_URL is not set: the fix items and exemptions live in Postgres.")
    try:
        import psycopg
    except ImportError:
        raise SystemExit("psycopg is required. Run this in the agent image (see the docstring).")
    return psycopg.connect(url)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    target = ap.add_mutually_exclusive_group(required=True)
    target.add_argument("--project", help="one project id")
    target.add_argument("--all", action="store_true", help="every Domain batch project")
    ap.add_argument("--apply", action="store_true", help="write; without it this only lists")
    ap.add_argument("--force", action="store_true",
                    help="skip the services-are-down check. Do not.")
    args = ap.parse_args(argv)
    if args.project is not None and not args.project.strip():
        ap.error("--project is blank (an unset variable?); pass --all to mean every project")

    if args.apply:
        up = [] if args.force else services_are_up()
        if up:
            print("REFUSING: these services are still running: " + ", ".join(up), file=sys.stderr)
            print("A scan writing during the re-key would create the new ids under it.",
                  file=sys.stderr)
            return 2
    org_domain = _org_domain()

    from neo4j import GraphDatabase

    driver = GraphDatabase.driver(
        os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
        auth=(os.environ.get("NEO4J_USER", "neo4j"), os.environ.get("NEO4J_PASSWORD", "")))
    try:
        with _connect() as conn:
            run(conn, driver, None if args.all else args.project, args.apply, org_domain)
    finally:
        driver.close()
    if not args.apply:
        print("Nothing was changed. Re-run with --apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
