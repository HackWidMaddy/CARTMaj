"""
The recon settings load reads the webapp's `scopeGroups` (REC-01) and fails
closed.

Recon is the process that enumerates, so it re-checks every group against its
own Public Suffix List and refuses a scope it cannot scan as approved, rather
than narrowing it quietly and exiting 0. The legacy `domainBatchGroups` path is
kept for a webapp that sends no `scopeGroups`, and must keep resolving exactly
as before.
"""
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from recon.helpers.batch_groups import (  # noqa: E402
    group_discovery_enabled, parse_target, target_info_from_group,
)
from recon.project_settings import (  # noqa: E402
    ScopeRefused, _parse_domain_batch_groups, _parse_scope_groups, fetch_project_settings,
)


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def _fetch(project):
    payload = {'userId': 'u', 'targetDomain': '', **project}
    with patch('requests.get', return_value=_FakeResponse(payload)):
        return fetch_project_settings('p', 'http://mocked')


def _group(root, mode='exact', include_root=False, exact=(), org=None):
    return {'scanRoot': root, 'orgDomain': org or root, 'mode': mode,
            'includeRoot': include_root, 'exactHosts': list(exact),
            'entries': [], 'notes': []}


def _batch(*groups, hosts=('x.example.com',)):
    return {'domainBatchMode': True, 'domainBatchHosts': list(hosts), 'scopeGroups': list(groups)}


class TestBatchReadsScopeGroups:
    def test_groups_arrive_in_order_with_their_mode(self):
        s = _fetch(_batch(
            _group('acme.co.uk', 'enumerate', include_root=True, exact=['www.acme.co.uk']),
            _group('example.com', exact=['a.example.com', 'b.example.com']),
        ))
        assert [g['scanRoot'] for g in s['SCOPE_GROUPS']] == ['acme.co.uk', 'example.com']
        assert s['SCOPE_GROUPS'][0] == {
            'scanRoot': 'acme.co.uk', 'orgDomain': 'acme.co.uk', 'mode': 'enumerate',
            'includeRoot': True, 'exactHosts': ['www.acme.co.uk']}

    def test_the_legacy_shape_is_derived_for_the_readers_that_have_not_moved(self):
        s = _fetch(_batch(
            _group('acme.co.uk', 'enumerate', include_root=True, exact=['www.acme.co.uk']),
            _group('example.com', exact=['a.example.com']),
        ))
        assert s['DOMAIN_BATCH_GROUPS'] == [
            {'rootDomain': 'acme.co.uk', 'prefixes': ['*', '.', 'www.']},
            {'rootDomain': 'example.com', 'prefixes': ['a.']},
        ]
        # and the legacy parser accepts what it is handed
        assert _parse_domain_batch_groups(s['DOMAIN_BATCH_GROUPS']) == s['DOMAIN_BATCH_GROUPS']

    def test_the_stored_legacy_groups_are_ignored_when_scope_groups_arrive(self):
        project = _batch(_group('example.com', exact=['a.example.com']))
        project['domainBatchGroups'] = [{'rootDomain': 'attacker.test', 'prefixes': ['*']}]
        s = _fetch(project)
        assert [g['rootDomain'] for g in s['DOMAIN_BATCH_GROUPS']] == ['example.com']

    def test_discovery_is_forced_off_when_no_group_enumerates(self):
        s = _fetch({**_batch(_group('example.com', exact=['a.example.com'])),
                    'subdomainDiscoveryEnabled': True})
        assert s['SUBDOMAIN_DISCOVERY_ENABLED'] is False
        s = _fetch({**_batch(_group('example.com', 'enumerate')), 'subdomainDiscoveryEnabled': True})
        assert s['SUBDOMAIN_DISCOVERY_ENABLED'] is True


