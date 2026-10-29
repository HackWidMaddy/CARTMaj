"""
Partial recon reads the scope groups (PAR-01), filters what the operator typed
in the container (PAR-10) and refuses a graph built under the older scope model
(PAR-07, the backstop of the webapp's own refusal).
"""
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import mock

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from recon.partial_recon_modules.helpers import (  # noqa: E402
    admits_partial_host, allowed_hosts_for, filter_partial_user_input, include_root_for,
    org_for_root, partial_domain_groups, settings_project_roots, settings_scope_groups,
)


def _g(root, mode='exact', include_root=False, exact=(), org=None):
    return {'scanRoot': root, 'orgDomain': org or root, 'mode': mode,
            'includeRoot': include_root, 'exactHosts': list(exact)}


SINGLE_EXACT = {'IP_MODE': False, 'DOMAIN_BATCH_MODE': False, 'TARGET_DOMAIN': 'example.com',
                'SUBDOMAIN_LIST': ['www.'], 'SCOPE_GROUPS': [_g('example.com', exact=['www.example.com'])]}
BATCH = {'IP_MODE': False, 'DOMAIN_BATCH_MODE': True, 'SCOPE_GROUPS': [
    _g('api.example.com', 'enumerate', org='example.com'),
    _g('example.com', exact=['www.example.com']),
    _g('acme.co.uk', 'enumerate', include_root=True),
]}


class TestGroupsFromScopeGroups:
    def test_roots_come_from_the_scope_groups_in_order(self):
        assert settings_project_roots(BATCH, 'p1') == ['api.example.com', 'example.com', 'acme.co.uk']
        assert settings_project_roots(SINGLE_EXACT, 'p1') == ['example.com']
        assert settings_project_roots({'IP_MODE': True}, 'p1') == ['ip-targets.p1']

    def test_a_single_domain_exact_group_is_narrowed_to_its_hosts(self):
        # Before, single-domain projects were never narrowed: a partial run on
        # a project listing only www scanned every Subdomain under the target.
        groups = partial_domain_groups(SINGLE_EXACT, ['example.com'])
        assert allowed_hosts_for('example.com', groups) == {'www.example.com'}
        assert include_root_for('example.com', groups) is False

    def test_an_enumerate_group_is_not_narrowed(self):
        groups = partial_domain_groups(BATCH, ['acme.co.uk'])
        assert allowed_hosts_for('acme.co.uk', groups) is None
        assert include_root_for('acme.co.uk', groups) is True

    def test_only_the_runs_roots_are_built(self):
        groups = partial_domain_groups(BATCH, ['example.com'])
        assert [g['rootDomain'] for g in groups] == ['example.com']
        assert groups[0]['prefixes'] == ['www.'] and groups[0]['batch'] is True

    def test_the_org_of_a_root(self):
        groups = partial_domain_groups(BATCH, ['api.example.com', 'acme.co.uk'])
        assert org_for_root('api.example.com', groups) == 'example.com'
        assert org_for_root('acme.co.uk', groups) == 'acme.co.uk'

    def test_settings_without_scope_groups_derive_them_like_the_loader(self):
        legacy = {'IP_MODE': False, 'DOMAIN_BATCH_MODE': True,
                  'DOMAIN_BATCH_GROUPS': [{'rootDomain': 'alpha.test', 'prefixes': ['*', '.']}]}
        assert settings_scope_groups(legacy) == [{
            'scanRoot': 'alpha.test', 'orgDomain': 'alpha.test', 'mode': 'enumerate',
            'includeRoot': True, 'exactHosts': []}]
        single = {'IP_MODE': False, 'TARGET_DOMAIN': 'Example.com', 'SUBDOMAIN_LIST': ['www.']}
        assert settings_scope_groups(single)[0]['exactHosts'] == ['www.example.com']


class TestPartialRule:
    """§4.6, the partial-recon typed-host rule; same cases as the orchestrator's."""

    def test_the_rule_per_group(self):
        groups = partial_domain_groups(BATCH, ['api.example.com', 'example.com', 'acme.co.uk'])
        assert admits_partial_host(groups, 'x.v1.api.example.com')
        assert not admits_partial_host(groups, 'api.example.com')      # root off
        assert admits_partial_host(groups, 'www.example.com')
        assert not admits_partial_host(groups, 'mail.example.com')     # not listed
        assert admits_partial_host(groups, 'acme.co.uk')               # root on
        assert not admits_partial_host(groups, 'evil.co.uk')


class TestContainerFilter:
    def _cfg(self, settings, roots, **extra):
        cfg = {'domain_groups': partial_domain_groups(settings, roots), **extra}
        return cfg

    def test_out_of_scope_typed_input_is_dropped(self):
        cfg = self._cfg(BATCH, ['example.com', 'api.example.com'],
                        user_inputs=['www.example.com', 'mail.example.com'],
                        user_targets={'subdomains': ['v2.api.example.com', 'evil.test'],
                                      'urls': ['https://www.example.com/a', 'https://cdn.example.com/b'],
                                      'ips': ['192.0.2.1', '0.0.0.0/0', '10.0.0.0/8'],
                                      'ip_attach_to': 'mail.example.com',
                                      'url_attach_to': 'https://www.example.com'})
        refused = filter_partial_user_input(cfg, BATCH)
        assert cfg['user_inputs'] == ['www.example.com']
        t = cfg['user_targets']
        assert t['subdomains'] == ['v2.api.example.com']
        assert t['urls'] == ['https://www.example.com/a']
        assert t['ips'] == ['192.0.2.1']
        assert t['ip_attach_to'] is None
        assert t['url_attach_to'] == 'https://www.example.com'
        assert len(refused) == 6

    def test_ip_mode_url_hosts_must_be_the_projects_addresses(self):
        settings = {'IP_MODE': True, 'TARGET_IPS': ['192.0.2.10']}
        cfg = self._cfg(settings, ['ip-targets.p1'],
                        user_targets={'urls': ['http://192.0.2.10:8080/', 'http://192.0.2.99/']})
        filter_partial_user_input(cfg, settings)
        assert cfg['user_targets']['urls'] == ['http://192.0.2.10:8080/']

    def test_a_non_dict_targets_value_becomes_empty(self):
        cfg = self._cfg(BATCH, ['example.com'], user_targets=['https://evil.test'])
        filter_partial_user_input(cfg, BATCH)
        assert cfg['user_targets'] == {}


