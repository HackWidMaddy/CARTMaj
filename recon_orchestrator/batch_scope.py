"""
Domain batch: which domains a project would actually scan.

Kept OUT of api.py deliberately. This feeds the hard guardrail, the one control an
operator cannot switch off, and api.py cannot be imported without FastAPI and the
Docker client - so the security decision would have been untestable in the unit
tier. Mirrors auth.py, which is standalone for the same reason.

The contract, and why each half matters:

  - a Domain-batch project has an EMPTY targetDomain and keeps its scope in
    domainBatchGroups, so a guardrail that reads targetDomain alone waves every
    batch target through;
  - a root that fails the charset check is DROPPED, never repaired: a repaired
    hostname would be a target the operator never approved;
  - an empty result in batch mode means "cannot determine scope", which the caller
    must treat as a refusal, not as "nothing to check". Fail closed.
"""
from __future__ import annotations

import re

_BATCH_ROOT_CHARSET = re.compile(r'^[a-z0-9.-]+$')


def batch_guardrail_targets(project: dict) -> list[str]:
    """Every root domain a Domain-batch project would scan, deduplicated, in order."""
    groups = project.get('domainBatchGroups')
    if not isinstance(groups, list):
        return []

    roots: list[str] = []
    for entry in groups:
        if not isinstance(entry, dict):
            continue
        root = str(entry.get('rootDomain') or '').strip().lower()
        if not root or not _BATCH_ROOT_CHARSET.match(root) or '..' in root:
            continue
        if root not in roots:
            roots.append(root)
    return roots


# ---------------------------------------------------------------------------
# Partial recon. The orchestrator is the only authority on which roots a run
# may touch: the client names at most a subset, never a root of its own.
# ---------------------------------------------------------------------------

# The only settings a partial run may override: the Nuclei checkboxes, the one
# thing the modal sends. The recon modules apply every override they receive,
# so an open dict would let a crafted request switch off ROE_ENABLED or empty
# ROE_EXCLUDED_HOSTS. Mirrors ALLOWED_SETTINGS_OVERRIDES in recon/partial_recon.py,
# which drops anything else again inside the container.
PARTIAL_OVERRIDE_KEYS = frozenset({
    'CVE_LOOKUP_ENABLED',
    'MITRE_ENABLED',
    'SECURITY_CHECK_ENABLED',
})

# Same ceiling as a Domain batch (MAX_BATCH_GROUPS in webapp/src/lib/domainBatch.ts).
MAX_REQUESTED_ROOTS = 50


class PartialScopeError(ValueError):
    """A partial-recon start to refuse, with the HTTP status to refuse it with."""

    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _usable_root(root: str) -> bool:
    # The charset is checked on the lowercased name but the stored spelling is
    # kept: a single-domain target is saved trimmed, not lowercased, and the
    # graph's Domain node carries exactly that name.
    low = root.strip().lower()
    return bool(low) and bool(_BATCH_ROOT_CHARSET.match(low)) and '..' not in low


def partial_project_roots(project: dict, project_id: str) -> list[str]:
    """Every root this project scans, re-validated. Raises PartialScopeError(400)."""
    if project.get('ipMode', False):
        # The name recon/main.py mints for IP mode's synthetic Domain node.
        roots = [f"ip-targets.{project_id}"]
    elif project.get('domainBatchMode', False):
        roots = ([g['scanRoot'] for g in scope_groups(project)] if 'scopeGroups' in project
                 else batch_guardrail_targets(project))
        if not roots:
            raise PartialScopeError(
                400,
                "Domain batch project has no valid domain groups. "
                "Re-save the project's hostname list before scanning.",
            )
    else:
        target = str(project.get('targetDomain') or '').strip()
        roots = [target] if target else []

    roots = [r for r in roots if _usable_root(r)]
    if not roots:
        raise PartialScopeError(400, "This project has no usable scan target.")
    return roots


