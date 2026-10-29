"""
A project's scope as scope groups, as the agent reads it.

The webapp derives the groups (webapp/src/lib/scopeGroups.ts) and returns them
as `scopeGroups` from GET /api/projects/[id]; the agent never recomputes them and
carries no Public Suffix List (the webapp and recon own that). This module only
validates what arrives - it crosses a trust boundary - and turns it into the
sets the agent needs: guardrail names, the authenticated-session scope and a
signature that says "the scope changed".

A webapp older than the scope groups sends no `scopeGroups`; the legacy fields
are then read the way 7.1.0 wrote them. A legacy group's `hosts` list is never
read as an auth scope: it holds `*.x` tokens.

Stdlib only: the agent image carries no PSL package, and this is imported on
the guardrail path.
"""
from __future__ import annotations

import ipaddress
import re
from typing import Iterable, Optional

_HOST_CHARSET = re.compile(r'^[a-z0-9.-]+$')


def clean_host(value) -> str:
    """A lower-cased hostname that passes the charset, or '' (dropped, never repaired)."""
    h = str(value or '').strip().lower().rstrip('.')
    if not h or not _HOST_CHARSET.match(h) or '..' in h or h.startswith('.') or h.startswith('-'):
        return ''
    if len(h) > 253 or any(len(label) > 63 for label in h.split('.')):
        return ''
    return h


def _under(host: str, root: str) -> bool:
    return host.endswith(f'.{root}')


def parse_scope_groups(raw) -> list[dict]:
    """The webapp's `scopeGroups`, validated. A malformed group is DROPPED whole:
    a repaired group would be a scope the operator never approved."""
    groups: list[dict] = []
    roots: set[str] = set()
    for g in raw if isinstance(raw, list) else []:
        if not isinstance(g, dict):
            continue
        root = clean_host(g.get('scanRoot'))
        org = clean_host(g.get('orgDomain'))
        mode = g.get('mode')
        include_root = g.get('includeRoot')
        exact = g.get('exactHosts')
        if not root or not org or mode not in ('exact', 'enumerate') or not isinstance(include_root, bool):
            continue
        if not isinstance(exact, list) or root in roots:
            continue
        if root != org and not _under(root, org):
            continue
        hosts = [clean_host(h) for h in exact]
        if any(not h or h == root or not _under(h, root) for h in hosts):
            continue
        if mode == 'exact' and not include_root and not hosts:
            continue
        entries = g.get('entries', [])
        if not isinstance(entries, list):
            continue
        names = [clean_host(str(e).removeprefix('*.')) for e in entries]
        if any(not n or (n != root and not _under(n, root)) for n in names):
            continue
        roots.add(root)
        groups.append({
            'scan_root': root, 'org_domain': org, 'mode': mode,
            'include_root': include_root, 'exact_hosts': list(dict.fromkeys(hosts)),
            'entry_names': list(dict.fromkeys(names)),
        })
    return groups


def legacy_scope_groups(project: dict) -> list[dict]:
    """The groups of a project read from a webapp that sends no `scopeGroups`."""
    if project.get('domainBatchMode'):
        groups: list[dict] = []
        for g in project.get('domainBatchGroups') or []:
            if not isinstance(g, dict):
                continue
            root = clean_host(g.get('rootDomain'))
            prefixes = [p for p in (g.get('prefixes') or []) if isinstance(p, str)]
            if not root or any(x['scan_root'] == root for x in groups):
                continue
            hosts = [clean_host(f"{p.strip().rstrip('.')}.{root}") for p in prefixes if p.strip() not in ('', '.', '*')]
            groups.append({
                'scan_root': root, 'org_domain': root,
                'mode': 'enumerate' if '*' in prefixes else 'exact',
                'include_root': '.' in prefixes,
                'exact_hosts': [h for h in hosts if h], 'entry_names': [],
            })
        return [g for g in groups if g['mode'] == 'enumerate' or g['include_root'] or g['exact_hosts']]
    root = clean_host(str(project.get('targetDomain') or '').removeprefix('*.'))
    if not root:
        return []
    prefixes = [str(p).strip() for p in (project.get('subdomainList') or []) if str(p).strip()]
    hosts = [clean_host(f"{p.rstrip('.')}.{root}") for p in prefixes if p not in ('.', '*')]
    hosts = [h for h in hosts if h]
    return [{
        'scan_root': root, 'org_domain': root,
        'mode': 'exact' if hosts else 'enumerate',
        'include_root': '.' in prefixes,
        'exact_hosts': hosts, 'entry_names': [],
    }]


def scope_groups_from_project(project: dict) -> tuple[list[dict], str, int]:
    """(groups, source, dropped): source is 'webapp' when the project carried
    `scopeGroups`, 'legacy' otherwise, 'ip' in IP mode; dropped counts the
    webapp groups that failed validation, which a session start refuses."""
    if project.get('ipMode'):
        return [], 'ip', 0
    raw = project.get('scopeGroups')
    if isinstance(raw, list):
        groups = parse_scope_groups(raw)
        return groups, 'webapp', len(raw) - len(groups)
    return legacy_scope_groups(project), 'legacy', 0


def _dedupe(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(v for v in values if v))


