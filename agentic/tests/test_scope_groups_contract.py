"""The agent reads the webapp's scopeGroups as recon and the orchestrator do
(the shared fixture tests/fixtures/scope_groups_contract.json)."""
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from scope_groups import scope_groups_from_project  # noqa: E402

_FIXTURE = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'scope_groups_contract.json'
_CASES = json.loads(_FIXTURE.read_text())['cases'] if _FIXTURE.exists() else []


@pytest.mark.skipif(not _CASES, reason='contract fixture not mounted')
@pytest.mark.parametrize('case', _CASES, ids=[c['name'] for c in _CASES])
def test_the_agent_reads_the_webapps_groups(case):
    groups, source, dropped = scope_groups_from_project(dict(case['project'], scopeGroups=case['scopeGroups']))
    assert (source, dropped) == ('webapp', 0)
    assert [{'scanRoot': g['scan_root'], 'orgDomain': g['org_domain'], 'mode': g['mode'],
             'includeRoot': g['include_root'], 'exactHosts': g['exact_hosts']} for g in groups] == case['expected']
