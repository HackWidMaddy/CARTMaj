"""Step 0 — LATS state models + settings scaffolding (no behavior yet).

Covers:
- ExploitTree / ExploitTreeNode construction, defaults, and lossless
  model_dump() -> model_validate() round-trip (the tree rides inside AgentState
  as a plain dict and must survive checkpoint serialization, §20.11).
- OutputAnalysisInline.per_step optional field (§5.3).
- LATS_* defaults resolve through get_setting with no project loaded (§19 Step 0).
"""

from __future__ import annotations

import os
import sys
import unittest

# Ensure agent/ is importable for the pydantic-dependent state models.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from state import (  # noqa: E402
    ExploitTree,
    ExploitTreeNode,
    OutputAnalysisInline,
    PerStepAnalysis,
)
import project_settings  # noqa: E402


class TestExploitTreeModels(unittest.TestCase):
    def test_node_defaults(self):
        n = ExploitTreeNode()
        self.assertEqual(n.status, "proposed")
        self.assertEqual(n.value, 0.0)
        self.assertEqual(n.local_value, 0.0)
        self.assertEqual(n.visits, 0)
        self.assertEqual(n.depth, 0)
        self.assertFalse(n.exploit_succeeded)
        self.assertEqual(n.children, [])
        self.assertIsNone(n.parent_id)
        # id auto-generated, 8 hex chars
        self.assertEqual(len(n.id), 8)

    def test_node_ids_unique(self):
        ids = {ExploitTreeNode().id for _ in range(50)}
        self.assertEqual(len(ids), 50)

    def test_tree_defaults(self):
        t = ExploitTree(root_id="root0000")
        self.assertEqual(t.root_id, "root0000")
        self.assertEqual(t.nodes, {})
        self.assertIsNone(t.active_node_id)
        self.assertEqual(t.rollouts, 0)
        self.assertIsNone(t.best_terminal_id)
        self.assertEqual(t.objective, "")

    def test_round_trip_lossless(self):
        root = ExploitTreeNode(id="root0000", depth=0, probe_rationale="entry")
        child = ExploitTreeNode(
            id="child001",
            parent_id="root0000",
            depth=1,
            tool_name="execute_curl",
            tool_args={"url": "https://t/login"},
            probe_rationale="sqli on username",
            observation_summary="403 WAF",
            verdict="blocked",
            error_class="application_4xx",
            duration_ms=42,
            status="pruned",
            value=0.0,
            local_value=0.0,
            visits=1,
            reflection="WAF filters quotes",
        )
        root.children = [child.id]
        tree = ExploitTree(
            root_id=root.id,
            nodes={root.id: root, child.id: child},
            active_node_id=root.id,
            rollouts=1,
            objective="admin takeover",
        )
        dumped = tree.model_dump()
        restored = ExploitTree.model_validate(dumped)
        self.assertEqual(restored.model_dump(), dumped)
        self.assertEqual(restored.nodes["child001"].error_class, "application_4xx")
        self.assertEqual(restored.nodes["child001"].status, "pruned")

    def test_sixty_node_tree_serializes(self):
        root = ExploitTreeNode(id="root0000")
        nodes = {root.id: root}
        for i in range(59):
            n = ExploitTreeNode(id=f"n{i:06d}", parent_id=root.id, depth=1)
            root.children.append(n.id)
            nodes[n.id] = n
        tree = ExploitTree(root_id=root.id, nodes=nodes)
        dumped = tree.model_dump()
        self.assertEqual(len(dumped["nodes"]), 60)
        # round-trips
        self.assertEqual(ExploitTree.model_validate(dumped).model_dump(), dumped)


class TestOutputAnalysisPerStep(unittest.TestCase):
    def test_per_step_defaults_empty(self):
        oa = OutputAnalysisInline()
        self.assertEqual(oa.per_step, [])

    def test_per_step_populated(self):
        oa = OutputAnalysisInline(
            per_step=[
                PerStepAnalysis(step_index=0, verdict="blocked"),
                PerStepAnalysis(step_index=1, verdict="new_info", finding="token", confidence=85),
            ]
        )
        self.assertEqual(len(oa.per_step), 2)
        self.assertEqual(oa.per_step[1].confidence, 85)
        # round-trips
        self.assertEqual(
            OutputAnalysisInline.model_validate(oa.model_dump()).per_step[1].finding,
            "token",
        )


class TestLatsSettingsDefaults(unittest.TestCase):
    def setUp(self):
        # Force the "no project loaded" path: get_settings() falls back to
        # DEFAULT_AGENT_SETTINGS when _settings is None.
        project_settings._settings = None

    def tearDown(self):
        project_settings._settings = None

    def test_lats_enabled_off_by_default(self):
        self.assertIs(project_settings.get_setting("LATS_ENABLED", None), False)

    def test_lats_shadow_off_by_default(self):
        self.assertIs(project_settings.get_setting("LATS_SHADOW_MODE", None), False)

    def test_lats_numeric_defaults(self):
        self.assertEqual(project_settings.get_setting("LATS_MAX_DEPTH"), 6)
        self.assertEqual(project_settings.get_setting("LATS_MAX_ROLLOUTS"), 50)
        self.assertEqual(project_settings.get_setting("LATS_BRANCHING"), 6)
        self.assertEqual(project_settings.get_setting("LATS_MIN_HYPOTHESES"), 2)
        self.assertEqual(project_settings.get_setting("LATS_MAX_TREE_NODES"), 120)
        self.assertAlmostEqual(project_settings.get_setting("LATS_UCT_C"), 1.4)
        self.assertAlmostEqual(project_settings.get_setting("LATS_PRUNE_FLOOR"), 0.15)

    def test_lats_allowed_phases_default(self):
        self.assertEqual(
            project_settings.get_setting("LATS_ALLOWED_PHASES"), ["exploitation"]
        )

    def test_missing_key_uses_default_arg(self):
        self.assertEqual(project_settings.get_setting("LATS_NONEXISTENT", 42), 42)


if __name__ == "__main__":
    unittest.main()
