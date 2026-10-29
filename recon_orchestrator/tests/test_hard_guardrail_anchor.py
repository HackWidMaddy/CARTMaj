"""
The hard guardrail, the one scope control an operator cannot switch off.

Every pattern is anchored on a label boundary, so a bare multi-label government
suffix (`gov.uk`, `go.jp`) is blocked as well as the hosts under it. Before the
anchoring, a batch whose hosts grouped under `gov.uk` passed: every pattern
needed a leading dot that the bare suffix does not have.

The vectors are shared with the webapp and agent copies
(tests/fixtures/hard_guardrail_vectors.json), so the three copies cannot drift.
This copy is also bundled into the capture proxy, which FAILS OPEN if the import
fails, so the module must stay stdlib-only.
"""
import ast
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from hard_guardrail import first_hard_blocked, is_hard_blocked  # noqa: E402

VECTORS = json.loads((HERE / 'fixtures' / 'hard_guardrail_vectors.json').read_text())['vectors']


def test_every_shared_vector():
    wrong = [(v['name'], v['blocked']) for v in VECTORS if is_hard_blocked(v['name'])[0] != v['blocked']]
    assert wrong == []


def test_a_blocked_name_carries_a_reason_naming_it():
    blocked, reason = is_hard_blocked('www.agency.gov.uk')
    assert blocked and "'www.agency.gov.uk'" in reason


def test_first_hard_blocked_reports_the_first_blocked_name_in_order():
    names = ['example.com', 'www.isa.org.jm', 'www.agency.gov.uk']
    assert first_hard_blocked(names)[0] == 'www.isa.org.jm'


def test_first_hard_blocked_is_none_for_a_clean_list():
    assert first_hard_blocked(['example.com', 'acme.co.uk', '']) is None


def _imports(path: Path):
    tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                yield alias.name.split('.')[0]
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            yield node.module.split('.')[0]


def test_the_module_imports_only_the_standard_library():
    allowed = set(sys.stdlib_module_names) | {'__future__'}
    path = HERE.parent / 'hard_guardrail.py'
    assert sorted(m for m in _imports(path) if m not in allowed) == []
