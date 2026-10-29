"""
Domain batch: one group's scope rules, shared by the full pipeline and partial recon.

Kept free of import side effects on purpose. recon/main.py loads the project's
settings from the webapp at import time, so a partial-recon module that imported
these rules from there would trigger that load (and its network call) just to
read a prefix list. main.py re-imports every name below, so `from recon.main
import parse_target` keeps working.
"""
import re

# A subdomain prefix must be a hostname label (or dot-joined labels). The
# webapp validates this, but SUBDOMAIN_LIST crosses back in from the API with
# only a whitespace strip, so parse_target re-checks rather than trusting it.
_PREFIX_CHARSET = re.compile(r'^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$')


def group_discovery_enabled(settings: dict, batch_groups: list,
                            target_info: dict) -> bool:
    """May THIS target run subdomain enumeration?

    The settings toggle is a run-wide scalar, so on its own it can only say
    whether enumeration is permitted at all. In a Domain batch the answer is per
    GROUP: a group enumerates only when the operator wrote a wildcard for it, and
    every other group scans exactly the hostnames it was given - the contract the
    run-wide force-off in project_settings used to enforce by itself.

    Split out of run_domain_group so it can be tested as the thing the pipeline
    actually calls, rather than re-stated in a test that would still pass if the
    gate were deleted.
    """
    if not settings.get('SUBDOMAIN_DISCOVERY_ENABLED', True):
        return False
    if not batch_groups:
        return True              # single-domain: the toggle is the whole answer
    if 'mode' in target_info:
        return target_info['mode'] == 'enumerate'
    return bool(target_info.get('wildcard_mode', False))


def target_info_from_group(group: dict) -> dict:
    """One SCOPE_GROUPS entry as the target info the pipeline runs on.

    Carries the group's own fields plus the keys parse_target returns, so a
    reader of either shape works. Unlike parse_target, the mode is the group's
    and not inferred from the prefixes: an EXACT group listing only its root is
    still filtered, never an enumeration.
    """
    root = group['scanRoot']
    exact = list(group.get('exactHosts') or [])
    include_root = bool(group.get('includeRoot'))
    enumerate_ = group['mode'] == 'enumerate'
    return {
        "scan_root": root,
        "org_domain": group.get('orgDomain') or root,
        "mode": group['mode'],
        "include_root": include_root,
        "exact_hosts": exact,
        "target": root,
        "root_domain": root,
        "filtered_mode": not enumerate_,
        "subdomain_list": (['*'] if enumerate_ else []) + (['.'] if include_root else [])
                          + [f"{h[:-len(root) - 1]}." for h in exact],
        "full_subdomains": ([root] if include_root else []) + exact,
        "include_root_domain": include_root,
        "wildcard_mode": enumerate_,
    }


