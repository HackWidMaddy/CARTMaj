"""
Partial recon over the org graph model (release D, PAR-02..05).

A Domain node is the org: the builders read hosts under the selected groups'
orgs and keep a host only when the LONGEST scan root of the whole project it
sits under is one of the run's roots and that root's group admits it (§4.6).
Writers attach to the org.
"""
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from recon.partial_recon_modules import graph_builders as gb  # noqa: E402
from recon.partial_recon_modules import helpers as h  # noqa: E402

PROJECT = [
    {'scanRoot': 'api.example.com', 'orgDomain': 'example.com', 'mode': 'enumerate',
     'includeRoot': False, 'exactHosts': []},
    {'scanRoot': 'example.com', 'orgDomain': 'example.com', 'mode': 'exact',
     'includeRoot': False, 'exactHosts': ['www.example.com']},
    {'scanRoot': 'b.test', 'orgDomain': 'b.test', 'mode': 'enumerate',
     'includeRoot': True, 'exactHosts': []},
]
SETTINGS = {'IP_MODE': False, 'DOMAIN_BATCH_MODE': True, 'SCOPE_GROUPS': PROJECT}


@pytest.fixture(autouse=True)
def _project_scope():
    h.set_project_scope(PROJECT)
    yield
    h.set_project_scope([])


def _scope(roots):
    return gb._GraphScope(roots, h.partial_domain_groups(SETTINGS, roots), False)


class TestGraphScope:
    def test_hosts_are_read_under_the_org(self):
        assert _scope(['api.example.com']).orgs == ['example.com']
        assert _scope(['api.example.com', 'example.com', 'b.test']).orgs == ['example.com', 'b.test']

    def test_a_host_belongs_to_the_longest_scan_root(self):
        s = _scope(['api.example.com'])
        assert s.root_of('x.api.example.com') == 'api.example.com'
        # Under the org, but its longest scan root is example.com: not this run's.
        assert s.root_of('www.example.com') is None
        assert s.root_of('mail.example.com') is None

    def test_a_root_without_include_root_is_no_target(self):
        s = _scope(['api.example.com', 'b.test'])
        assert s.root_of('api.example.com') is None
        assert s.root_of('api.example.com', apex=False) == 'api.example.com'
        assert s.root_of('b.test') == 'b.test'

    def test_an_exact_group_keeps_its_list_only(self):
        s = _scope(['example.com'])
        assert s.root_of('www.example.com') == 'example.com'
        assert s.root_of('mail.example.com') is None
        # x.api.example.com belongs to api.example.com, a deeper root, not to this group.
        assert s.root_of('x.api.example.com') is None

    def test_a_removed_scan_roots_hosts_are_never_offered(self):
        # old.example.com was a scan root once; its hosts stay in the graph
        # under the org until the next full recon.
        s = _scope(['api.example.com'])
        assert s.root_of('x.old.example.com') is None

    def test_without_groups_the_old_rule_holds(self):
        s = gb._GraphScope(['ip-targets.p1'], [], False)
        assert s.orgs == ['ip-targets.p1']
        assert s.keeps('192-0-2-1', 'ip-targets.p1')


class _Session:
    def __init__(self, rows):
        self.rows, self.calls = rows, []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def run(self, cypher, **params):
        self.calls.append((cypher, params))
        if 'HAS_SUBDOMAIN' in cypher:
            return [{'root': d, 'sub': s} for d, s in self.rows if d in params['domains']]
        return []


class TestBuilders:
    def test_graph_target_hosts_reads_the_org_and_filters_by_scan_root(self, monkeypatch):
        session = _Session([('example.com', 'x.api.example.com'), ('example.com', 'www.example.com'),
                            ('example.com', 'api.example.com'), ('b.test', 'b.test')])
        client = type('C', (), {'__enter__': lambda s: s, '__exit__': lambda s, *a: False,
                                'verify_connection': lambda s: True,
                                'driver': type('D', (), {'session': lambda s: session})()})()
        monkeypatch.setitem(sys.modules, 'graph_db', type('M', (), {'Neo4jClient': lambda *a: client}))
        hosts = gb.graph_target_hosts('u', 'p', ['api.example.com'],
                                      h.partial_domain_groups(SETTINGS, ['api.example.com']))
        assert hosts == ['x.api.example.com']
        cypher, params = session.calls[0]
        assert 'toLower(d.name) IN $domains' in cypher and params['domains'] == ['example.com']

    def test_an_included_root_is_a_target_an_excluded_one_is_not(self):
        groups = h.partial_domain_groups(SETTINGS, ['api.example.com', 'b.test'])
        assert gb.graph_target_hosts('u', 'p', ['api.example.com', 'b.test'], groups,
                                     include_graph=False) == ['b.test']

    def test_apex_addresses_come_from_the_apex_subdomain(self):
        session = _Session([])
        rows = gb._apex_rows(session, 'u', 'p', ['B.test'], 'RETURN {ROOT}, i.address AS address')
        cypher, params = session.calls[0]
        assert 'MATCH (s:Subdomain' in cypher and 'toLower(s.name) IN $apex_roots' in cypher
        assert ':Domain' not in cypher and params['apex_roots'] == ['b.test']
        assert rows == []


class TestOrgAttach:
    def test_a_scan_root_attaches_to_its_org(self):
        assert h.attach_org('api.example.com') == 'example.com'
        assert h.attach_org('b.test') == 'b.test'
        assert h.attach_org('unknown.test') == 'unknown.test'
        assert h.attach_org(None) is None


class TestEnumerationByMode:
    def test_only_an_enumerate_group_enumerates(self):
        from recon.partial_recon_modules.subdomain_discovery import _enumerable_roots
        single_exact = {'IP_MODE': False, 'DOMAIN_BATCH_MODE': False, 'SCOPE_GROUPS': [
            {'scanRoot': 'example.com', 'orgDomain': 'example.com', 'mode': 'exact',
             'includeRoot': True, 'exactHosts': ['www.example.com']}]}
        cfg = {'domain_groups': h.partial_domain_groups(single_exact, ['example.com']), 'batch_mode': False}
        # Single-domain EXACT used to enumerate regardless (S-18).
        assert _enumerable_roots(['example.com'], cfg, {'SUBDOMAIN_DISCOVERY_ENABLED': True}) == []
        cfg = {'domain_groups': h.partial_domain_groups(SETTINGS, ['api.example.com', 'example.com']),
               'batch_mode': True}
        assert _enumerable_roots(['api.example.com', 'example.com'], cfg,
                                 {'SUBDOMAIN_DISCOVERY_ENABLED': True}) == ['api.example.com']