class TestRevalidation:
    """Every name becomes a scan target and a filename part: dropped, never repaired."""

    def test_a_suffix_scan_root_is_refused_whatever_the_webapp_said(self):
        groups = _parse_scope_groups([
            _group('co.uk', 'enumerate'), _group('github.io', 'enumerate'),
            _group('example.com', 'enumerate'),
        ])
        assert [g['scanRoot'] for g in groups] == ['example.com']

    @pytest.mark.parametrize('root', ['../../etc', 'evil.com/x', 'evil.com;id', 'ev il.com',
                                      'a..b', '-a.example.com', 'x' * 64 + '.com', ''])
    def test_a_malformed_scan_root_is_dropped(self, root):
        assert _parse_scope_groups([_group(root, include_root=True)]) == []

    def test_an_unknown_mode_is_dropped(self):
        assert _parse_scope_groups([{**_group('example.com', include_root=True), 'mode': 'all'}]) == []

    def test_a_second_group_for_the_same_root_is_dropped(self):
        groups = _parse_scope_groups([
            _group('example.com', exact=['a.example.com']),
            _group('Example.COM', 'enumerate'),
        ])
        assert len(groups) == 1 and groups[0]['mode'] == 'exact'

    def test_an_exact_host_outside_its_root_is_dropped(self):
        groups = _parse_scope_groups([_group(
            'example.com', exact=['a.example.com', 'evil.test', 'example.com', 'b.example.com.evil.test'])])
        assert groups[0]['exactHosts'] == ['a.example.com']

    def test_an_exact_group_with_nothing_left_is_dropped(self):
        assert _parse_scope_groups([_group('example.com', exact=['evil.test'])]) == []

    def test_a_non_list_or_non_dict_yields_nothing(self):
        for raw in (None, {}, 'example.com', 7, ['example.com']):
            assert _parse_scope_groups(raw) == []

    def test_the_webapp_org_is_kept_when_the_lists_only_differ_in_version(self):
        # A newer list can make `shop.example.com` its own org; it still sits
        # under the scan root's registrable name, so the operator's preview wins.
        groups = _parse_scope_groups([_group('a.shop.example.com', 'enumerate', org='shop.example.com')])
        assert groups[0]['orgDomain'] == 'shop.example.com'

    def test_an_org_that_is_not_an_ancestor_is_replaced(self):
        groups = _parse_scope_groups([_group('a.example.com', 'enumerate', org='attacker.test')])
        assert groups[0]['orgDomain'] == 'example.com'

    def test_an_org_that_is_a_suffix_is_replaced(self):
        groups = _parse_scope_groups([_group('acme.co.uk', 'enumerate', org='co.uk')])
        assert groups[0]['orgDomain'] == 'acme.co.uk'


class TestFailsClosed:
    def test_a_batch_with_no_usable_group_refuses_the_run(self):
        with pytest.raises(ScopeRefused):
            _fetch(_batch(_group('co.uk', 'enumerate')))
        with pytest.raises(ScopeRefused):
            _fetch(_batch())

    def test_a_legacy_batch_with_no_usable_group_refuses_the_run(self):
        with pytest.raises(ScopeRefused):
            _fetch({'domainBatchMode': True, 'domainBatchGroups': [{'rootDomain': '../x', 'prefixes': ['.']}]})

    def test_a_single_domain_target_on_a_public_suffix_refuses_the_run(self):
        for target in ('co.uk', 'github.io', 'com'):
            with pytest.raises(ScopeRefused):
                _fetch({'targetDomain': target})

    def test_an_unusable_single_domain_target_refuses_the_run(self):
        for target in ('evil.com;id', '../etc', 'localhost'):
            with pytest.raises(ScopeRefused):
                _fetch({'targetDomain': target})

    def test_a_scope_group_that_does_not_match_the_target_refuses_the_run(self):
        with pytest.raises(ScopeRefused):
            _fetch({'targetDomain': 'example.com', 'scopeGroups': [_group('other.test', 'enumerate')]})

    def test_a_missing_suffix_list_refuses_the_run(self):
        # Before, a missing list demoted every wildcard to literal and the run
        # exited 0 having scanned less than the operator approved.
        with patch.dict(sys.modules, {'recon.helpers.public_suffix': None}):
            with pytest.raises(ScopeRefused):
                _fetch(_batch(_group('example.com', 'enumerate')))


