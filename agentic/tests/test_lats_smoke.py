"""Smoke / convergence test — drive lats_hook across several think cycles and
assert the search converges: dead branches get pruned, the hot branch deepens,
and a foothold ends the search with action=complete.

Deterministic (scripted lats_expand + scripted step outputs); no LLM, no live
stack, so it runs in the focused suite. The real-pydantic path is covered by
test_lats_integration; this validates the multi-rollout control flow.
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


def _settings():
    s = dict(project_settings.DEFAULT_AGENT_SETTINGS)
    s["LATS_ENABLED"] = True
    s["LATS_SHADOW_MODE"] = False   # DRIVE
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


def _decision(analysis):
    return {"action": "use_tool", "tool_name": "x", "tool_args": {},
            "output_analysis": analysis}


def _plan(steps):
    return {"steps": steps}


def _step(tool, output, ec, idx):
    return {"tool_name": tool, "tool_output": output, "error_class": ec,
            "duration_ms": 100, "step_id": f"s{idx}", "_step_index": idx}


class TestConvergence(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    async def test_search_prunes_deepens_and_reaches_terminal(self):
        state = _state()

        # ENTER: root assessment yields 3 credible probes (all execute_curl).
        root_probes = [
            {"tool_name": "execute_curl", "tool_args": {"u": "creds"}, "rationale": "default creds"},
            {"tool_name": "execute_curl", "tool_args": {"u": "sqli"}, "rationale": "sqli"},
            {"tool_name": "execute_curl", "tool_args": {"u": "reset"}, "rationale": "forgot-password"},
        ]
        # Expand of the hot node yields 2 follow-ups, one of which detonates.
        hot_probes = [
            {"tool_name": "execute_curl", "tool_args": {"u": "reuse"}, "rationale": "reuse token"},
            {"tool_name": "execute_curl", "tool_args": {"u": "forge"}, "rationale": "forge token"},
        ]

        # --- Turn 1: ENTER, issue the root wave ---
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=root_probes)):
            out1 = await lats.lats_hook(state, _decision({"per_step": []}), llm=object())
        self.assertEqual(out1["action"], "plan_tools")
        tree1 = ExploitTree(**state["_exploit_tree"])
        self.assertEqual(len([n for n in tree1.nodes.values() if n.status == "executing"]), 3)

        # --- Between: the 3 probes ran; only the reset probe leaked a token ---
        state["_current_plan"] = _plan([
            _step("execute_curl", "401 wrong password", "application_4xx", 0),
            _step("execute_curl", "403 blocked (WAF)", "application_4xx", 1),
            _step("execute_curl", "200 {debug_token:9f}", "success", 2),
        ])
        analysis2 = {"per_step": [
            {"step_index": 0, "verdict": "blocked"},
            {"step_index": 1, "verdict": "blocked"},
            {"step_index": 2, "verdict": "new_info", "finding": "token", "confidence": 85},
        ]}

        # --- Turn 2: evaluate (2 pruned, 1 hot), expand the hot node ---
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=hot_probes)):
            out2 = await lats.lats_hook(state, _decision(analysis2), llm=object())
        tree2 = ExploitTree(**state["_exploit_tree"])
        self.assertEqual(tree2.rollouts, 1)
        pruned = [n for n in tree2.nodes.values() if n.status == "pruned"]
        self.assertEqual(len(pruned), 2, "the two dead root branches are pruned")
        self.assertTrue(all(n.reflection for n in pruned))
        # a new wave (the hot node's grandchildren) is now executing
        self.assertGreaterEqual(len([n for n in tree2.nodes.values() if n.status == "executing"]), 1)
        self.assertEqual(out2["action"], "plan_tools")

        # --- Between: the forge-token grandchild detonates ---
        exec_nodes = [n for n in tree2.nodes.values() if n.status == "executing"]
        steps = []
        for i, n in enumerate(exec_nodes):
            detonated = "forge" in (n.tool_args or {}).get("u", "")
            steps.append(_step("execute_curl",
                               "admin password reset" if detonated else "token expired",
                               "success", i))
        per_step = []
        for i, n in enumerate(exec_nodes):
            detonated = "forge" in (n.tool_args or {}).get("u", "")
            per_step.append({"step_index": i, "verdict": "new_info",
                             "exploit_succeeded": detonated})
        state["_current_plan"] = _plan(steps)

        # --- Turn 3: evaluate -> terminal -> complete ---
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[])):
            out3 = await lats.lats_hook(state, _decision({"per_step": per_step}), llm=object())
        self.assertEqual(out3["action"], "complete", "a foothold ends the search")
        self.assertIn("completion_reason", out3)
        self.assertIn("terminal", out3["completion_reason"])


if __name__ == "__main__":
    unittest.main()
