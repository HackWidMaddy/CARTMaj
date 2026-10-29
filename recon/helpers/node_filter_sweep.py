"""The scan-time node-filter sweep: once, at the end of a recon run.

Full recon and partial recon both call `run_node_filter_sweep` in a `finally`,
so a run that returned early or raised still sweeps what it managed to write.
It is housekeeping, so it NEVER raises and never changes the job's exit code:
a failure prints `[!][NODE-FILTER] sweep failed: ...` and is returned as the
stats' `error`, and the unswept nodes are reconciled by the next scan or by
"apply to current graph".

Scope is what this run wrote: nodes stamped after the run started AND carrying
one of this pipeline's own sources, so a GVM or supply-chain scan writing into
the same window alongside is never filtered by a recon sweep.
"""
from __future__ import annotations


def _default_fetch(project_id):
    from recon.project_settings import fetch_node_filters
    return fetch_node_filters(project_id)


def _default_client():
    from graph_db import Neo4jClient
    return Neo4jClient()


def run_node_filter_sweep(user_id: str, project_id: str, touched_since, sources, *,
                          fetch=None, client_factory=None, log=print) -> dict:
    """Apply the project's armed rules to what this run wrote. Never raises."""
    try:
        if not touched_since:
            # Unscoped would mean the whole graph; a scan has no business doing that.
            log("[*][NODE-FILTER] no run start time, so no scan sweep")
            return {"skipped": "no run start time"}
        node_filter = (fetch or _default_fetch)(project_id)
        if not node_filter or not node_filter.get("applyToScans"):
            return {"skipped": "not armed"}
        with (client_factory or _default_client)() as client:
            stats = client.apply_node_filters(
                user_id, project_id,
                {"mode": node_filter.get("mode", "denylist"), "rules": node_filter.get("rules")},
                exemptions=[tuple(pair) for pair in node_filter.get("exemptions") or []],
                touched_since=touched_since, sources=list(sources or []), log=log,
            )
        return summarize(stats, node_filter.get("revision"))
    except Exception as e:  # noqa: BLE001 - housekeeping must not fail the scan
        log(f"[!][NODE-FILTER] sweep failed: {e}")
        return {"error": str(e)[:500]}


def summarize(stats: dict, revision=None) -> dict:
    """Counts only, for the run's metadata. Never finding text."""
    if not stats.get("ok", False):
        return {"error": stats.get("error", "rules unusable"), "revision": revision}
    return {
        "revision": revision,
        "mode": stats.get("mode"),
        "partial": stats.get("partial", False),
        "totals": stats.get("totals", {}),
        "kinds": {k: {"muted": v["muted"], "unmuted": v["unmuted"], "guarded": v["guarded"],
                      "exempt": v["exempt"]}
                  for k, v in (stats.get("kinds") or {}).items()},
    }