def narrow_partial_roots(roots: list[str], graph_inputs: dict) -> list[str]:
    """The project roots this run covers, narrowed by the request. Sorted.

    `graph_inputs.domains` is intersected with the roots. A legacy request (a
    job queued before multi-root partial recon) carries only `domain`, which
    must be a current root. Neither means every root.
    """
    graph_inputs = graph_inputs if isinstance(graph_inputs, dict) else {}
    by_key = {r.lower(): r for r in roots}

    requested = graph_inputs.get('domains')
    if requested is not None:
        if (not isinstance(requested, list) or len(requested) > MAX_REQUESTED_ROOTS
                or not all(isinstance(x, str) for x in requested)):
            raise PartialScopeError(
                400, f"graph_inputs.domains must be a list of at most "
                     f"{MAX_REQUESTED_ROOTS} domain names.")
        chosen = {by_key[x.strip().lower()] for x in requested if x.strip().lower() in by_key}
        if not chosen:
            raise PartialScopeError(400, "None of the requested domains is a target of this project.")
        return sorted(chosen)

    legacy = graph_inputs.get('domain')
    if legacy:
        if not isinstance(legacy, str) or legacy.strip().lower() not in by_key:
            raise PartialScopeError(400, f"{legacy!r} is not a target of this project.")
        return [by_key[legacy.strip().lower()]]

    return sorted(roots)


def validate_partial_overrides(overrides) -> dict:
    """The settings overrides, or PartialScopeError(400) for anything not allowed."""
    if overrides is None:
        return {}
    if not isinstance(overrides, dict):
        raise PartialScopeError(400, "settings_overrides must be an object.")
    unknown = sorted(k for k in overrides if k not in PARTIAL_OVERRIDE_KEYS)
    if unknown:
        raise PartialScopeError(
            400, f"settings_overrides may only set {sorted(PARTIAL_OVERRIDE_KEYS)}; "
                 f"refused: {unknown}")
    not_bool = sorted(k for k, v in overrides.items() if not isinstance(v, bool))
    if not_bool:
        raise PartialScopeError(400, f"settings_overrides must be true/false: {not_bool}")
    return dict(overrides)


_GROUP_MODES = ('exact', 'enumerate')


def _clean_host(value) -> str:
    host = str(value or '').strip().lower()
    return host if host and _BATCH_ROOT_CHARSET.match(host) and '..' not in host else ''


def _group_from_webapp(entry) -> dict | None:
    """One validated `scopeGroups` entry, or None. Dropped, never repaired: the
    field crosses a trust boundary, and a repaired name is a target nobody approved."""
    if not isinstance(entry, dict):
        return None
    root, org = _clean_host(entry.get('scanRoot')), _clean_host(entry.get('orgDomain'))
    mode = entry.get('mode')
    hosts = entry.get('exactHosts')
    if not root or not org or mode not in _GROUP_MODES or not isinstance(hosts, list):
        return None
    if not (root == org or root.endswith('.' + org)):
        return None
    exact = [_clean_host(h) for h in hosts]
    if any(not h or h == root or not h.endswith('.' + root) for h in exact):
        return None
    if mode == 'exact' and not exact and entry.get('includeRoot') is not True:
        return None
    entries = [str(e).strip().lower() for e in entry.get('entries') or [] if isinstance(e, str)]
    return {'scanRoot': root, 'orgDomain': org, 'mode': mode,
            'includeRoot': entry.get('includeRoot') is True, 'exactHosts': exact, 'entries': entries}