class TestSingleDomain:
    def test_the_target_is_lower_cased_and_unmarked(self):
        assert _fetch({'targetDomain': ' Alpha.Example.COM. '})['TARGET_DOMAIN'] == 'alpha.example.com'
        assert _fetch({'targetDomain': '*.example.com'})['TARGET_DOMAIN'] == 'example.com'

    def test_the_webapp_group_is_used(self):
        s = _fetch({'targetDomain': 'example.com', 'subdomainList': ['www.'],
                    'scopeGroups': [_group('example.com', exact=['www.example.com'])]})
        assert s['SCOPE_GROUPS'] == [{'scanRoot': 'example.com', 'orgDomain': 'example.com',
                                      'mode': 'exact', 'includeRoot': False,
                                      'exactHosts': ['www.example.com']}]
        assert s['DOMAIN_BATCH_GROUPS'] == []

    def test_without_scope_groups_the_group_comes_from_the_prefixes(self):
        s = _fetch({'targetDomain': 'api.example.com', 'subdomainList': ['.', 'eu.']})
        assert s['SCOPE_GROUPS'] == [{'scanRoot': 'api.example.com', 'orgDomain': 'example.com',
                                      'mode': 'exact', 'includeRoot': True,
                                      'exactHosts': ['eu.api.example.com']}]
        s = _fetch({'targetDomain': 'example.com', 'subdomainList': []})
        assert s['SCOPE_GROUPS'][0]['mode'] == 'enumerate'

    def test_an_empty_target_has_no_group(self):
        assert _fetch({'targetDomain': ''})['SCOPE_GROUPS'] == []

    def test_ip_mode_has_no_group(self):
        s = _fetch({'ipMode': True, 'targetIps': ['192.0.2.1'], 'targetDomain': ''})
        assert s['SCOPE_GROUPS'] == []


class TestLegacyFallback:
    """A webapp that sends no `scopeGroups` keeps today's behaviour exactly."""

    def test_the_legacy_groups_resolve_as_before(self):
        raw = [{'rootDomain': 'example.com', 'prefixes': ['a', 'b'], 'hosts': []},
               {'rootDomain': 'co.uk', 'prefixes': ['*', 'www.acme.']}]
        s = _fetch({'domainBatchMode': True, 'domainBatchGroups': raw})
        assert s['DOMAIN_BATCH_GROUPS'] == _parse_domain_batch_groups(raw)
        # the suffix wildcard is demoted, not honoured
        assert s['DOMAIN_BATCH_GROUPS'][1] == {'rootDomain': 'co.uk', 'prefixes': ['www.acme.']}
        assert [(g['scanRoot'], g['mode'], g['exactHosts']) for g in s['SCOPE_GROUPS']] == [
            ('example.com', 'exact', ['a.example.com', 'b.example.com']),
            ('co.uk', 'exact', ['www.acme.co.uk']),
        ]


class TestTargetInfoFromGroup:
    def test_an_exact_group_listing_only_its_root_is_filtered(self):
        # parse_target infers "not filtered" from a '.'-only prefix list.
        info = target_info_from_group(_group('example.com', include_root=True))
        assert info['filtered_mode'] is True
        assert info['full_subdomains'] == ['example.com']
        assert parse_target('example.com', ['.'])['filtered_mode'] is False

    def test_it_matches_parse_target_wherever_the_mode_is_unambiguous(self):
        for group, prefixes in [
            (_group('example.com', 'enumerate', include_root=True, exact=['www.example.com']),
             ['*', '.', 'www.']),
            (_group('example.com', exact=['a.example.com', 'b.c.example.com']), ['a.', 'b.c.']),
        ]:
            info = target_info_from_group(group)
            legacy = parse_target('example.com', prefixes)
            for key in ('root_domain', 'filtered_mode', 'full_subdomains',
                        'include_root_domain', 'wildcard_mode', 'subdomain_list'):
                assert info[key] == legacy[key], key

    def test_discovery_follows_the_group_mode(self):
        on = {'SUBDOMAIN_DISCOVERY_ENABLED': True}
        batch = [{'rootDomain': 'example.com', 'prefixes': ['*']}]
        assert group_discovery_enabled(on, batch, target_info_from_group(_group('example.com', 'enumerate')))
        assert not group_discovery_enabled(
            on, batch, target_info_from_group(_group('example.com', include_root=True)))
