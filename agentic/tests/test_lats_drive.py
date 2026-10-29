"""Step 6 — GO LIVE: lats_hook overrides the decision when not in shadow.

Drive cases (§19 Step 6): mutex-safe wave (dangerous included) -> plan_tools;
same-mutex-group -> only one enters the wave; terminal -> complete; budget ->
complete; collapse -> decision unchanged. Plus the off-diff guarantee: disabled
LATS is a strict no-op. See internal/LATS_integration.md §5.3, §20.3.
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import project_settings  # noqa: E402
from orchestrator_helpers import lats  # noqa: E402
from state import ExploitTree, ExploitTreeNode  # noqa: E402


def _settings(**over):
    s = dict(project_settings.DEFAULT_AGENT_SETTINGS)
    s["LATS_ENABLED"] = True
    s["LATS_SHADOW_MODE"] = False   # DRIVE
    s.update(over)
    return s


def _state(**over):
    base = {
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
    base.update(over)
    return base


def _decision(action="use_tool", tool_name="execute_nmap", analysis=None):
    return {
        "action": action,
        "tool_name": tool_name,
        "tool_args": {},
        "output_analysis": analysis or {"per_step": [], "productivity": {"verdict": "new_info"}},
    }


class TestDriveEnter(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    async def test_two_safe_probes_become_plan_tools(self):
        probes = [
            {"tool_name": "execute_curl", "tool_args": {"url": "a"}, "rationale": "sqli"},
            {"tool_name": "execute_httpx", "tool_args": {"url": "b"}, "rationale": "enum"},
        ]
        state = _state()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=probes)):
            out = await lats.lats_hook(state, _decision(), llm=object())
        self.assertEqual(out["action"], "plan_tools")
        names = [s["tool_name"] for s in out["tool_plan"]["steps"]]
        self.assertEqual(sorted(names), ["execute_curl", "execute_httpx"])

    async def test_dangerous_tool_stays_in_wave(self):
        # kali_shell is dangerous; it must still fan out (mark is confirm-only §20.3).
        probes = [
            {"tool_name": "execute_curl", "tool_args": {}, "rationale": "x"},
            {"tool_name": "kali_shell", "tool_args": {"command": "id"}, "rationale": "y"},
        ]
        state = _state()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=probes)):
            out = await lats.lats_hook(state, _decision(), llm=object())
        names = [s["tool_name"] for s in out["tool_plan"]["steps"]]
        self.assertIn("kali_shell", names)

    async def test_two_same_mutex_group_only_one_in_wave(self):
        probes = [
            {"tool_name": "metasploit_console", "tool_args": {"a": 1}, "rationale": "x"},
            {"tool_name": "metasploit_console", "tool_args": {"a": 2}, "rationale": "y"},
        ]
        state = _state()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=probes)):
            out = await lats.lats_hook(state, _decision(), llm=object())
        # only one metasploit_console in the issued move -> a single use_tool
        self.assertEqual(out["action"], "use_tool")
        self.assertEqual(out["tool_name"], "metasploit_console")
        # the deferred sibling stays proposed for a later turn
        tree = ExploitTree(**state["_exploit_tree"])
        proposed = [n for n in tree.nodes.values() if n.status == "proposed"]
        self.assertEqual(len(proposed), 1)


class TestDriveExits(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    def _seed_tree(self, state, child_status="executing", child_kwargs=None):
        root = ExploitTreeNode(id="root", status="evaluated", depth=0)
        child = ExploitTreeNode(id="c1", parent_id="root", depth=1,
                                status=child_status, tool_name="execute_curl",
                                **(child_kwargs or {}))
        root.children = ["c1"]
        tree = ExploitTree(root_id="root", nodes={"root": root, "c1": child},
                           active_node_id="root", objective="admin takeover")
        state["_exploit_tree"] = tree.model_dump()

    async def test_terminal_forces_complete(self):
        state = _state()
        self._seed_tree(state)
        state["_current_plan"] = {"steps": [
            {"tool_name": "execute_curl", "tool_args": {}, "tool_output": "reset admin ok",
             "error_class": "success", "exploit_succeeded": True, "step_id": "s1"},
        ]}
        analysis = {"exploit_succeeded": True, "per_step": [{"step_index": 0, "verdict": "new_info"}]}
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[])):
            out = await lats.lats_hook(state, _decision(analysis=analysis), llm=object())
        self.assertEqual(out["action"], "complete")

    async def test_budget_forces_complete(self):
        state = _state()
        # Pre-seed a tree already at the rollout cap.
        root = ExploitTreeNode(id="root", status="evaluated", depth=0)
        c1 = ExploitTreeNode(id="c1", parent_id="root", depth=1, status="evaluated", value=0.5)
        root.children = ["c1"]
        tree = ExploitTree(root_id="root", nodes={"root": root, "c1": c1},
                           rollouts=50, objective="admin takeover")
        state["_exploit_tree"] = tree.model_dump()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[])):
            out = await lats.lats_hook(state, _decision(), llm=object())
        self.assertEqual(out["action"], "complete")

    async def test_collapse_returns_decision_unchanged(self):
        state = _state()
        # One depth-capped live leaf, nothing queued -> collapse hands to legacy.
        root = ExploitTreeNode(id="root", status="evaluated", depth=0)
        c1 = ExploitTreeNode(id="c1", parent_id="root", depth=6, status="evaluated", value=0.5)
        root.children = ["c1"]
        tree = ExploitTree(root_id="root", nodes={"root": root, "c1": c1},
                           rollouts=1, objective="admin takeover")
        state["_exploit_tree"] = tree.model_dump()
        decision = _decision(action="use_tool", tool_name="execute_nmap")
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[])):
            out = await lats.lats_hook(state, decision, llm=object())
        self.assertEqual(out, decision)               # unchanged
        self.assertIsNone(state["_exploit_tree"])     # archived


class TestOffDiff(unittest.IsolatedAsyncioTestCase):
    async def test_disabled_is_identity(self):
        project_settings._settings = _settings(LATS_ENABLED=False)
        try:
            decision = _decision()
            with patch("orchestrator_helpers.lats.lats_expand", AsyncMock()) as ex:
                out = await lats.lats_hook(_state(), decision, llm=object())
            self.assertIs(out, decision)     # same object, no mutation
            ex.assert_not_called()
        finally:
            project_settings._settings = None


if __name__ == "__main__":
    unittest.main()
