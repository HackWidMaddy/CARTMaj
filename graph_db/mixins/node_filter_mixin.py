"""Node filters: the one sweep that mutes and unmutes findings by rule.

Filtering is the existing `:Muted` label, stamped `muted_by = 'rule:<kind>/<rule
id>'` (or `'rule:<kind>/allowlist'`). Every agent query, graph view, analytics
query, report and triage read already hides `:Muted`, so nothing on the read
side changes; a rule mute is reversible, because disabling the rule and sweeping
again unmutes exactly what it muted.

There is no write chokepoint to hook: a dozen writers MERGE findings. So the
rules run in a sweep after the writes, and ONE function serves every caller:
the preview (`dry_run`), "apply to current graph", and the end of every scan.
The counts a preview shows are therefore the counts an apply writes.

Per node the sweep computes a TARGET state, then compares:

- a person's own mute is never touched, in either direction;
- a guarded node (a human verdict, a confirmation, an agent CONFIRMS) or an
  exempt one (an operator unmuted it) must not be rule-muted, so a rule mute on
  it is released;
- otherwise the rules decide, and a rule mute attributed to a rule that no
  longer matches is re-attributed or released.

The sweep never writes `updated_at`, and the mute write re-checks the guards so
a verdict set between the read and the write is never hidden by it.
"""
from __future__ import annotations

import os
import re
import time

from graph_db.node_filters.catalog import CatalogError, load_catalog
from graph_db.node_filters.cypher import (
    mute_query, projection_query, restamp_query, unmute_query,
)
from graph_db.node_filters.evaluate import compile as compile_rules, is_missing
from graph_db.node_filters.guards import guard_reasons, is_guarded
from graph_db.node_filters.model import NodeFilterConfig, parse

RULE_PREFIX = "rule:"
ALLOWLIST = "allowlist"

#: Samples kept per rule in a preview.
SAMPLES_PER_RULE = 5

#: Hosts and CVE ids a preview reports for what it would newly mute, so the
#: Apply modal can say how many open remediations may relate. Capped: it is a
#: hint ("may relate"), not an inventory.
RELATED_CAP = 500

_CVE_IN_TEXT = re.compile(r"CVE-\d{4}-\d{4,}", re.IGNORECASE)

#: A projected row is small (a key, flags, a name and the few properties the
#: rules read); this is a generous per-row budget for the memory governor.
_ROW_BYTES = 16 * 1024


def node_filter_page_size() -> int:
    """Rows per keyset page: NODE_FILTER_PAGE_SIZE, tightened under memory pressure."""
    try:
        cap = int(os.getenv("NODE_FILTER_PAGE_SIZE", "2000"))
    except ValueError:
        cap = 2000
    cap = max(50, min(cap, 20000))
    try:
        from graph_db.resource_governor import scaled_cap
        return max(50, int(scaled_cap(cap, _ROW_BYTES, floor=50)))
    except Exception:
        return cap


def muted_by_for(kind: str, rule_id: str | None) -> str:
    return f"{RULE_PREFIX}{kind}/{rule_id or ALLOWLIST}"


def reason_for(config: NodeFilterConfig, kind: str, rule_id: str | None) -> str:
    if not rule_id:
        return "Filter rule: allowlist (kept by no rule)"
    return f"Filter rule: {config.rule_name(kind, rule_id) or rule_id}"


def _empty_kind_stats(active: bool) -> dict:
    return {
        "active": active, "scanned": 0, "would_mute": 0,
        "to_mute": 0, "to_unmute": 0, "to_restamp": 0,
        "muted": 0, "unmuted": 0, "restamped": 0,
        "guarded": 0, "exempt": 0, "operator_muted": 0,
        "missing": {}, "rules": {},
    }


def _count_rules(ks: dict, rule_ids, row: dict, dry_run: bool) -> None:
    for rid in rule_ids:
        entry = ks["rules"].get(rid)
        if entry is None:
            continue
        entry["matched"] += 1
        if dry_run and len(entry["samples"]) < SAMPLES_PER_RULE:
            entry["samples"].append({
                "key": row["key"], "name": row.get("display") or "",
                "host": row.get("host") or "",
                "guards": guard_reasons(row),
            })


