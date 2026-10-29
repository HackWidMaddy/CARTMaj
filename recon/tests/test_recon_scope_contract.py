"""
Release C (P5): what the full pipeline scans, and what its recon JSON says
about the scope (§4.10).

A `*`-only group never touches its scan root; an EXACT group never injects a
name it did not list; every recon file says which group produced it; the
merged batch file carries the project's scope, not one group's.
"""
import inspect
import json
import sys
from pathlib import Path
from unittest import mock

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import recon.main as main  # noqa: E402
from recon.helpers import output_paths as op  # noqa: E402
from recon.helpers.batch_groups import target_info_from_group  # noqa: E402
from recon.helpers.target_helpers import (  # noqa: E402
    injection_scope, merge_discovered_hostnames,
)


def _group(root, mode='enumerate', include_root=False, exact=(), org=None):
    return {'scanRoot': root, 'orgDomain': org or root, 'mode': mode,
            'includeRoot': include_root, 'exactHosts': list(exact)}


def _no_resolve(*a, **k):
    raise AssertionError('no DNS in this test')


class TestTheRootOnlyWithRoot:
    """REC-05: with Root off, the scan root is no target, even when discovery
    or its own resolution brought it back."""

    def _merge(self, include_root):
        info = target_info_from_group(_group('nw.test', include_root=include_root))
        discovered = {
            'subdomains': ['nw.test', 'a.nw.test'],
            'dns': {'domain': {'ips': {'ipv4': ['192.0.2.1']}, 'has_records': True},
                    'subdomains': {'nw.test': {'ips': {'ipv4': ['192.0.2.1']}},
                                   'a.nw.test': {'ips': {'ipv4': ['192.0.2.2']}}}},
        }
        return main.merge_group_hosts(discovered, info, 'nw.test', {}, dns_enabled=False,
                                      resolver=_no_resolve)

    def test_root_off_drops_the_root_and_its_records(self):
        merged = self._merge(include_root=False)
        assert merged['subdomains'] == ['a.nw.test']
        assert merged['dns']['domain'] == {}
        assert 'nw.test' not in merged['dns']['subdomains']
        assert merged['include_root'] is False

    def test_root_on_keeps_it(self):
        merged = self._merge(include_root=True)
        assert merged['subdomains'][0] == 'nw.test'
        assert merged['dns']['domain']['ips']['ipv4'] == ['192.0.2.1']


class TestScopeMetadata:
    def test_a_batch_group_states_its_scope(self):
        info = target_info_from_group(_group('api.example.com', org='example.com'))
        assert main._scope_metadata(info, 'api.example.com', info['filtered_mode']) == {
            'org_domain': 'example.com', 'scope_mode': 'enumerate', 'include_root_domain': False}

    def test_an_exact_group(self):
        info = target_info_from_group(_group('example.com', 'exact', True, ['www.example.com']))
        assert main._scope_metadata(info, 'example.com', True) == {
            'org_domain': 'example.com', 'scope_mode': 'exact', 'include_root_domain': True}

    def test_ip_mode_stamps_the_mock_root(self):
        src = inspect.getsource(main.run_ip_recon)
        for line in ('"org_domain": mock_domain', '"scope_mode": "exact"', '"include_root_domain": False'):
            assert line in src


