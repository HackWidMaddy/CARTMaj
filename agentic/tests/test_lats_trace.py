"""Step 1 regression — pin the canonical "Node A" walkthrough (login -> admin
takeover) so the value function and search ordering can never silently drift.

Scenario (internal/LATS_integration.md §10, §16): root /login expands to four
probes. A WAF/401 prunes the credential + SQLi branches; the forgot-password
branch leaks a token (highest value) and wins; a JWT probe scores low but
survives the prune floor. These exact numbers are the drift guard.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import project_settings  # noqa: E402
from orchestrator_helpers import lats  # noqa: E402
from state import ExploitTree, ExploitTreeNode  # noqa: E402


# The shared aggregate analysis for the root wave, with per-step attribution.
NODE_A_ANALYSIS = {
    "exploit_succeeded": False,
    "per_step": [
        {"step_index": 0, "verdict": "blocked"},                                   # default creds
        {"step_index": 1, "verdict": "blocked"},                                   # SQLi on username
        {"step_index": 2, "verdict": "new_info", "finding": "debug_token", "confidence": 85},  # forgot-password
        {"step_index": 3, "verdict": ""},                                          # JWT alg-confusion
    ],
}

NODE_A_STEPS = [
    {"error_class": "application_4xx", "_step_index": 0, "tool_output": "401 wrong password"},
    {"error_class": "application_4xx", "_step_index": 1, "tool_output": "403 blocked (WAF)"},
    {"error_class": "success", "_step_index": 2, "tool_output": "200 {debug_token:9f3a1c7b}"},
    {"error_class": "application_5xx_normal", "_step_index": 3, "tool_output": "500 stack trace"},
]


class TestNodeATrace(unittest.TestCase):
    def setUp(self):
        project_settings._settings = None

    def tearDown(self):
        project_settings._settings = None

    def test_pinned_child_values(self):
        values = [lats.lats_value(s, NODE_A_ANALYSIS) for s in NODE_A_STEPS]
        # c1 default creds: 4xx + blocked -> 0.0 (pruned)
        self.assertAlmostEqual(values[0], 0.0)
        # c2 SQLi: 4xx + blocked -> 0.0 (pruned)
        self.assertAlmostEqual(values[1], 0.0)
        # c3 forgot-password: finding(0.5*0.85) + new_info(0.3) -> 0.725 (HOT)
        self.assertAlmostEqual(values[2], 0.725)
        # c4 JWT: application_5xx_normal(0.2), no verdict bonus -> 0.2 (survives floor)
        self.assertAlmostEqual(values[3], 0.2)

    def test_prune_floor_partitions_branches(self):
        floor = 0.15   # LATS_PRUNE_FLOOR default
        values = [lats.lats_value(s, NODE_A_ANALYSIS) for s in NODE_A_STEPS]
        pruned = [i for i, v in enumerate(values) if v < floor and not NODE_A_STEPS[i].get("exploit_succeeded")]
        self.assertEqual(pruned, [0, 1])          # only c1, c2 fall below the floor
        self.assertGreaterEqual(values[3], floor)  # c4 survives

    def test_search_selects_hot_branch_after_evaluation(self):
        # Build the post-evaluation tree: root -> c1..c4 with the pinned values.
        root = ExploitTreeNode(id="root", status="evaluated", depth=0)
        tree = ExploitTree(root_id="root", nodes={"root": root}, rollouts=1)
        values = [lats.lats_value(s, NODE_A_ANALYSIS) for s in NODE_A_STEPS]
        labels = ["c1", "c2", "c3", "c4"]
        for label, v in zip(labels, values):
            status = "pruned" if (v < 0.15) else "evaluated"
            n = ExploitTreeNode(id=label, parent_id="root", depth=1, status=status,
                                value=v, local_value=v, visits=1, tool_name="execute_curl")
            if status == "pruned":
                n.reflection = lats._reflect(NODE_A_STEPS[labels.index(label)], NODE_A_ANALYSIS)
            tree.nodes[label] = n
            root.children.append(label)
        lats.lats_backprop(tree, "c3", values[2])
        # Root now sees the hot value.
        self.assertAlmostEqual(tree.nodes["root"].value, 0.725)
        # SELECT descends past the pruned siblings to the hot, expandable c3.
        self.assertEqual(lats.lats_select(tree, 1.4), "c3")
        # Pruned nodes carry a reflection.
        self.assertTrue(tree.nodes["c1"].reflection)
        self.assertTrue(tree.nodes["c2"].reflection)

    def test_best_trajectory_from_hot_leaf(self):
        root = ExploitTreeNode(id="root", status="evaluated", value=0.725)
        c3 = ExploitTreeNode(id="c3", parent_id="root", depth=1, status="evaluated", value=0.725)
        tree = ExploitTree(root_id="root", nodes={"root": root, "c3": c3}, rollouts=1)
        root.children = ["c3"]
        self.assertEqual(lats.best_trajectory(tree), ["root", "c3"])


if __name__ == "__main__":
    unittest.main()
