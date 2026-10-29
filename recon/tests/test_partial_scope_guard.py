"""Regression guard: partial-recon modules read their roots through scope_roots().

A Domain-batch partial run covers every root in config["domains"]. A module that
reads config["domain"] (one root) scans only the first root and silently skips
the rest - the bug this whole change fixed. So no file in
recon/partial_recon_modules/ may read config["domain"] or config.get("domain"),
except scope_roots() itself, which is the one place that falls back to it for a
job queued before multi-root runs.

This is an AST check, not a text grep: it ignores the word in comments and
strings, and it names the file and line of any offender.
"""
import ast
from pathlib import Path

MODULES = Path(__file__).resolve().parent.parent / "partial_recon_modules"
ALLOWED = {("helpers.py", "scope_roots")}


def _reads_config_domain(node: ast.AST) -> bool:
    """config["domain"] or config.get("domain", ...)."""
    if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name) and node.value.id == "config":
        key = node.slice
        return isinstance(key, ast.Constant) and key.value == "domain"
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get" and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "config" and node.args):
        first = node.args[0]
        return isinstance(first, ast.Constant) and first.value == "domain"
    return False


def _offenders():
    found = []
    for path in sorted(MODULES.glob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for func in ast.walk(tree):
            if not isinstance(func, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if (path.name, func.name) in ALLOWED:
                continue
            for node in ast.walk(func):
                # A Store (config["domain"] = ...) is a write, not a read.
                if isinstance(node, ast.Subscript) and isinstance(node.ctx, ast.Store):
                    continue
                if _reads_config_domain(node):
                    found.append(f"{path.name}:{node.lineno} in {func.name}()")
    return sorted(set(found))


def test_no_module_reads_config_domain_directly():
    offenders = _offenders()
    assert not offenders, (
        "These read config['domain'] (one root) instead of scope_roots(config) "
        "(every root of the run):\n  " + "\n  ".join(offenders))


def test_the_guard_catches_a_direct_read(tmp_path, monkeypatch):
    # The guard must actually detect the pattern, or it would pass vacuously.
    bad = tmp_path / "bad_module.py"
    bad.write_text("def run(config):\n"
                   "    a = config['domain']\n"          # subscript read
                   "    b = config.get('domain', '')\n"  # .get read
                   "    config['domain'] = a\n"          # a write: allowed
                   "    return a + b\n")
    monkeypatch.setattr(__import__(__name__), "MODULES", tmp_path)
    assert _offenders() == ["bad_module.py:2 in run()", "bad_module.py:3 in run()"]
