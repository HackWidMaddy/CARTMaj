"""Recon reads the webapp's scopeGroups as the orchestrator and the agent do
(the shared fixture tests/fixtures/scope_groups_contract.json; the webapp side
is webapp/src/lib/scopeGroups.contract.test.ts)."""
import json
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO))

from recon.project_settings import _parse_scope_groups  # noqa: E402

_FIXTURE = _REPO / 'tests' / 'fixtures' / 'scope_groups_contract.json'
_CASES = json.loads(_FIXTURE.read_text())['cases'] if _FIXTURE.exists() else []


@pytest.mark.skipif(not _CASES, reason='contract fixture not mounted')
@pytest.mark.parametrize('case', _CASES, ids=[c['name'] for c in _CASES])
def test_recon_reads_the_webapps_groups(case):
    assert _parse_scope_groups(case['scopeGroups']) == case['expected']
