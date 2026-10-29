"""Step 3 — LATS streaming emission + the dual-enum string contract.

Drives lats_hook in shadow mode with a fake StreamingCallback and asserts
on_lats_start / on_lats_tree_update fire with a schema-valid snapshot; asserts
the Python MessageType.LATS_* string literals match the TS enum contract
(webapp/src/lib/websocket-types.ts). See LATS_integration.md §19 Step 3.
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import project_settings  # noqa: E402
from orchestrator_helpers import lats  # noqa: E402


def _settings(**over):
    s = dict(project_settings.DEFAULT_AGENT_SETTINGS)
    s["LATS_ENABLED"] = True
    s["LATS_SHADOW_MODE"] = True
    s.update(over)
    return s


def _state():
    return {
        "current_phase": "exploitation",
        "session_id": "s1",
        "target_info": {"services": ["http"]},
        "chain_findings_memory": [],
        "conversation_objectives": [{"objective": "admin takeover"}],
        "current_objective_index": 0,
        "deep_think_ran_this_turn": True,
        "_reject_tool": False,
        "_current_plan": None,
        "_current_step": None,
        "_exploit_tree": None,
    }


def _decision():
    return {"action": "use_tool", "tool_name": "execute_nmap", "tool_args": {},
            "output_analysis": {"per_step": [], "productivity": {"verdict": "new_info"}}}


TWO_PROBES = [
    {"tool_name": "execute_curl", "tool_args": {"url": "a"}, "rationale": "sqli"},
    {"tool_name": "execute_httpx", "tool_args": {"url": "b"}, "rationale": "enum"},
]


class _FakeCallback:
    def __init__(self):
        self.starts = []
        self.updates = []
        self.completes = []

    async def on_lats_start(self, search_id, objective, phase, budget, shadow_mode):
        self.starts.append({"search_id": search_id, "objective": objective,
                            "phase": phase, "budget": budget, "shadow_mode": shadow_mode})

    async def on_lats_tree_update(self, search_id, snapshot):
        self.updates.append({"search_id": search_id, "snapshot": snapshot})

    async def on_lats_complete(self, search_id, best_trajectory, outcome, metrics=None):
        self.completes.append({"search_id": search_id, "outcome": outcome,
                               "best_trajectory": best_trajectory, "metrics": metrics})


class TestEmission(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    async def test_start_and_update_emitted_with_valid_snapshot(self):
        cb = _FakeCallback()
        callbacks = {"s1": cb}
        state = _state()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=TWO_PROBES)):
            await lats.lats_hook(state, _decision(), llm=object(),
                                 streaming_callbacks=callbacks, session_id="s1")
        # on_lats_start fired once
        self.assertEqual(len(cb.starts), 1)
        self.assertEqual(cb.starts[0]["phase"], "exploitation")
        self.assertTrue(cb.starts[0]["shadow_mode"])
        self.assertEqual(cb.starts[0]["budget"]["max_rollouts"], 50)
        # on_lats_tree_update fired with a schema-valid snapshot
        self.assertEqual(len(cb.updates), 1)
        snap = cb.updates[0]["snapshot"]
        for key in ("search_id", "objective", "phase", "shadow_mode", "rollouts",
                    "budget", "active_id", "best_trajectory", "nodes"):
            self.assertIn(key, snap)
        self.assertTrue(snap["search_id"].startswith("s1:"))
        # each node view carries the documented fields
        self.assertTrue(snap["nodes"])
        n = snap["nodes"][0]
        for key in ("id", "parent_id", "depth", "label", "tool_name", "status",
                    "value", "local_value", "visits", "verdict", "error_class",
                    "finding_confidence", "exploit_succeeded", "observation",
                    "reflection", "is_dangerous", "step_id"):
            self.assertIn(key, n)

    async def test_no_callback_is_safe(self):
        state = _state()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=TWO_PROBES)):
            # streaming_callbacks=None must not raise
            out = await lats.lats_hook(state, _decision(), llm=object(),
                                       streaming_callbacks=None, session_id="s1")
        self.assertIsNotNone(state["_exploit_tree"])
        self.assertEqual(out["action"], "use_tool")


class _OrderedCallback:
    """Records the order of on_lats_* calls with their payloads."""
    def __init__(self):
        self.calls = []

    async def on_lats_start(self, *a):
        self.calls.append(("start", a))

    async def on_lats_tree_update(self, search_id, snapshot):
        self.calls.append(("tree_update", snapshot))

    async def on_lats_complete(self, search_id, traj, outcome, metrics=None):
        self.calls.append(("complete", outcome))


class TestCollapseStreamsFinalSnapshot(unittest.IsolatedAsyncioTestCase):
    """Regression (found live): the branch_collapsed exit must stream the FINAL
    evaluated/pruned tree before on_lats_complete, so the card shows the scored
    result instead of freezing at the rollout-0 'all executing / 0.00' snapshot.
    """

    def setUp(self):
        project_settings._settings = _settings(LATS_SHADOW_MODE=False)

    def tearDown(self):
        project_settings._settings = None

    async def test_tree_update_precedes_complete_and_shows_evaluation(self):
        from state import ExploitTree, ExploitTreeNode
        # A live tree whose single executing child is at max depth: after it
        # evaluates it becomes the lone leaf that cannot expand -> collapse.
        root = ExploitTreeNode(id="root", status="evaluated", depth=0)
        c1 = ExploitTreeNode(id="c1", parent_id="root", depth=6, status="executing",
                             tool_name="execute_curl")
        root.children = ["c1"]
        tree = ExploitTree(root_id="root", nodes={"root": root, "c1": c1},
                           active_node_id="root", objective="admin takeover")
        state = _state()
        state["_exploit_tree"] = tree.model_dump()
        state["_current_plan"] = {"steps": [
            {"tool_name": "execute_curl", "tool_output": "200 reflected error",
             "error_class": "success", "duration_ms": 50, "step_id": "s1"},
        ]}
        decision = _decision()
        decision["output_analysis"] = {"per_step": [], "productivity": {"verdict": "new_info"}}

        cb = _OrderedCallback()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[])):
            await lats.lats_hook(state, decision, llm=object(),
                                 streaming_callbacks={"s1": cb}, session_id="s1")

        kinds = [c[0] for c in cb.calls]
        # a tree_update is streamed immediately before the complete
        self.assertIn("tree_update", kinds)
        self.assertIn("complete", kinds)
        self.assertLess(kinds.index("tree_update"), kinds.index("complete"))
        # and that final snapshot reflects the evaluation (no node left 'executing')
        final_snap = [c[1] for c in cb.calls if c[0] == "tree_update"][-1]
        statuses = {n["status"] for n in final_snap["nodes"]}
        self.assertNotIn("executing", statuses)
        # complete carried the collapse outcome
        self.assertEqual([c[1] for c in cb.calls if c[0] == "complete"][-1], "branch_collapsed")


class TestMsgTypeContract(unittest.TestCase):
    def test_lats_string_literals(self):
        from websocket_api import MessageType
        # These literals MUST equal the TS MessageType enum values.
        self.assertEqual(MessageType.LATS_START.value, "lats_start")
        self.assertEqual(MessageType.LATS_TREE_UPDATE.value, "lats_tree_update")
        self.assertEqual(MessageType.LATS_COMPLETE.value, "lats_complete")


if __name__ == "__main__":
    unittest.main()
