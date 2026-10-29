"""Step 2 — LATS think_node hook in SHADOW mode.

Tests lats_hook directly (the unit under test): shadow ENTER builds the tree and
returns the decision UNCHANGED; the activation gate negatives leave the tree
None; a two-visit cycle grows evaluated children. lats_expand is stubbed so no
real LLM call is made. See internal/LATS_integration.md §19 Step 2, §20.2.
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import project_settings  # noqa: E402
from orchestrator_helpers import lats  # noqa: E402
from state import ExploitTree  # noqa: E402


def _settings(**over):
    s = dict(project_settings.DEFAULT_AGENT_SETTINGS)
    s["LATS_ENABLED"] = True
    s["LATS_SHADOW_MODE"] = True
    s.update(over)
    return s


def _state(**over):
    base = {
        "current_phase": "exploitation",
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


def _decision(action="use_tool", tool_name="execute_curl", analysis=None):
    return {
        "action": action,
        "tool_name": tool_name,
        "tool_args": {"url": "https://t/login"},
        "output_analysis": analysis or {"per_step": [], "productivity": {"verdict": "new_info"}},
    }


TWO_PROBES = [
    {"tool_name": "execute_curl", "tool_args": {"url": "a"}, "rationale": "sqli"},
    {"tool_name": "execute_httpx", "tool_args": {"url": "b"}, "rationale": "enum"},
]


class TestShadowEnter(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    async def test_shadow_builds_tree_but_does_not_drive(self):
        state = _state()
        decision = _decision(action="use_tool", tool_name="execute_nmap")
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=TWO_PROBES)):
            out = await lats.lats_hook(state, decision, llm=object())
        # Tree was built...
        self.assertIsNotNone(state["_exploit_tree"])
        tree = ExploitTree(**state["_exploit_tree"])
        root = tree.nodes[tree.root_id]
        self.assertEqual(len(root.children), 2)
        # ...and the wave was marked executing (for next-turn evaluation)...
        executing = [n for n in tree.nodes.values() if n.status == "executing"]
        self.assertEqual(len(executing), 2)
        # ...but the decision is UNCHANGED (shadow never drives).
        self.assertEqual(out["action"], "use_tool")
        self.assertEqual(out["tool_name"], "execute_nmap")

    async def test_fewer_than_min_hypotheses_no_activation(self):
        state = _state()
        decision = _decision()
        one = [TWO_PROBES[0]]
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=one)):
            out = await lats.lats_hook(state, decision, llm=object())
        self.assertIsNone(state["_exploit_tree"])
        self.assertEqual(out, decision)


class TestGateNegatives(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    async def _assert_inactive(self, state):
        decision = _decision()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=TWO_PROBES)) as ex:
            out = await lats.lats_hook(state, decision, llm=object())
        self.assertIsNone(state["_exploit_tree"])
        self.assertEqual(out, decision)
        return ex

    async def test_disabled_is_strict_noop(self):
        project_settings._settings = _settings(LATS_ENABLED=False)
        ex = await self._assert_inactive(_state())
        ex.assert_not_called()   # not even the assessment call fires

    async def test_deep_think_not_fired(self):
        await self._assert_inactive(_state(deep_think_ran_this_turn=False))

    async def test_wrong_phase(self):
        await self._assert_inactive(_state(current_phase="informational"))

    async def test_no_surface(self):
        await self._assert_inactive(_state(target_info={}, chain_findings_memory=[]))

    async def test_already_exploited(self):
        # A foothold gates LATS off only in pentest mode (LATS_STOP_ON_FOOTHOLD);
        # on a flag-hunt (default off) it would NOT block. Enable it here.
        project_settings._settings["LATS_STOP_ON_FOOTHOLD"] = True
        await self._assert_inactive(
            _state(chain_findings_memory=[{"finding_type": "access_gained"}])
        )


class TestTwoVisitGrowth(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    async def test_second_visit_evaluates_wave(self):
        state = _state()
        # Visit 1: ENTER, seed + mark wave executing.
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=TWO_PROBES)):
            await lats.lats_hook(state, _decision(), llm=object())
        tree1 = ExploitTree(**state["_exploit_tree"])
        self.assertEqual(tree1.rollouts, 0)
        self.assertEqual(len([n for n in tree1.nodes.values() if n.status == "executing"]), 2)

        # Between visits: the wave "ran". Simulate execute_plan writing outputs.
        state["_current_plan"] = {"steps": [
            {"tool_name": "execute_curl", "tool_args": {"url": "a"},
             "tool_output": "403 blocked (WAF)", "error_class": "application_4xx",
             "duration_ms": 30, "step_id": "s1"},
            {"tool_name": "execute_httpx", "tool_args": {"url": "b"},
             "tool_output": "200 {debug_token:9f}", "error_class": "success",
             "duration_ms": 40, "step_id": "s2"},
        ]}
        analysis = {
            "exploit_succeeded": False,
            "per_step": [
                {"step_index": 0, "verdict": "blocked"},
                {"step_index": 1, "verdict": "new_info", "finding": "token", "confidence": 85},
            ],
            "productivity": {"verdict": "new_info"},
        }
        # Visit 2: EVALUATE the wave, then re-select/expand.
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[
            {"tool_name": "execute_curl", "tool_args": {}, "rationale": "reuse token"},
            {"tool_name": "execute_curl", "tool_args": {}, "rationale": "tamper expiry"},
        ])):
            await lats.lats_hook(state, _decision(analysis=analysis), llm=object())
        tree2 = ExploitTree(**state["_exploit_tree"])
        self.assertEqual(tree2.rollouts, 1)
        statuses = {n.status for n in tree2.nodes.values()}
        # The WAF child pruned, the token child evaluated (and expanded further).
        self.assertIn("pruned", statuses)
        self.assertIn("evaluated", statuses)
        pruned = [n for n in tree2.nodes.values() if n.status == "pruned"]
        self.assertTrue(any(n.reflection for n in pruned))


if __name__ == "__main__":
    unittest.main()
