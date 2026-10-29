"""
The scope of one recon dict, as the full pipeline stamps it in `metadata` (§4.10).

Each scanner reads its group's scope from here instead of re-deriving it from
`domain` and `subdomain_filter`. A recon file written before `scope_mode`
existed (a legacy file, or a partial run's graph-built dict) has `mode` None,
and every caller keeps its old behaviour for it: the scan root is a target
unless `include_root_domain` is explicitly False, and anything under it is in
scope.
"""
from dataclasses import dataclass
from typing import Optional

_MODES = ("exact", "enumerate")


def _norm(value) -> str:
    return str(value or "").strip().strip(".").lower()


@dataclass(frozen=True)
class ReconScope:
    scan_root: str
    org_domain: str
    mode: Optional[str]          # "exact" | "enumerate" | None (legacy file)
    include_root: bool
    exact_hosts: frozenset       # EXACT: the listed hosts, the scan root excluded
    ip_mode: bool

    @property
    def exact(self) -> bool:
        return self.mode == "exact"

    @property
    def enumerate(self) -> bool:
        return self.mode == "enumerate"

    @property
    def may_inject(self) -> bool:
        """May names found in certificates, JS or search engines join the scan?
        An EXACT group scans its listed hosts and nothing else."""
        return self.mode != "exact"

    def admits(self, host) -> bool:
        """§4.6 scan targets: the scan root only when it is a target; an EXACT
        group's listed hosts; anything strictly under an ENUMERATE (or legacy)
        root."""
        h = _norm(host)
        if not h or not self.scan_root:
            return False
        if h == self.scan_root:
            return self.include_root
        if self.exact:
            return h in self.exact_hosts
        return h.endswith("." + self.scan_root)

    def targets(self) -> list:
        """An EXACT group's whole target list: its hosts, plus the root when on."""
        return sorted(self.exact_hosts | ({self.scan_root} if self.include_root and self.scan_root else set()))


def recon_scope(recon_data: dict) -> ReconScope:
    meta = (recon_data or {}).get("metadata") or {}
    root = _norm((recon_data or {}).get("domain") or meta.get("root_domain") or meta.get("target"))
    mode = meta.get("scope_mode") if meta.get("scope_mode") in _MODES else None
    exact = frozenset()
    if mode == "exact":
        exact = frozenset(h for h in (_norm(x) for x in meta.get("subdomain_filter") or []) if h and h != root)
    return ReconScope(
        scan_root=root,
        org_domain=_norm(meta.get("org_domain")) or root,
        mode=mode,
        include_root=bool(meta.get("include_root_domain", True)),
        exact_hosts=exact,
        ip_mode=bool(meta.get("ip_mode")) or root.startswith("ip-targets."),
    )