def parse_target(target: str, subdomain_list: list = None) -> dict:
    """
    Parse target domain and determine scan mode based on SUBDOMAIN_LIST.

    Args:
        target: Root domain (e.g., "example.com", "vulnweb.com")
        subdomain_list: List of subdomain prefixes to filter (e.g., ["testphp.", "www."])
                       Empty list = full discovery mode (scan all subdomains)
                       Special prefix "." = include root domain directly (no subdomain)
                       Special prefix "*" = enumerate this domain (full discovery)

    Returns:
        Dictionary with:
        - target: original target (root domain)
        - root_domain: the root domain (same as target)
        - filtered_mode: True if real subdomain prefixes are set AND no wildcard
        - subdomain_list: list of subdomain prefixes to scan
        - full_subdomains: list of full subdomain names (prefix + root domain)
        - include_root_domain: True if "." is in subdomain_list (scan root domain directly)
        - wildcard_mode: True if "*" is in subdomain_list (enumerate the domain)

    Neither sentinel is a hostname: "*" never reaches full_subdomains, and "."
    contributes the root itself rather than a prefixed name.
    """
    # TARGET_DOMAIN is always the root domain (e.g., "vulnweb.com")
    root_domain = target

    # Parse subdomain list and determine scan mode
    subdomain_list = subdomain_list or []
    include_root_domain = False

    # Build full subdomain names from prefixes
    full_subdomains = []
    wildcard_mode = False
    for prefix in subdomain_list:
        # "*" means "enumerate this domain" — run the same full discovery a
        # single-domain project runs. Matched EXACTLY and before rstrip('.'):
        # toStoredPrefixes() appends a trailing dot, so an operator typing "*"
        # into the single-domain Subdomain Prefixes box produces "*.", and
        # treating that as the sentinel would turn a scope-NARROWING field into
        # a silent full-enumeration switch.
        if prefix == '*':
            wildcard_mode = True
            continue
        # Handle "." as special case meaning root domain itself
        clean_prefix = prefix.rstrip('.')
        # Anything that is not a hostname label is DROPPED, never repaired.
        # SUBDOMAIN_LIST gets no charset check anywhere server-side (see
        # fetch_project_settings, which only strips whitespace), so a row edited
        # through the API or the database can put arbitrary text here — and
        # "*." is the ordinary near-miss: it is not the "*" sentinel, so without
        # this it would build the literal hostname "*.example.com" and carry a
        # metacharacter into DNS, tool arguments, filenames and the graph.
        if clean_prefix and not _PREFIX_CHARSET.match(clean_prefix):
            print(f"[!][Pipeline] Ignoring unusable subdomain prefix: {prefix!r}")
            continue
        if clean_prefix == "" or prefix == ".":
            # "." means include root domain directly (e.g., vulnweb.com)
            include_root_domain = True
            # Add root domain to the list
            if root_domain not in full_subdomains:
                full_subdomains.append(root_domain)
        else:
            # Normal subdomain prefix (e.g., "testphp." -> testphp.vulnweb.com)
            full_subdomain = f"{clean_prefix}.{root_domain}"
            if full_subdomain not in full_subdomains:
                full_subdomains.append(full_subdomain)

    # Filtered mode only when real subdomain prefixes SURVIVED (not just "."),
    # counted from what we actually built rather than from the raw input: a
    # prefix dropped above as unusable must not still switch the pipeline into
    # filtered mode, or the run would scan an empty list and report success.
    # "." alone means "include root domain" — it should NOT skip discovery.
    real_prefix_count = len([h for h in full_subdomains if h != root_domain])
    # A wildcard wins over explicit siblings: the group enumerates, and those
    # siblings are seeded into the result so nothing the operator listed is lost.
    filtered_mode = real_prefix_count > 0 and not wildcard_mode

    return {
        "target": target,
        "root_domain": root_domain,
        "filtered_mode": filtered_mode,
        "subdomain_list": subdomain_list,
        "full_subdomains": full_subdomains,
        "include_root_domain": include_root_domain,
        "wildcard_mode": wildcard_mode
    }


def settings_scope_groups(settings: dict) -> list:
    """SCOPE_GROUPS, or when it is empty, the groups the settings loader would
    derive from the legacy keys.

    The loader never leaves SCOPE_GROUPS empty while those keys hold a scope (an
    empty batch refuses the run), so this changes nothing for a loaded project;
    it covers a dict built by hand from DEFAULT_SETTINGS, whose SCOPE_GROUPS is [].
    """
    groups = [g for g in settings.get("SCOPE_GROUPS") or [] if isinstance(g, dict)]
    if groups:
        return groups
    if settings.get("IP_MODE"):
        return []
    from recon.project_settings import (
        _parse_domain_batch_groups, _scope_groups_from_legacy, _single_domain_group,
        _single_domain_target,
    )
    if settings.get("DOMAIN_BATCH_MODE"):
        return _scope_groups_from_legacy(
            _parse_domain_batch_groups(settings.get("DOMAIN_BATCH_GROUPS")))
    target = _single_domain_target(settings.get("TARGET_DOMAIN"))
    return [_single_domain_group(target, list(settings.get("SUBDOMAIN_LIST") or []))] if target else []
