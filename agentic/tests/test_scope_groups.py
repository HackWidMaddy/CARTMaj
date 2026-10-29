"""
The agent's reading of a project's scope groups (scope_groups.py).

The webapp derives the groups and sends them as `scopeGroups`; the agent only
validates them and turns them into guardrail names, the authenticated-session
scope (§4.6) and a change signature. These pin the rules that keep a session's
headers off hosts the operator never put in scope.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scope_groups as sg  # noqa: E402


def _group(root, mode='enumerate', include_root=False, exact=(), org=None, entries=None):
    return {
        'scanRoot': root, 'orgDomain': org or root, 'mode': mode, 'includeRoot': include_root,
        'exactHosts': list(exact),
        'entries': list(entries) if entries is not None else [f'*.{root}'] if mode == 'enumerate' else list(exact),
        'notes': [],
    }


# The shape GET /api/projects/[id] returns for a batch of
# `*.example.org`, `example.org`, `www.acme.co.uk`, `*.api.example.com`.
WEBAPP_GROUPS = [
    _group('example.org', include_root=True, entries=['*.example.org', 'example.org']),
    _group('acme.co.uk', mode='exact', exact=['www.acme.co.uk']),
    _group('api.example.com', org='example.com', entries=['*.api.example.com']),
]


class TestParse:
    def test_a_well_formed_list_is_kept_in_order(self):
        groups = sg.parse_scope_groups(WEBAPP_GROUPS)
        assert [(g['scan_root'], g['org_domain'], g['mode'], g['include_root']) for g in groups] == [
            ('example.org', 'example.org', 'enumerate', True),
            ('acme.co.uk', 'acme.co.uk', 'exact', False),
            ('api.example.com', 'example.com', 'enumerate', False),
        ]

    def test_names_are_lower_cased(self):
        [g] = sg.parse_scope_groups([_group('Example.ORG', entries=['*.EXAMPLE.org'])])
        assert g['scan_root'] == 'example.org'

    def test_malformed_groups_are_dropped_never_repaired(self):
        bad = [
            _group('bad_label.com'),                                   # charset
            {**_group('a.test'), 'mode': 'all'},                      # unknown mode
            {**_group('b.test'), 'includeRoot': 'yes'},               # not a bool
            _group('c.test', mode='exact', exact=['www.other.test']),  # host outside its root
            _group('d.test', mode='exact', exact=['d.test']),          # the root is not an exact host
            _group('api.e.test', org='other.test'),                   # root outside its org
            _group('f.test', mode='exact'),                           # EXACT that names nothing
            _group('g.test', entries=['*.other.test']),               # entry outside the root
            {**_group('h.test'), 'exactHosts': 'www.h.test'},         # not a list
            'i.test',
        ]
        for raw in bad:
            assert sg.parse_scope_groups([raw]) == [], raw

    def test_a_repeated_scan_root_is_dropped(self):
        assert len(sg.parse_scope_groups([_group('a.test'), _group('a.test')])) == 1

    def test_the_dropped_count_reaches_the_caller(self):
        groups, source, dropped = sg.scope_groups_from_project(
            {'scopeGroups': [_group('a.test'), _group('bad_label.test')]})
        assert (len(groups), source, dropped) == (1, 'webapp', 1)

    def test_ip_mode_has_no_groups(self):
        assert sg.scope_groups_from_project({'ipMode': True, 'scopeGroups': WEBAPP_GROUPS}) == ([], 'ip', 0)


class TestLegacyFallback:
    def test_used_only_when_scope_groups_is_absent(self):
        _, source, _ = sg.scope_groups_from_project({'targetDomain': 'example.com', 'scopeGroups': []})
        assert source == 'webapp'
        _, source, _ = sg.scope_groups_from_project({'targetDomain': 'example.com'})
        assert source == 'legacy'

    def test_a_legacy_hosts_list_is_never_read_as_auth_scope(self):
        # `hosts` holds `*.x` tokens; only rootDomain + prefixes are read.
        groups, _, _ = sg.scope_groups_from_project({
            'domainBatchMode': True,
            'domainBatchGroups': [{'rootDomain': 'example.com', 'prefixes': ['www.'],
                                   'hosts': ['*.example.com', '*.evil.test', 'www.example.com']}],
        })
        assert sg.auth_scope_patterns(groups) == ['www.example.com']

    def test_a_legacy_wildcard_group_is_enumerated(self):
        groups = sg.legacy_scope_groups({'domainBatchMode': True, 'domainBatchGroups': [
            {'rootDomain': 'b.test', 'prefixes': ['*', '.'], 'hosts': ['*.b.test', 'b.test']}]})
        assert sg.auth_scope_patterns(groups) == ['*.b.test', 'b.test']

    def test_single_domain_reads_target_and_prefixes(self):
        groups = sg.legacy_scope_groups({'targetDomain': 'Example.com', 'subdomainList': ['www.', '.']})
        assert sg.auth_scope_patterns(groups) == ['www.example.com', 'example.com']
        groups = sg.legacy_scope_groups({'targetDomain': 'example.com', 'subdomainList': []})
        assert sg.auth_scope_patterns(groups) == ['*.example.com']


class TestAuthScope:
    def test_enumerate_gives_star_root_and_root_only_when_included(self):
        groups = sg.parse_scope_groups(WEBAPP_GROUPS)
        assert sg.auth_scope_patterns(groups) == [
            '*.example.org', 'example.org', 'www.acme.co.uk', '*.api.example.com']

    def test_exact_never_yields_star_root(self):
        groups = sg.parse_scope_groups([_group('example.com', mode='exact', include_root=True,
                                                exact=['www.example.com'],
                                                entries=['example.com', 'www.example.com'])])
        patterns = sg.auth_scope_patterns(groups)
        assert patterns == ['www.example.com', 'example.com']
        assert not any(p.startswith('*.') for p in patterns)

    def test_ip_mode_is_the_target_ips(self):
        assert sg.auth_scope_patterns([], ip_mode=True, target_ips=['192.0.2.10', '198.51.100.0/24']) == [
            '192.0.2.10', '198.51.100.0/24']


class TestExplicitScopeNarrows:
    """D-22: an auth profile's explicit scope is intersected with the project's."""

    def test_a_wide_explicit_wildcard_on_an_exact_project_leaves_the_listed_host(self):
        assert sg.intersect_explicit_scope(['*.example.com'], ['www.example.com']) == ['www.example.com']

    def test_an_explicit_wildcard_survives_under_an_enumerated_root(self):
        assert sg.intersect_explicit_scope(['*.a.example.com'], ['*.example.com']) == ['*.a.example.com']

    def test_an_explicit_wildcard_wider_than_the_root_narrows_to_the_root(self):
        assert sg.intersect_explicit_scope(['*.example.com'], ['*.api.example.com']) == ['*.api.example.com']

    def test_an_explicit_host_survives_only_if_the_project_admits_it(self):
        patterns = ['*.example.com', 'www.acme.test']
        assert sg.intersect_explicit_scope(['app.example.com', 'www.acme.test'], patterns) == [
            'app.example.com', 'www.acme.test']
        assert sg.intersect_explicit_scope(['evil.test', 'shop.acme.test'], patterns) == []

    def test_a_root_outside_the_scope_is_not_admitted_by_its_wildcard(self):
        # `*.x` is strict subdomains: the apex needs Root on.
        assert sg.intersect_explicit_scope(['example.com'], ['*.example.com']) == []
        assert sg.intersect_explicit_scope(['*.example.com'], ['example.com']) == []

    def test_cidrs_intersect_by_containment(self):
        assert sg.intersect_explicit_scope(['10.0.0.0/24', '10.0.0.5', '10.9.0.0/16'], ['10.0.0.0/16']) == [
            '10.0.0.0/24', '10.0.0.5']
        assert sg.intersect_explicit_scope(['10.0.0.0/8'], ['10.0.0.5']) == ['10.0.0.5']

    def test_a_malformed_explicit_entry_admits_nothing(self):
        assert sg.intersect_explicit_scope(['*.', 'bad host', '*'], ['*.example.com']) == []


class TestNamesAndSignature:
    def test_hard_names_are_entries_then_hosts_roots_and_orgs(self):
        groups = sg.parse_scope_groups(WEBAPP_GROUPS)
        assert sg.guardrail_names(groups) == [
            'example.org', 'www.acme.co.uk', 'api.example.com', 'acme.co.uk', 'example.com']

    def test_soft_names_are_orgs_and_roots(self):
        groups = sg.parse_scope_groups(WEBAPP_GROUPS)
        assert sg.soft_guardrail_names(groups) == ['example.org', 'acme.co.uk', 'example.com', 'api.example.com']

    def test_a_reorder_or_a_seed_under_an_enumerated_root_is_the_same_scope(self):
        a = sg.parse_scope_groups(WEBAPP_GROUPS)
        b = sg.parse_scope_groups(list(reversed(WEBAPP_GROUPS[:2])) + [
            _group('api.example.com', org='example.com', exact=['v1.api.example.com'],
                   entries=['*.api.example.com', 'v1.api.example.com'])])
        assert sg.scope_signature(a) == sg.scope_signature(b)

    def test_one_host_to_its_whole_domain_is_a_change(self):
        exact = sg.parse_scope_groups([_group('example.com', mode='exact', exact=['www.example.com'])])
        whole = sg.parse_scope_groups([_group('example.com')])
        assert sg.scope_signature(exact) != sg.scope_signature(whole)

    def test_ip_signature_follows_the_ips(self):
        assert sg.scope_signature([], True, ['192.0.2.2', '192.0.2.1']) == sg.scope_signature([], True, ['192.0.2.1', '192.0.2.2'])
        assert sg.scope_signature([], True, ['192.0.2.1']) != sg.scope_signature([], True, ['192.0.2.3'])


class TestScopeText:
    def test_lists_enumerated_roots_and_exact_hosts(self):
        text = sg.compact_scope_text(sg.parse_scope_groups(WEBAPP_GROUPS))
        assert '- *.example.org (any host under it, and example.org itself)' in text
        assert '- only www.acme.co.uk' in text
        assert '- *.api.example.com (any host under it; not api.example.com itself)' in text

    def test_exact_hosts_are_capped(self):
        hosts = [f'h{i}.example.com' for i in range(40)]
        text = sg.compact_scope_text(sg.parse_scope_groups([_group('example.com', mode='exact', exact=hosts)]))
        assert '(+25 more)' in text
        assert 'h39.example.com' not in text

    def test_groups_are_capped(self):
        groups = sg.parse_scope_groups([_group(f'd{i}.test') for i in range(35)])
        assert '(+5 more scope groups)' in sg.compact_scope_text(groups)

    def test_no_groups_no_text(self):
        assert sg.compact_scope_text([]) is None
