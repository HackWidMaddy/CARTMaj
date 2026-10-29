"""Cross-language contract: ExploitTree.to_view() must emit exactly the fields
the TS UI reads (LatsNodeView / LatsTreeSnapshot in websocket-types.ts). A
field-name drift renders as `undefined` in the UI with NO error, so this test
parses the TS interfaces and asserts key-set parity in both directions.
"""

from __future__ import annotations

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from state import ExploitTree, ExploitTreeNode  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TS_TYPES = os.path.join(REPO_ROOT, "webapp", "src", "lib", "websocket-types.ts")


def _ts_interface_fields(name: str) -> set:
    """Extract top-level field names from `export interface <name> { ... }`."""
    with open(TS_TYPES, "r") as f:
        src = f.read()
    m = re.search(rf"export interface {name} \{{(.*?)\n\}}", src, re.S)
    if not m:
        raise AssertionError(f"interface {name} not found in {TS_TYPES}")
    body = m.group(1)
    fields = set()
    depth = 0
    for line in body.splitlines():
        stripped = line.strip()
        # Only capture fields at brace-depth 0 (skip nested object literals).
        if depth == 0:
            fm = re.match(r"([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:", stripped)
            if fm:
                fields.add(fm.group(1))
        depth += stripped.count("{") - stripped.count("}")
    return fields


def _sample_view() -> dict:
    root = ExploitTreeNode(id="root", status="evaluated")
    child = ExploitTreeNode(id="c1", parent_id="root", depth=1, tool_name="execute_curl",
                            tool_args={"url": "x"}, value=0.8)
    root.children = ["c1"]
    tree = ExploitTree(root_id="root", nodes={"root": root, "c1": child}, objective="o")
    return tree.to_view(search_id="s:root", phase="exploitation", shadow_mode=True,
                        max_rollouts=24, max_depth=6, best_trajectory=["root", "c1"])


class TestViewContract(unittest.TestCase):
    def test_snapshot_keys_match_ts(self):
        view = _sample_view()
        py_keys = set(view.keys())
        ts_keys = _ts_interface_fields("LatsTreeSnapshot")
        self.assertEqual(py_keys, ts_keys,
                         f"snapshot drift: py-only={py_keys - ts_keys}, ts-only={ts_keys - py_keys}")

    def test_node_keys_match_ts(self):
        view = _sample_view()
        self.assertTrue(view["nodes"])
        py_keys = set(view["nodes"][0].keys())
        ts_keys = _ts_interface_fields("LatsNodeView")
        self.assertEqual(py_keys, ts_keys,
                         f"node drift: py-only={py_keys - ts_keys}, ts-only={ts_keys - py_keys}")

    def test_budget_shape(self):
        view = _sample_view()
        self.assertEqual(set(view["budget"].keys()), {"max_rollouts", "max_depth"})

    def test_node_view_does_not_recap_text_fields(self):
        """Regression: to_view() must pass UI-facing text through verbatim.

        A stray ``[:80]``-style slice here silently cut the card's "best line"
        and inspector title mid-word with no way to see the rest. The frontend
        clamps display itself, so the projection must NOT truncate. Guards
        label (probe_rationale), observation, and reflection.
        """
        long_rationale = "R" * 300
        long_observation = "O" * 300
        long_reflection = "F" * 300
        root = ExploitTreeNode(id="root", status="evaluated", probe_rationale="root")
        child = ExploitTreeNode(
            id="c1", parent_id="root", depth=1, tool_name="execute_curl",
            tool_args={"url": "x"}, value=0.8,
            probe_rationale=long_rationale,
            observation_summary=long_observation,
            reflection=long_reflection,
        )
        root.children = ["c1"]
        tree = ExploitTree(root_id="root", nodes={"root": root, "c1": child}, objective="o")
        view = tree.to_view(search_id="s:root", phase="exploitation", shadow_mode=True,
                            max_rollouts=24, max_depth=6, best_trajectory=["root", "c1"])
        node = next(n for n in view["nodes"] if n["id"] == "c1")
        self.assertEqual(node["label"], long_rationale)
        self.assertEqual(node["observation"], long_observation)
        self.assertEqual(node["reflection"], long_reflection)


if __name__ == "__main__":
    unittest.main()