def guardrail_names(groups: list[dict]) -> list[str]:
    """Hard-guardrail names, as the webapp's guardrailNames: every entry (marker
    stripped), exact host, scan root and org."""
    return _dedupe([*(n for g in groups for n in g.get('entry_names', ())),
                    *(h for g in groups for h in g['exact_hosts']),
                    *(g['scan_root'] for g in groups),
                    *(g['org_domain'] for g in groups)])


def soft_guardrail_names(groups: list[dict]) -> list[str]:
    """What the LLM guardrail judges: orgs and scan roots."""
    return _dedupe([n for g in groups for n in (g['org_domain'], g['scan_root'])])


def auth_scope_patterns(groups: list[dict], ip_mode: bool = False,
                        target_ips: Iterable[str] = ()) -> list[str]:
    """Where an authenticated session may go (§4.6): `*.<root>` (strict
    subdomains) for an ENUMERATE group, the listed hosts of an EXACT one, the
    scan root only when it is a target; the target IPs in IP mode."""
    if ip_mode:
        return _dedupe(str(ip).strip() for ip in target_ips or ())
    out: list[str] = []
    for g in groups:
        if g['mode'] == 'enumerate':
            out.append(f"*.{g['scan_root']}")
        else:
            out.extend(g['exact_hosts'])
        if g['include_root']:
            out.append(g['scan_root'])
    return _dedupe(out)


def _ip_net(value: str):
    """An IP or CIDR as a network, or None."""
    try:
        return ipaddress.ip_network(value, strict=False) if ('/' in value or _is_ip(value)) else None
    except ValueError:
        return None


def _is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def _entry(raw) -> str:
    """An explicit scope entry normalised: `*.<host>`, a host, an IP or a CIDR; '' if none."""
    e = str(raw or '').strip().lower().rstrip('.')
    if e.startswith('*.'):
        h = clean_host(e[2:])
        return f'*.{h}' if h else ''
    net = _ip_net(e)
    if net is not None:
        return e if _is_ip(e) else str(net)
    return clean_host(e)


def _meet(a: str, b: str) -> Optional[str]:
    """The intersection of two scope entries, when it is one entry. `*.x` is the
    strict subdomains of x, so `*.example.com` and `www.example.com` meet at the
    host, and `*.example.com` never admits `example.com` itself."""
    na, nb = _ip_net(a), _ip_net(b)
    if na is not None or nb is not None:
        if na is None or nb is None or na.version != nb.version:
            return None
        if na.subnet_of(nb):
            return a
        return b if nb.subnet_of(na) else None
    wa, wb = a.startswith('*.'), b.startswith('*.')
    ra, rb = (a[2:] if wa else a), (b[2:] if wb else b)
    if wa and wb:
        if ra == rb or _under(ra, rb):
            return a
        return b if _under(rb, ra) else None
    if wa:
        return b if _under(rb, ra) else None
    if wb:
        return a if _under(ra, rb) else None
    return a if a == b else None


def intersect_explicit_scope(explicit: Iterable[str], patterns: list[str]) -> list[str]:
    """An auth profile's explicit scope only NARROWS the project's (D-22): the
    hosts both admit. An explicit `*.a.example.com` survives under an enumerated
    `*.example.com`; an explicit `*.example.com` on a project that lists only
    `www.example.com` leaves `www.example.com`; an explicit host survives only if
    the project admits it. A malformed explicit entry admits nothing."""
    kept: list[str] = []
    for raw in explicit or ():
        e = _entry(raw)
        if not e:
            continue
        for p in patterns:
            q = _entry(p)
            m = _meet(e, q) if q else None
            if m:
                kept.append(m)
    return _dedupe(kept)


def scope_signature(groups: list[dict], ip_mode: bool = False,
                    target_ips: Iterable[str] = ()) -> str:
    """A canonical string that changes exactly when the scope does."""
    if ip_mode:
        return 'ip|' + ','.join(sorted(_dedupe(str(i).strip() for i in target_ips or ())))
    parts: set[str] = set()
    for g in groups:
        if g['mode'] == 'enumerate':
            parts.add(f"enum|{g['scan_root']}")
        else:
            parts.update(f'exact|{h}' for h in g['exact_hosts'])
        if g['include_root']:
            parts.add(f"root|{g['scan_root']}")
    return ';'.join(sorted(parts))


def compact_scope_text(groups: list[dict], max_hosts: int = 15, max_lines: int = 30) -> Optional[str]:
    """The scope as a few prompt lines, capped; None when there is nothing to show."""
    if not groups:
        return None
    lines: list[str] = []
    listed = 0
    for g in groups[:max_lines]:
        if g['mode'] == 'enumerate':
            lines.append(f"- *.{g['scan_root']} (any host under it"
                         + (f", and {g['scan_root']} itself)" if g['include_root'] else f"; not {g['scan_root']} itself)"))
        else:
            hosts = ([g['scan_root']] if g['include_root'] else []) + g['exact_hosts']
            shown = hosts[:max(0, max_hosts - listed)]
            listed += len(shown)
            if not shown:
                lines.append(f"- {len(hosts)} listed hosts under {g['scan_root']}")
                continue
            more = f" (+{len(hosts) - len(shown)} more)" if len(shown) < len(hosts) else ''
            lines.append(f"- only {', '.join(shown)}{more}")
    if len(groups) > max_lines:
        lines.append(f"- (+{len(groups) - max_lines} more scope groups)")
    return '\n'.join(lines)
