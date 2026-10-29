"""
The agent's copy of the hard guardrail, and its sameness with the orchestrator's.

Two Python copies exist because the agent and the orchestrator ship in different
images. Both must block exactly the same names: the shared vectors check each
copy's behaviour, and the identity test checks that the pattern list and the
exact list are the same, so a pattern added to one copy only cannot pass.
"""
import importlib.util
import json
import sys
from pathlib import Path

import pytest

AGENTIC = Path(__file__).resolve().parents[1]
REPO = AGENTIC.parent
AGENT_COPY = AGENTIC / 'orchestrator_helpers' / 'hard_guardrail.py'
ORCH_COPY = REPO / 'recon_orchestrator' / 'hard_guardrail.py'
VECTORS_FILE = REPO / 'recon_orchestrator' / 'tests' / 'fixtures' / 'hard_guardrail_vectors.json'


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


agent = _load(AGENT_COPY, '_agent_hard_guardrail')


def _vectors():
    if not VECTORS_FILE.exists():
        pytest.skip(f'{VECTORS_FILE} is not in this image')
    return json.loads(VECTORS_FILE.read_text())['vectors']


def test_every_shared_vector():
    wrong = [(v['name'], v['blocked']) for v in _vectors() if agent.is_hard_blocked(v['name'])[0] != v['blocked']]
    assert wrong == []


def test_first_hard_blocked_reports_the_first_blocked_name_in_order():
    assert agent.first_hard_blocked(['example.com', 'x.met.police.uk', 'gov.uk'])[0] == 'x.met.police.uk'
    assert agent.first_hard_blocked(['example.com']) is None


def test_the_two_python_copies_are_identical_in_what_they_block():
    if not ORCH_COPY.exists():
        pytest.skip(f'{ORCH_COPY} is not in this image')
    orch = _load(ORCH_COPY, '_orch_hard_guardrail')
    assert agent._TLD_PATTERNS == orch._TLD_PATTERNS
    assert agent._EXACT_BLOCKED_DOMAINS == orch._EXACT_BLOCKED_DOMAINS


def _imports(path: Path):
    import ast
    tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name.split('.')[0]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.module.split('.')[0]


def test_both_copies_import_only_the_standard_library():
    allowed = set(sys.stdlib_module_names) | {'__future__'}
    paths = [AGENT_COPY] + ([ORCH_COPY] if ORCH_COPY.exists() else [])
    assert sorted(f'{p.name}:{m}' for p in paths for m in _imports(p) if m not in allowed) == []