class TestHostnameInjection:
    """REC-06: an EXACT group injects nothing it did not list; an ENUMERATE
    group injects strict subdomains, the root only with Root on."""

    def _recon(self, mode, include_root):
        return {'domain': 'nw.test', 'metadata': {'root_domain': 'nw.test', 'scope_mode': mode,
                                                  'include_root_domain': include_root},
                'dns': {'domain': {}, 'subdomains': {}}}

    def _inject(self, recon):
        with mock.patch('recon.helpers.target_helpers._resolves_to_routable', return_value=True):
            merge_discovered_hostnames(recon, ['nw.test', 'mail.nw.test', 'cdn.other.test'],
                                       source='tlsx', root_domain='nw.test', settings={})
        return sorted(recon['dns']['subdomains'])

    def test_exact_injects_nothing(self):
        recon = self._recon('exact', True)
        assert self._inject(recon) == []
        assert [e['domain'] for e in recon['discovered_external_domains']] == ['cdn.other.test']

    def test_enumerate_without_root(self):
        assert self._inject(self._recon('enumerate', False)) == ['mail.nw.test']

    def test_enumerate_with_root(self):
        assert self._inject(self._recon('enumerate', True)) == ['mail.nw.test', 'nw.test']

    def test_a_legacy_file_keeps_the_old_rule(self):
        recon = self._recon('enumerate', False)
        recon['metadata'] = {'root_domain': 'nw.test'}
        assert injection_scope(recon) is None
        assert self._inject(recon) == ['mail.nw.test', 'nw.test']


class TestMergedBatchFile:
    """REC-04: the canonical file of a batch carries the project's scope, and
    none of one group's scope."""

    SCOPE = [{'scan_root': 'a.test', 'org_domain': 'a.test', 'mode': 'exact', 'include_root': True,
              'exact_hosts': []},
             {'scan_root': 'api.b.test', 'org_domain': 'b.test', 'mode': 'enumerate',
              'include_root': False, 'exact_hosts': []}]

    def _write(self, tmp_path, root, org, mode):
        data = {'domain': root, 'scope_groups': self.SCOPE, 'all_project_roots': ['a.test', 'api.b.test'],
                'metadata': {'root_domain': root, 'org_domain': org, 'scope_mode': mode,
                             'include_root_domain': mode == 'exact', 'filtered_mode': mode == 'exact',
                             'wildcard_mode': mode == 'enumerate', 'subdomain_filter': []},
                'dns': {'domain': {}, 'subdomains': {}}}
        op.recon_output_file(tmp_path, 'p1', root).write_text(json.dumps(data))

    def test_project_wide_keys_are_assigned_and_group_keys_dropped(self, tmp_path):
        self._write(tmp_path, 'a.test', 'a.test', 'exact')
        self._write(tmp_path, 'api.b.test', 'b.test', 'enumerate')
        merged = json.loads(op.merge_batch_outputs(tmp_path, 'p1').read_text())
        assert merged['scope_groups'] == self.SCOPE            # not concatenated
        assert merged['all_project_roots'] == ['a.test', 'api.b.test']
        md = merged['metadata']
        assert md['scope_groups'] == self.SCOPE
        assert md['org_domains'] == ['a.test', 'b.test']
        for key in ('include_root_domain', 'scope_mode', 'org_domain', 'filtered_mode',
                    'wildcard_mode', 'subdomain_filter'):
            assert key not in md, key

    def test_a_run_without_discovery_keeps_its_roots_files(self, tmp_path):
        # REC-08: those files are the run's input; clearing them made it fail.
        self._write(tmp_path, 'a.test', 'a.test', 'exact')
        self._write(tmp_path, 'gone.test', 'gone.test', 'exact')
        assert op.clear_batch_outputs(tmp_path, 'p1', keep_roots=['a.test']) == 1
        assert [p.name for p in op.batch_output_files(tmp_path, 'p1')] == [
            op.recon_output_file(tmp_path, 'p1', 'a.test').name]


class TestRoeBeforeOwnership:
    def test_an_excluded_root_gets_no_txt_lookup(self, monkeypatch, capsys):
        monkeypatch.setattr(main, '_settings', {'ROE_ENABLED': True, 'ROE_EXCLUDED_HOSTS': ['nw.test']})
        monkeypatch.setattr(main, 'VERIFY_DOMAIN_OWNERSHIP', True)
        verify = mock.Mock()
        monkeypatch.setattr(main, 'verify_domain_ownership', verify)
        assert main.run_domain_group(_group('nw.test')) == 1
        verify.assert_not_called()
        assert 'ROE excluded' in capsys.readouterr().out
