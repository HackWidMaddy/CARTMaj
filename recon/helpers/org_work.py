"""
Org-level work (plan §4.9): a passive lookup keyed on a registrable domain runs
once per run, the first time a group of that org reaches it, and the org's
other groups get a copy of the answer, so each group's output (and the graph
write made from it) still carries it.

Groups run one after another and only a group that passed RoE and ownership
reaches its lookups, so "the first group to reach it" is the first eligible
group. A failed lookup is not cached: the org's next group retries it.
"""
import copy
import threading
from typing import Any, Callable, Tuple

from recon.helpers import circuit_breaker

_claim_lock = threading.Lock()


def org_of(recon_data: dict) -> str:
    """The registrable domain a recon dict's group belongs to: metadata.org_domain,
    else (a file written before scope_mode) its own domain."""
    metadata = (recon_data or {}).get("metadata") or {}
    return str(metadata.get("org_domain") or (recon_data or {}).get("domain") or "").strip().lower()


def once_per_org(work: str, org: str, fetch: Callable[[str], Any],
                 answered: Callable[[Any], bool] = bool, label: str = "Org") -> Tuple[Any, bool]:
    """``fetch(org)`` once per run for this ``work``; returns ``(value, fetched)``.

    ``answered(value)`` says whether the value is an answer (cached) or a
    failure (not cached). A cached value is handed out as a copy, since the
    caller's group output is mutated afterwards.
    """
    cache = circuit_breaker.run_cache(f"org:{work}")
    hit, value = cache.get(org)
    if hit:
        print(f"[*][{label}] {org}: answered earlier this run, reused")
        return copy.deepcopy(value), False
    value = fetch(org)
    if answered(value):
        cache.put(org, copy.deepcopy(value))
    return value, True


def claim_org(work: str, org: str) -> bool:
    """True the first time ``work`` claims ``org`` this run, False after. For work
    whose result is written once (DNS findings), not copied into every group."""
    cache = circuit_breaker.run_cache(f"org-claim:{work}")
    with _claim_lock:
        hit, _ = cache.get(org)
        if hit:
            return False
        cache.put(org, True)
        return True


def claimed_orgs(work: str) -> list:
    return circuit_breaker.run_cache(f"org-claim:{work}").keys()


def note_ownership_proven(org: str) -> None:
    """Ownership was proven at <prefix>.<org> this run (§4.8)."""
    circuit_breaker.run_cache("org-ownership").put(str(org).lower(), True)


def org_in_scope(org: str, scope_groups) -> bool:
    """§4.9: some group of the run has the org as its scan root (any mode), or
    ownership was proven at <prefix>.<org> this run. Active org-level work
    (origin discovery's candidate key) needs it; passive work does not."""
    org = str(org or "").lower()
    if not org:
        return False
    for g in scope_groups or []:
        if isinstance(g, dict) and str(g.get("scan_root") or g.get("scanRoot") or "").lower() == org:
            return True
    return circuit_breaker.run_cache("org-ownership").get(org)[0]