@pytest.fixture
def pr(monkeypatch):
    import recon.partial_recon as module
    monkeypatch.setenv('USER_ID', 'u1')
    monkeypatch.setenv('PROJECT_ID', 'p1')
    monkeypatch.setattr('recon.graph_db_preflight.require_graph_db', lambda *_: None)
    monkeypatch.setattr(module, '_cleanup_orphan_user_inputs', lambda *_: 0)
    monkeypatch.setattr(module, '_apply_node_filters', lambda started_at: None)
    return module


def _run_main(pr, monkeypatch, config, settings):
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(config, f)
    monkeypatch.setenv('PARTIAL_RECON_CONFIG', f.name)
    monkeypatch.setattr(pr, 'get_settings', lambda: dict(settings))
    dispatched = []
    monkeypatch.setattr(pr, '_dispatch', lambda tool_id, cfg: dispatched.append(dict(cfg)))
    try:
        pr.main()
        code = 0
    except SystemExit as e:
        code = e.code
    finally:
        os.unlink(f.name)
    return code, dispatched


class TestTypedOnlyRun:
    def test_nothing_typed_in_scope_and_no_graph_targets_refuses_the_run(self, pr, monkeypatch, capsys):
        monkeypatch.setattr(pr, '_legacy_graph_refusal', lambda *a: None)
        code, dispatched = _run_main(pr, monkeypatch, {
            'tool_id': 'Katana', 'domains': ['example.com'], 'include_graph_targets': False,
            'user_targets': {'urls': ['https://evil.test/']}}, BATCH)
        assert code == 1 and dispatched == []
        assert 'No typed target is in this project' in capsys.readouterr().out

    def test_graph_targets_keep_the_run_going(self, pr, monkeypatch):
        monkeypatch.setattr(pr, '_legacy_graph_refusal', lambda *a: None)
        code, dispatched = _run_main(pr, monkeypatch, {
            'tool_id': 'Katana', 'domains': ['example.com'], 'include_graph_targets': True,
            'user_targets': {'urls': ['https://evil.test/']}}, BATCH)
        assert code == 0
        assert dispatched[0]['user_targets']['urls'] == []


class _Client:
    def __init__(self, connected=True, legacy=(), raises=None):
        self.connected, self.legacy, self.raises, self.calls = connected, list(legacy), raises, []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def verify_connection(self):
        return self.connected

    def legacy_domain_nodes(self, uid, pid, expected, related):
        if self.raises:
            raise self.raises
        self.calls.append((uid, pid, expected, related))
        return self.legacy


class TestOldModelBackstop:
    def _check(self, pr, client, settings=BATCH):
        fake = mock.MagicMock()
        fake.Neo4jClient = lambda: client
        with mock.patch.dict(sys.modules, {'graph_db': fake}):
            return pr._legacy_graph_refusal(settings, 'u1', 'p1')

    def test_a_current_graph_passes_and_the_check_names_the_orgs(self, pr):
        # The graph names a Domain after the org (release D): a Domain named
        # after a deeper scan root (api.example.com) is the older model.
        client = _Client()
        assert self._check(pr, client) is None
        uid, pid, expected, related = client.calls[0]
        assert (uid, pid) == ('u1', 'p1')
        assert expected == ['acme.co.uk', 'example.com']
        assert related == ['acme.co.uk', 'api.example.com', 'example.com']

    def test_a_legacy_domain_refuses_the_run(self, pr):
        reason = self._check(pr, _Client(legacy=['co.uk']))
        assert 'co.uk' in reason and 'run a full recon first' in reason

    def test_an_unreachable_graph_fails_closed(self, pr):
        assert 'unreachable' in self._check(pr, _Client(connected=False))

    def test_a_failing_query_fails_closed(self, pr):
        assert 'failed' in self._check(pr, _Client(raises=RuntimeError('boom')))

    def test_ip_mode_is_not_checked(self, pr):
        client = _Client(connected=False)
        assert self._check(pr, client, {'IP_MODE': True}) is None

    def test_main_refuses_before_any_tool_runs(self, pr, monkeypatch, capsys):
        monkeypatch.setattr(pr, '_legacy_graph_refusal', lambda *a: 'legacy graph (co.uk)')
        code, dispatched = _run_main(pr, monkeypatch, {
            'tool_id': 'Katana', 'domains': ['example.com']}, BATCH)
        assert code == 1 and dispatched == []
        assert 'Refusing to scan: legacy graph (co.uk)' in capsys.readouterr().out