def _groups_from_legacy(project: dict) -> list[dict]:
    """The pre-scopeGroups shape, read only when the webapp sends no scopeGroups
    (an older webapp). The org is unknown here (no PSL in the orchestrator), so
    the scan root stands in for it, exactly as the old model named its Domain."""
    groups: list[dict] = []
    if project.get('domainBatchMode', False):
        for entry in project.get('domainBatchGroups') or []:
            if not isinstance(entry, dict):
                continue
            root = _clean_host(entry.get('rootDomain'))
            prefixes = [str(p) for p in entry.get('prefixes') or []]
            if not root:
                continue
            exact = [_clean_host(f"{p.rstrip('.')}.{root}") for p in prefixes if p not in ('*', '.') and '*' not in p]
            groups.append({'scanRoot': root, 'orgDomain': root,
                           'mode': 'enumerate' if '*' in prefixes else 'exact',
                           'includeRoot': '.' in prefixes, 'exactHosts': [h for h in exact if h], 'entries': []})
        return groups
    target = _clean_host(project.get('targetDomain'))
    if not target:
        return []
    subs = [str(s).strip().lower() for s in project.get('subdomainList') or []]
    exact = [_clean_host(f"{s.rstrip('.')}.{target}") for s in subs if s and s != '.' and '*' not in s]
    return [{'scanRoot': target, 'orgDomain': target, 'mode': 'exact' if exact else 'enumerate',
             'includeRoot': '.' in subs, 'exactHosts': [h for h in exact if h], 'entries': []}]


def scope_groups(project: dict) -> list[dict]:
    """The project's scope groups, as the webapp derived them (GET `scopeGroups`),
    each re-validated. IP mode has none. Only when the field is ABSENT (an older
    webapp) are the legacy fields read. Batch mode with nothing valid returns []:
    the caller must refuse, never read it as "nothing to check"."""
    if project.get('ipMode', False):
        return []
    if 'scopeGroups' in project:
        groups = project.get('scopeGroups')
        return [g for g in (_group_from_webapp(e) for e in (groups if isinstance(groups, list) else [])) if g]
    return _groups_from_legacy(project)


def admits_partial_host(groups: list[dict], host: str) -> bool:
    """§4.6, partial-recon user-typed hosts: strictly under an ENUMERATE scan root,
    or one of an EXACT group's hosts; a scan root itself only when it is a target."""
    host = _clean_host(host)
    if not host:
        return False
    for g in groups:
        if host == g['scanRoot']:
            if g['includeRoot']:
                return True
            continue
        if host in g['exactHosts']:
            return True
        if g['mode'] == 'enumerate' and host.endswith('.' + g['scanRoot']):
            return True
    return False


def _batch_hosts(project: dict) -> list[str]:
    """The listed hosts of a Domain-batch project, from its derived groups.

    A wildcard entry is stored as `*.<root>`: its marker is stripped. Anything
    with a `*` elsewhere, or outside the charset, is dropped rather than repaired.
    """
    groups = project.get('domainBatchGroups')
    hosts: list[str] = []
    for entry in groups if isinstance(groups, list) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get('hosts'), list):
            continue
        for raw in entry['hosts']:
            host = str(raw or '').strip().lower()
            if host.startswith('*.'):
                host = host[2:]
            if host and _BATCH_ROOT_CHARSET.match(host) and '..' not in host and host not in hosts:
                hosts.append(host)
    return hosts


def guardrail_targets(project: dict) -> list[str]:
    """Every name to hard-guardrail before starting a recon, whatever the mode.

    IP mode returns [] (IPs are not hard-blocked; see hard_guardrail.is_hard_blocked).
    Otherwise the union of two sources, so neither can hide a name:

      - the webapp's `scopeGroups`: every entry, exact host, scan root and org;
      - the stored fields: each batch host and group root (a host under a
        multi-label government name, `www.isa.org.jm`, groups under a root no
        rule names, `org.jm`), or the single target and its prefix hosts. A
        target the webapp refused (its scopeGroups is then empty) is still named.
    """
    if project.get('ipMode', False):
        return []
    names: list[str] = []

    def add(name: str) -> None:
        if name and '*' not in name and name not in names:
            names.append(name)

    for g in scope_groups(project) if 'scopeGroups' in project else []:
        for n in [*(e[2:] if e.startswith('*.') else e for e in g['entries']), *g['exactHosts'],
                  g['scanRoot'], g['orgDomain']]:
            add(n)
    if project.get('domainBatchMode', False):
        for n in _batch_hosts(project) + batch_guardrail_targets(project):
            add(n)
        return names
    target = str(project.get('targetDomain') or '').strip()
    if target:
        add(target)
        subs = project.get('subdomainList')
        for raw in subs if isinstance(subs, list) else []:
            prefix = str(raw or '').strip().lower().rstrip('.')
            if prefix:
                add(f'{prefix}.{target}')
    return names


