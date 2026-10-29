"""Regression tests for LATS wave attribution correctness (bugs found in the
deep review):

- Bug 2: an aggregate wave-level exploit_succeeded / finding must NOT mark every
  sibling terminal / inflate every sibling's value. Only the localized (per_step)
  or single credited child wins.
- Bug 3: an executing child that never ran (no matching executed step) must be
  reset to 'proposed' so it is re-selected, and must not steal another wave's
  step via positional skew (attribution is by tool_name).
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import project_settings  # noqa: E402
from orchestrator_helpers import lats  # noqa: E402
from state import ExploitTree, ExploitTreeNode  # noqa: E402


def _tree(children):
    """children: list of (id, tool_name). All start 'executing' under root."""
    root = ExploitTreeNode(id="root", status="evaluated", depth=0)
    tree = ExploitTree(root_id="root", nodes={"root": root})
    for cid, tool in children:
        n = ExploitTreeNode(id=cid, parent_id="root", depth=1, status="executing",
                            tool_name=tool)
        tree.nodes[cid] = n
        root.children.append(cid)
    return tree


def _plan(*steps):
    return {"steps": list(steps)}


def _step(tool_name, tool_output="200 ok", error_class="success"):
    return {"tool_name": tool_name, "tool_output": tool_output, "error_class": error_class,
            "duration_ms": 100, "step_id": f"s-{tool_name}"}


class TestAggregateExploitNotOverCredited(unittest.TestCase):
    def setUp(self):
        project_settings._settings = None

    def tearDown(self):
        project_settings._settings = None

    def test_aggregate_success_marks_only_one_terminal(self):
        tree = _tree([("c1", "execute_curl"), ("c2", "execute_httpx")])
        state = {"current_phase": "exploitation", "_reject_tool": False,
                 "_current_plan": _plan(_step("execute_curl"), _step("execute_httpx"))}
        # aggregate says a foothold happened, but NO per_step localizes which probe
        analysis = {"exploit_succeeded": True, "per_step": [],
                    "productivity": {"verdict": "new_info"}}
        lats._evaluate_wave(tree, state, analysis)
        terminals = [n for n in tree.nodes.values() if n.status == "terminal"]
        self.assertEqual(len(terminals), 1, "exactly one child may be credited the win")

    def test_per_step_localizes_the_win(self):
        tree = _tree([("c1", "execute_curl"), ("c2", "execute_httpx")])
        state = {"current_phase": "exploitation", "_reject_tool": False,
                 "_current_plan": _plan(_step("execute_curl", "403 blocked", "application_4xx"),
                                        _step("execute_httpx", "reset admin ok"))}
        analysis = {"exploit_succeeded": True, "per_step": [
            {"step_index": 0, "verdict": "blocked"},
            {"step_index": 1, "verdict": "new_info", "exploit_succeeded": True},
        ]}
        lats._evaluate_wave(tree, state, analysis)
        self.assertEqual(tree.nodes["c2"].status, "terminal")
        self.assertNotEqual(tree.nodes["c1"].status, "terminal")

    def test_aggregate_finding_not_credited_to_every_sibling(self):
        tree = _tree([("c1", "execute_curl"), ("c2", "execute_httpx")])
        state = {"current_phase": "exploitation", "_reject_tool": False,
                 "_current_plan": _plan(_step("execute_curl"), _step("execute_httpx"))}
        analysis = {"exploit_succeeded": False,
                    "chain_findings": [{"confidence": 90}], "per_step": [],
                    "productivity": {"verdict": "new_info"}}
        lats._evaluate_wave(tree, state, analysis)
        credited = [n for n in (tree.nodes["c1"], tree.nodes["c2"]) if n.finding_confidence_delta > 0]
        self.assertEqual(len(credited), 1, "aggregate finding credited to exactly one child")


class TestNeverRanChildrenReset(unittest.TestCase):
    def setUp(self):
        project_settings._settings = None

    def tearDown(self):
        project_settings._settings = None

    def test_unmatched_child_reset_to_proposed(self):
        # c2 (execute_httpx) never ran this turn -> reset to proposed, re-selectable.
        tree = _tree([("c1", "execute_curl"), ("c2", "execute_httpx")])
        state = {"current_phase": "exploitation", "_reject_tool": False,
                 "_current_plan": _plan(_step("execute_curl"))}
        analysis = {"exploit_succeeded": False, "per_step": [], "productivity": {"verdict": "new_info"}}
        lats._evaluate_wave(tree, state, analysis)
        self.assertEqual(tree.nodes["c1"].status, "evaluated")
        self.assertEqual(tree.nodes["c2"].status, "proposed")

    def test_operator_reject_prunes_executing_no_rollout(self):
        # _reject_tool True -> the pending wave is pruned with a reflection and
        # no rollout is counted (a rejection is not a probe result).
        tree = _tree([("c1", "execute_curl"), ("c2", "kali_shell")])
        state = {"current_phase": "exploitation", "_reject_tool": True, "_current_plan": None}
        counted = lats._evaluate_wave(tree, state, {"per_step": []})
        self.assertFalse(counted)
        self.assertEqual(tree.nodes["c1"].status, "pruned")
        self.assertEqual(tree.nodes["c2"].status, "pruned")
        self.assertTrue(all(tree.nodes[c].reflection for c in ("c1", "c2")))

    def test_stranded_child_does_not_steal_another_waves_step(self):
        # A leftover executing child from a prior wave (metasploit) plus the new
        # wave [curl, httpx]. tool_name matching must pair curl<->curl and
        # httpx<->httpx, and reset the stranded metasploit child, with NO skew.
        tree = _tree([("stray", "metasploit_console"),
                      ("c1", "execute_curl"), ("c2", "execute_httpx")])
        state = {"current_phase": "exploitation", "_reject_tool": False,
                 "_current_plan": _plan(_step("execute_curl", "curl-out", "application_4xx"),
                                        _step("execute_httpx", "httpx-out", "success"))}
        analysis = {"exploit_succeeded": False, "per_step": [], "productivity": {"verdict": "new_info"}}
        lats._evaluate_wave(tree, state, analysis)
        self.assertEqual(tree.nodes["stray"].status, "proposed")     # reset, not stranded
        self.assertEqual(tree.nodes["c1"].error_class, "application_4xx")  # got ITS OWN step
        self.assertEqual(tree.nodes["c2"].error_class, "success")
        self.assertEqual(tree.nodes["c1"].observation_summary[:4], "curl")
        self.assertIn("httpx", tree.nodes["c2"].observation_summary)


class TestResetTriggers(unittest.TestCase):
    """`_reset_reasons` must DETECT every §20.6 invalidation trigger (each
    empty-guarded so a transient blank never counts), and `_lats_should_reset`
    must DEBOUNCE it: a genuine change resets only after LATS_RESET_DEBOUNCE
    consecutive turns; task_complete is immediate."""

    def setUp(self):
        project_settings._settings = dict(project_settings.DEFAULT_AGENT_SETTINGS)

    def tearDown(self):
        project_settings._settings = None

    def _tree(self, **over):
        t = ExploitTree(root_id="root", nodes={"root": ExploitTreeNode(id="root")},
                        objective="admin takeover", attack_path_type="sql_injection",
                        primary_target="http://t")
        for k, v in over.items():
            setattr(t, k, v)
        return t

    def _state(self, **over):
        s = {
            "task_complete": False,
            "current_phase": "exploitation",
            "conversation_objectives": [{"objective": "admin takeover"}],
            "current_objective_index": 0,
            "attack_path_type": "sql_injection",
            "target_info": {"primary_target": "http://t"},
            "chain_findings_memory": [],
        }
        s.update(over)
        return s

    # ---- detection (empty-guarded), via _reset_reasons ----
    def test_no_reason_when_stable(self):
        self.assertEqual(lats._reset_reasons(self._state(), self._tree()), [])

    def test_reason_phase_left(self):
        self.assertIn("phase_left", lats._reset_reasons(self._state(current_phase="informational"), self._tree()))

    def test_reason_objective_change(self):
        s = self._state(conversation_objectives=[{"objective": "different goal"}])
        self.assertIn("objective_changed", lats._reset_reasons(s, self._tree()))

    def test_reason_skill_switch(self):
        s = self._state(attack_path_type="xss")   # switched from sql_injection
        self.assertIn("skill_switch", lats._reset_reasons(s, self._tree()))

    def test_reason_target_change(self):
        s = self._state(target_info={"primary_target": "http://other"})
        self.assertIn("target_change", lats._reset_reasons(s, self._tree()))

    def test_blank_live_values_are_not_reasons(self):
        # The systemic false-reset: a transient empty live value must NOT count.
        for over in (dict(current_phase=""),
                     dict(attack_path_type=""),
                     dict(conversation_objectives=[], current_objective_index=0),
                     dict(target_info={"primary_target": ""})):
            self.assertEqual(lats._reset_reasons(self._state(**over), self._tree()), [],
                             f"blank live value {over} must not be a reset reason")

    def test_already_exploited_gated_off_by_default(self):
        s = self._state(chain_findings_memory=[{"finding_type": "access_gained"}])
        self.assertNotIn("already_exploited", lats._reset_reasons(s, self._tree()))
        project_settings._settings["LATS_STOP_ON_FOOTHOLD"] = True
        self.assertIn("already_exploited", lats._reset_reasons(s, self._tree()))

    # ---- decision (debounced), via _lats_should_reset ----
    def test_task_complete_resets_immediately(self):
        self.assertTrue(lats._lats_should_reset(self._state(task_complete=True), self._tree()))

    def test_genuine_change_debounced_then_resets(self):
        s = self._state(attack_path_type="xss")   # real skill switch, held
        tree = self._tree()
        self.assertFalse(lats._lats_should_reset(s, tree), "turn 1: within debounce")
        self.assertTrue(lats._lats_should_reset(s, tree), "turn 2 (held): reset")

    def test_reverting_blip_never_resets(self):
        tree = self._tree()
        s = self._state()
        s["attack_path_type"] = "xss"                        # turn 1: differs
        self.assertFalse(lats._lats_should_reset(s, tree))   # streak 1
        s["attack_path_type"] = "sql_injection"              # turn 2: reverted
        self.assertFalse(lats._lats_should_reset(s, tree))   # streak cleared
        s["attack_path_type"] = "xss"                        # turn 3: differs again
        self.assertFalse(lats._lats_should_reset(s, tree))   # streak 1, no reset


class TestObjectiveOf(unittest.TestCase):
    """Regression for the live-run bug: ConversationObjective stores the request
    in `content`, so _objective_of must read that (an empty objective silently
    broke the card label AND the objective-change reset trigger)."""

    def test_reads_content_field(self):
        state = {"conversation_objectives": [{"content": "recover the flag"}],
                 "current_objective_index": 0}
        self.assertEqual(lats._objective_of(state), "recover the flag")

    def test_objective_change_reset_now_fires(self):
        project_settings._settings = dict(project_settings.DEFAULT_AGENT_SETTINGS)
        try:
            tree = ExploitTree(root_id="root", nodes={"root": ExploitTreeNode(id="root")},
                               objective="recover the flag", attack_path_type="sql_injection",
                               primary_target="http://t")
            # objective advanced to a different content -> reset condition detected
            # (the debounced decision then fires after LATS_RESET_DEBOUNCE turns).
            state = {
                "task_complete": False, "current_phase": "exploitation",
                "conversation_objectives": [{"content": "different goal"}],
                "current_objective_index": 0, "attack_path_type": "sql_injection",
                "target_info": {"primary_target": "http://t"}, "chain_findings_memory": [],
            }
            self.assertIn("objective_changed", lats._reset_reasons(state, tree))
        finally:
            project_settings._settings = None


if __name__ == "__main__":
    unittest.main()