class NodeFilterMixin:
    """`apply_node_filters`, the preview, the apply and the scan-time sweep in one."""

    def apply_node_filters(self, user_id: str, project_id: str, config, exemptions=(),
                           kinds=None, touched_since: str | None = None, sources=None,
                           dry_run: bool = False, deadline: float | None = None,
                           heartbeat=None, page_size: int | None = None,
                           catalog=None, log=print) -> dict:
        """Mute what the rules filter, unmute what they no longer do.

        `config` is `{"mode": ..., "rules": ...}` or an already parsed
        `NodeFilterConfig`. `exemptions` is an iterable of `(label, key)`.

        Scope: every enabled-phase kind, or `kinds`. A scan-time sweep passes
        `touched_since` (its run start) and `sources` (its own finding sources)
        so it reconciles only what that scan wrote, never what a scanner running
        alongside wrote in the same window. A `sources` sweep also skips kinds
        none of those sources can produce.

        `deadline` is a `time.monotonic()` bound checked per page; hitting it
        stops the sweep and marks the stats `partial`. `heartbeat(progress)` is
        called after every page with `{"kind", "scanned"}`, and may raise to stop
        the sweep. Returns counts and, for a preview, samples.
        """
        if not user_id or not project_id:
            raise ValueError("apply_node_filters needs a tenant")
        if catalog is None:
            try:
                catalog = load_catalog()
            except CatalogError as e:
                log(f"[!][NODE-FILTER] catalog unusable, nothing filtered: {e}")
                return {"ok": False, "error": f"catalog: {e}", "kinds": {}}

        if not isinstance(config, NodeFilterConfig):
            config = parse((config or {}).get("rules"), (config or {}).get("mode", "denylist"), catalog)
        if not config.ok:
            log(f"[!][NODE-FILTER] rules unusable, nothing filtered: {'; '.join(config.errors)}")
            return {"ok": False, "error": "; ".join(config.errors), "mode": config.mode,
                    "kinds": {}, "errors": list(config.errors)}

        fs = compile_rules(config, catalog)
        exempt = {(str(label), str(key)) for label, key in (exemptions or ())}
        page = page_size or node_filter_page_size()
        scope_sources = [s for s in (sources or []) if s] or None

        wanted = [k for k in (kinds or catalog.kinds_for_enabled_phases()) if k in catalog.kinds]
        if scope_sources is not None:
            wanted = [k for k in wanted if set(catalog.kinds[k].get("sources") or []) & set(scope_sources)]

        stats = {
            "ok": True, "mode": config.mode, "dry_run": bool(dry_run), "partial": False,
            "related": {"hosts": set(), "cves": set()},
            "scope": {"touched_since": touched_since, "sources": scope_sources},
            "kinds": {},
            "errors": list(config.errors) + [e for k in config.kinds.values() for e in k.errors],
        }

        for kind_id in wanted:
            if deadline is not None and time.monotonic() > deadline:
                stats["partial"] = True
                break
            kind = catalog.kinds[kind_id]
            ks = _empty_kind_stats(fs.is_active(kind_id))
            stats["kinds"][kind_id] = ks
            for rule in fs.rules(kind_id):
                ks["rules"][rule.id] = {"name": rule.name, "matched": 0, "samples": []}
            if config.mode == "allowlist" and ks["active"]:
                ks["rules"][ALLOWLIST] = {"name": "Kept by no rule", "matched": 0, "samples": []}

            finished = self._sweep_kind(
                user_id, project_id, config, fs, kind_id, kind, ks, exempt,
                touched_since, scope_sources, dry_run, deadline, heartbeat, page,
                stats["related"])
            if not finished:
                stats["partial"] = True
                break

        stats["related"] = {k: sorted(v)[:RELATED_CAP] for k, v in stats["related"].items()}
        stats["totals"] = {
            key: sum(k[key] for k in stats["kinds"].values())
            for key in ("scanned", "would_mute", "to_mute", "to_unmute", "to_restamp",
                        "muted", "unmuted", "restamped", "guarded", "exempt", "operator_muted")
        }
        if not dry_run:
            self._log_sweep(stats, log)
        return stats

    def _sweep_kind(self, user_id, project_id, config, fs, kind_id, kind, ks, exempt,
                    touched_since, sources, dry_run, deadline, heartbeat, page,
                    related=None) -> bool:
        """One kind, page by page. False when the deadline stopped it."""
        active = ks["active"]
        props = fs.props_needed(kind_id) if active else set()
        query, params = projection_query(
            kind, props, touched=bool(touched_since), sources=bool(sources),
            rule_muted_only=not active)
        params.update(uid=user_id, pid=project_id, page=page)
        if touched_since:
            params["touched_since"] = touched_since
        if sources:
            params["sources"] = list(sources)
        used_fields = fs.fields_used(kind_id)
        label = kind["graph_label"]

        after = ""
        while True:
            with self.driver.session() as session:
                rows = [dict(r) for r in session.run(query, after=after, **params)]
            if not rows:
                return True
            to_mute, to_unmute, to_restamp = [], [], []

            for row in rows:
                ks["scanned"] += 1
                muted, muted_by = bool(row.get("muted")), row.get("muted_by") or ""
                rule_muted = muted and muted_by.startswith(RULE_PREFIX)
                if muted and not rule_muted:
                    # A person's mute: theirs, whatever the rules say.
                    ks["operator_muted"] += 1
                    continue

                target = None  # None = must not be rule-muted
                if active:
                    values = fs.values(kind_id, row.get("props") or {})
                    for field in used_fields:
                        if is_missing(values.get(field)):
                            ks["missing"][field] = ks["missing"].get(field, 0) + 1
                    filtered, matched = fs.decide(kind_id, values)
                    if filtered:
                        attributed = matched[0] if config.mode == "denylist" else None
                        if is_guarded(row):
                            ks["guarded"] += 1
                        elif (label, str(row["key"])) in exempt:
                            ks["exempt"] += 1
                        else:
                            target = attributed or ALLOWLIST
                            ks["would_mute"] += 1
                            counted = matched if config.mode == "denylist" else [ALLOWLIST]
                            _count_rules(ks, counted, row, dry_run)
                    elif config.mode == "allowlist":
                        # An allowlist rule's count is what it keeps: a filtered
                        # node matched no rule, so counting only those would show
                        # every keep rule at 0.
                        _count_rules(ks, matched, row, dry_run)

                if target is None:
                    if rule_muted:
                        to_unmute.append(row["key"])
                    continue
                wanted_by = muted_by_for(kind_id, None if target == ALLOWLIST else target)
                reason = reason_for(config, kind_id, None if target == ALLOWLIST else target)
                if not muted:
                    to_mute.append({"key": row["key"], "muted_by": wanted_by, "reason": reason})
                    if dry_run and related is not None:
                        if row.get("host") and len(related["hosts"]) < RELATED_CAP:
                            related["hosts"].add(str(row["host"]).lower())
                        for cve in _CVE_IN_TEXT.findall(str(row.get("display") or "")):
                            if len(related["cves"]) < RELATED_CAP:
                                related["cves"].add(cve.upper())
                elif muted_by != wanted_by:
                    to_restamp.append({"key": row["key"], "muted_by": wanted_by, "reason": reason})

            ks["to_mute"] += len(to_mute)
            ks["to_unmute"] += len(to_unmute)
            ks["to_restamp"] += len(to_restamp)
            if not dry_run:
                self._flush(kind, user_id, project_id, to_mute, to_unmute, to_restamp, ks)

            after = rows[-1]["key"]
            if heartbeat is not None:
                heartbeat({"kind": kind_id, "scanned": ks["scanned"]})
            if len(rows) < page:
                return True
            if deadline is not None and time.monotonic() > deadline:
                return False

    def _flush(self, kind, user_id, project_id, to_mute, to_unmute, to_restamp, ks):
        with self.driver.session() as session:
            if to_mute:
                rec = session.run(mute_query(kind), rows=to_mute, uid=user_id, pid=project_id).single()
                ks["muted"] += int((rec["n"] if rec else 0) or 0)
            if to_restamp:
                rec = session.run(restamp_query(kind), rows=to_restamp, uid=user_id, pid=project_id).single()
                ks["restamped"] += int((rec["n"] if rec else 0) or 0)
            if to_unmute:
                rec = session.run(unmute_query(kind), keys=to_unmute, uid=user_id, pid=project_id).single()
                ks["unmuted"] += int((rec["n"] if rec else 0) or 0)

    @staticmethod
    def _log_sweep(stats: dict, log) -> None:
        mode = stats["mode"]
        for kind_id, ks in stats["kinds"].items():
            if not (ks["active"] or ks["unmuted"] or ks["muted"]):
                continue
            log(f"[NODE-FILTER] {kind_id} mode={mode} muted={ks['muted']} "
                f"unmuted={ks['unmuted']} restamped={ks['restamped']} "
                f"guarded={ks['guarded']} exempt={ks['exempt']}")
            for rule_id, entry in ks["rules"].items():
                name = str(entry["name"]).replace('"', "'")
                verb = "kept" if mode == "allowlist" and rule_id != ALLOWLIST else "matched"
                log(f'[NODE-FILTER] {kind_id} mode={mode} rule="{name}" {verb}={entry["matched"]}')
        if stats.get("partial"):
            log("[!][NODE-FILTER] sweep stopped early; the remaining nodes are unchanged")
