"""The orchestrator reads the webapp's scopeGroups as recon and the agent do
(the shared fixture tests/fixtures/scope_groups_contract.json)."""
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from batch_scope import scope_groups  # noqa: E402

_FIXTURE = Path(__file__).resolve().parents[2] / 'tests' / 'fixtures' / 'scope_groups_contract.json'
_CASES = json.loads(_FIXTURE.read_text())['cases'] if _FIXTURE.exists() else []


@pytest.mark.skipif(not _CASES, reason='contract fixture not mounted')
@pytest.mark.parametrize('case', _CASES, ids=[c['name'] for c in _CASES])
def test_the_orchestrator_reads_the_webapps_groups(case):
    project = dict(case['project'], scopeGroups=case['scopeGroups'])
    got = [{k: v for k, v in g.items() if k != 'entries'} for g in scope_groups(project)]
    assert got == case['expected']