# ---------------------------------------------------------------------------
# Partial recon: what the operator typed. The modal checks it, but the queue
# and the HTTP API accept any payload, so the orchestrator checks it again.
# ---------------------------------------------------------------------------

_IP_PREFIX_LIMITS = {4: (24, 32), 6: (120, 128)}


def _valid_user_ip(value: str) -> bool:
    """An address, or a CIDR no wider than the modal allows (/24 v4, /120 v6)."""
    import ipaddress
    try:
        if '/' in value:
            net = ipaddress.ip_network(value, strict=False)
            low, high = _IP_PREFIX_LIMITS[net.version]
            return low <= net.prefixlen <= high
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def _url_host(url: str) -> str:
    from urllib.parse import urlsplit
    try:
        return (urlsplit(url.strip()).hostname or '').lower()
    except ValueError:
        return ''


def filter_partial_user_input(project: dict, roots: list[str], user_inputs, user_targets):
    """The operator-typed inputs a partial run may use, and those it may not.

    Hosts (typed subdomains, URL hosts, attach targets) pass the §4.6 partial
    rule for the groups of the run's roots and the hard guardrail; in IP mode a
    URL host must be one of the project's own addresses. IPs and CIDRs get the
    modal's prefix limits. Returns (user_inputs, user_targets, refused).
    """
    from hard_guardrail import is_hard_blocked
    refused: list[str] = []
    wanted = {r.lower() for r in roots}
    groups = [g for g in scope_groups(project) if g['scanRoot'] in wanted]
    target_ips = {str(i).strip() for i in project.get('targetIps') or []}

    def host_ok(host: str) -> bool:
        if project.get('ipMode', False):
            return host in target_ips
        return admits_partial_host(groups, host) and not is_hard_blocked(host)[0]

    def keep_hosts(values, label):
        kept = []
        for v in values if isinstance(values, list) else []:
            if isinstance(v, str) and host_ok(v.strip().lower()):
                kept.append(v.strip().lower())
            else:
                refused.append(f'{label} {v!r}')
        return kept

    inputs = keep_hosts(user_inputs, 'subdomain')
    targets = None
    if isinstance(user_targets, dict):
        targets = dict(user_targets)
        if 'subdomains' in targets:
            targets['subdomains'] = keep_hosts(targets['subdomains'], 'subdomain')
        if 'urls' in targets:
            kept = []
            for u in targets['urls'] if isinstance(targets['urls'], list) else []:
                if isinstance(u, str) and host_ok(_url_host(u)):
                    kept.append(u.strip())
                else:
                    refused.append(f'url {u!r}')
            targets['urls'] = kept
        if 'ips' in targets:
            kept = []
            for ip in targets['ips'] if isinstance(targets['ips'], list) else []:
                if isinstance(ip, str) and _valid_user_ip(ip.strip()):
                    kept.append(ip.strip())
                else:
                    refused.append(f'ip {ip!r}')
            targets['ips'] = kept
        # ip_attach_to names a Subdomain, url_attach_to a BaseURL. In IP mode
        # both are graph nodes the container looks up, so only domain mode checks.
        for key, host_of in (('ip_attach_to', str), ('url_attach_to', _url_host)):
            value = targets.get(key)
            if value and not project.get('ipMode', False) and not (
                    isinstance(value, str) and host_ok(host_of(value).strip().lower())):
                refused.append(f'{key} {value!r}')
                targets[key] = None
        if 'ports' in targets:
            ports = targets['ports'] if isinstance(targets['ports'], list) else []
            targets['ports'] = [p for p in ports if isinstance(p, int) and not isinstance(p, bool) and 1 <= p <= 65535]
            refused.extend(f'port {p!r}' for p in ports if p not in targets['ports'])
    return inputs, targets, refused
