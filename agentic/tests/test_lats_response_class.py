"""W4 — Response-class engine (LLM-classified, 24-class taxonomy, ALWAYS ON).

The THINK-LLM classifies every probe with a `response_class` from a 24-class
app-semantic taxonomy; LATS maps each class to a per-node value (lats._RC_SCORES,
grounded in oracle strength) and an actionable reflection, so a bypassable input
filter (e.g. an SSTI blacklist) scores above the prune floor and is kept alive
instead of pruned like a dead endpoint. There is NO deterministic/regex
classifier and NO on/off toggle: classification always runs. The legacy
verdict/error_class formula survives only as the per-probe fallback for when the
LLM abstains (returns no valid class on that one probe).

Coverage:
  1. Resolution: _response_class_for reads PerStepAnalysis.response_class (keyed
     by _step_index), falls back to a step-level field, and rejects any label
     outside the 24 (=> "" => legacy fallback for that probe).
  2. Scores: each of the 24 classes maps to its _RC_SCORES value; exploit success
     still wins (1.0); a transport/parse failure short-circuits to 0.15 BEFORE the
     class is consulted (infra stays on error_class).
  3. Abstain: when the LLM returns "" / "inconclusive", the probe scores by the
     legacy verdict/error_class formula.
  4. Prune: above-floor classes survive, below-floor classes prune with NO
     exemption special-case; recognized classes carry the actionable reflection.
  5. XBEN_2 replay through _evaluate_wave (filter_blacklist survives).
  6. Invariants (24 classes, reflections cover all, bounds, floor partition, no
     regex/toggle symbols survive), robustness, schema + prompt wiring, no toggle.

Pure unittest; runs in the agent container.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import project_settings  # noqa: E402
from orchestrator_helpers import lats  # noqa: E402
from state import ExploitTree, ExploitTreeNode, PerStepAnalysis  # noqa: E402

PRUNE_FLOOR = 0.15


def _step(tool_name="execute_curl", error_class="application_4xx", step_index=0, **extra):
    # tool_output is irrelevant now (the LLM classifies, code never reads the body).
    s = {"tool_name": tool_name, "tool_output": "body text the code no longer parses",
         "error_class": error_class, "duration_ms": 100, "step_id": f"s{step_index}",
         "_step_index": step_index}
    s.update(extra)
    return s


def _ps(step_index=0, response_class="", verdict="blocked", finding="", confidence=0,
        exploit_succeeded=False):
    return {"step_index": step_index, "response_class": response_class, "verdict": verdict,
            "finding": finding, "confidence": confidence, "exploit_succeeded": exploit_succeeded}


def _analysis(per_step=None, verdict="blocked", **kw):
    a = {"per_step": per_step if per_step is not None else [],
         "productivity": {"verdict": verdict}}
    a.update(kw)
    return a


class TestClassResolution(unittest.TestCase):
    def test_per_step_class_resolved_by_index(self):
        step = _step(step_index=2)
        a = _analysis([_ps(2, "waf_block")])
        self.assertEqual(lats._response_class_for(step, a), "waf_block")

    def test_step_level_fallback(self):
        step = _step(step_index=0, response_class="error_leak")
        self.assertEqual(lats._response_class_for(step, _analysis([])), "error_leak")

    def test_unknown_label_becomes_empty(self):
        a = _analysis([_ps(0, "totally_made_up")])
        self.assertEqual(lats._response_class_for(_step(step_index=0), a), "")

    def test_inconclusive_becomes_empty(self):
        a = _analysis([_ps(0, "inconclusive")])
        self.assertEqual(lats._response_class_for(_step(step_index=0), a), "")

    def test_absent_becomes_empty(self):
        self.assertEqual(lats._response_class_for(_step(), _analysis([])), "")

    def test_step_none_safe(self):
        self.assertEqual(lats._response_class_for(None, _analysis([])), "")


class TestClassScores(unittest.TestCase):
    """Classification is always on; each class maps straight to its score."""

    def test_every_class_maps_to_its_score(self):
        for cls, score in lats._RC_SCORES.items():
            step = _step(step_index=0, error_class="application_4xx")
            a = _analysis([_ps(0, cls)])
            self.assertAlmostEqual(lats._lats_value_web(step, a), score, places=6,
                                   msg=f"class {cls}")

    def test_exploit_success_beats_class(self):
        step = _step(step_index=0, error_class="application_4xx")
        a = _analysis([_ps(0, "dead_endpoint", exploit_succeeded=True)])
        self.assertEqual(lats.lats_value(step, a, phase="exploitation"), 1.0)

    def test_diagnostic_failure_short_circuits_before_class(self):
        step = _step(step_index=0, error_class="application_5xx_fast")
        a = _analysis([_ps(0, "exploit_confirmed")])
        self.assertAlmostEqual(lats._lats_value_web(step, a), 0.15, places=6)


class TestLlmAbstainFallback(unittest.TestCase):
    """When the LLM returns no valid class on a probe, that probe scores by the
    legacy verdict/error_class formula (graceful degradation, not a mode)."""

    def _legacy(self, step, a):
        ec = step.get("error_class", "")
        verdict = lats._verdict_for(step, a)
        if lats.is_diagnostic_failure(ec):
            return 0.15
        v = 0.5 * (lats._new_finding_confidence(step, a, True) / 100.0)
        if verdict in ("new_info", "diagnostic_progress"):
            v += 0.3
        if ec == "application_5xx_normal":
            v += 0.2
        if verdict == "confirmation":
            v += 0.1
        if verdict in ("blocked", "duplicate", "no_progress"):
            v -= 0.3
        if ec == "application_4xx":
            v -= 0.2
        return max(0.0, v)

    def test_empty_and_inconclusive_use_legacy_over_matrix(self):
        for abstain in ("", "inconclusive"):
            for ec in ("application_4xx", "application_5xx_normal", "success",
                       "transport_error"):
                for vd in ("new_info", "confirmation", "blocked", "duplicate",
                           "no_progress", "diagnostic_progress"):
                    step = _step(step_index=0, error_class=ec)
                    a = _analysis([_ps(0, abstain, verdict=vd)], verdict=vd)
                    self.assertAlmostEqual(lats._lats_value_web(step, a),
                                           self._legacy(step, a), places=6,
                                           msg=f"abstain={abstain!r} ec={ec} vd={vd}")


class TestReflection(unittest.TestCase):
    def test_class_reflections_are_actionable(self):
        self.assertIn("mutation", lats._RC_REFLECTIONS["filter_blacklist"].lower())
        self.assertIn("abandon", lats._RC_REFLECTIONS["dead_endpoint"].lower())

    def test_legacy_reflect_is_fallback_only(self):
        # _reflect is legacy-only (no response_class kwarg); used when no class
        r = lats._reflect(_step(error_class="application_4xx"), _analysis([]))
        self.assertEqual(r, "server rejected the probe (auth / WAF / method)")


# --- Integration through _evaluate_wave ------------------------------------
def _wave(tool_names):
    root = ExploitTreeNode(id="root", status="evaluated", depth=0)
    tree = ExploitTree(root_id="root", nodes={"root": root})
    for i, tool in enumerate(tool_names):
        cid = f"c{i}"
        tree.nodes[cid] = ExploitTreeNode(id=cid, parent_id="root", depth=1,
                                          status="executing", tool_name=tool)
        root.children.append(cid)
    return tree, root


class TestEvaluateWaveClassBehavior(unittest.TestCase):
    def _run(self, response_class, error_class="application_4xx", verdict="blocked"):
        tree, _ = _wave(["execute_curl"])
        state = {"current_phase": "exploitation", "_reject_tool": False,
                 "_current_plan": {"steps": [_step(tool_name="execute_curl",
                                                   error_class=error_class, step_index=0,
                                                   verdict=verdict)]}}
        a = _analysis([_ps(0, response_class, verdict=verdict)], verdict=verdict)
        lats._evaluate_wave(tree, state, a)
        return tree.nodes["c0"]

    def test_filter_blacklist_survives_and_scores(self):
        c = self._run("filter_blacklist")
        self.assertEqual(c.response_class, "filter_blacklist")
        self.assertAlmostEqual(c.local_value, lats._RC_SCORES["filter_blacklist"], places=6)
        self.assertEqual(c.status, "evaluated")             # above the prune floor
        self.assertIn("mutation", c.reflection.lower())

    def test_dead_endpoint_pruned_with_actionable_reflection(self):
        c = self._run("dead_endpoint")
        self.assertLess(c.local_value, PRUNE_FLOOR)
        self.assertEqual(c.status, "pruned")
        self.assertIn("abandon", c.reflection.lower())

    def test_abstain_falls_back_to_legacy_prune(self):
        # LLM gave no class on this probe -> legacy scoring -> pruned with legacy text
        c = self._run("inconclusive")
        self.assertEqual(c.response_class, "")
        self.assertEqual(c.status, "pruned")
        self.assertEqual(c.reflection, "server rejected the probe (auth / WAF / method)")


class TestCreditedChildStable(unittest.TestCase):
    """Aggregate credit still ranks on the legacy value, never the class score."""

    def test_credit_ignores_class_score(self):
        c1 = ExploitTreeNode(id="c1", parent_id="root", depth=1, tool_name="execute_curl")
        c2 = ExploitTreeNode(id="c2", parent_id="root", depth=1, tool_name="execute_httpx")
        s1 = _step(tool_name="execute_curl", error_class="application_4xx", step_index=0,
                   verdict="blocked")
        s2 = _step(tool_name="execute_httpx", error_class="application_5xx_fast", step_index=1,
                   verdict="no_progress")
        # NO per_step -> _credited_child ranks by legacy value (c2 0.15 > c1 0.0)
        credited = lats._credited_child([(c1, s1), (c2, s2)], _analysis([]))
        self.assertEqual(credited.id, "c2")


class TestInvariants(unittest.TestCase):
    def test_24_classes(self):
        self.assertEqual(len(lats._RC_SCORES), 24)
        self.assertEqual(set(lats.RESPONSE_CLASSES), set(lats._RC_SCORES))

    def test_every_class_has_a_reflection(self):
        self.assertEqual(set(lats._RC_REFLECTIONS), set(lats._RC_SCORES))

    def test_scores_bounded_and_floor_partition(self):
        for cls, s in lats._RC_SCORES.items():
            self.assertGreaterEqual(s, 0.0, cls)
            self.assertLessEqual(s, 1.0, cls)
        above = {"exploit_confirmed", "oob_callback", "error_leak", "outbound_fetch",
                 "boolean_differential", "info_disclosure", "time_differential",
                 "reflected_unsanitized", "partial_filter_bypass", "server_error_5xx",
                 "encoding_normalization", "filter_blacklist", "waf_block",
                 "privilege_required", "wrong_method", "wrong_content_type",
                 "auth_required", "rate_limited", "size_limit"}
        below = {"filter_whitelist", "geo_legal_block", "benign_no_signal",
                 "dead_endpoint", "duplicate"}
        self.assertEqual(above | below, set(lats._RC_SCORES))
        for c in above:
            self.assertGreaterEqual(lats._RC_SCORES[c], PRUNE_FLOOR, c)
        for c in below:
            self.assertLess(lats._RC_SCORES[c], PRUNE_FLOOR, c)

    def test_no_regex_or_toggle_symbols_survive(self):
        for gone in ("_classify_response_code", "_rc_http_status", "_llm_response_class",
                     "_RC_LEAD_MARKERS", "_RC_AUTH_MARKERS", "_RC_WAF_MARKERS",
                     "_RC_INPUT_FILTER_MARKERS", "_RC_DEAD_MARKERS", "_RC_HTTP_CODE_RE",
                     "_RC_DELTA_KEYS", "_response_class_delta", "_response_class_enabled"):
            self.assertFalse(hasattr(lats, gone), f"{gone} should be removed")


class TestRobustness(unittest.TestCase):
    def test_value_bounded_over_matrix(self):
        for cls in list(lats._RC_SCORES) + ["", "inconclusive"]:
            for ec in ("application_4xx", "application_5xx_normal", "success",
                       "transport_error"):
                v = lats._lats_value_web(_step(step_index=0, error_class=ec),
                                         _analysis([_ps(0, cls)]))
                self.assertGreaterEqual(v, 0.0)
                self.assertLessEqual(v, 1.0)

    def test_pydantic_per_step_object(self):
        import types as _t
        ps = _t.SimpleNamespace(step_index=0, response_class="waf_block", verdict="blocked",
                                finding="", confidence=0, exploit_succeeded=False)
        a = _t.SimpleNamespace(per_step=[ps], exploit_succeeded=False, chain_findings=[],
                               productivity=_t.SimpleNamespace(verdict="blocked"))
        self.assertEqual(lats._response_class_for(_step(step_index=0), a), "waf_block")


class TestSchemaAndPrompt(unittest.TestCase):
    def test_no_toggle_setting(self):
        d = project_settings.DEFAULT_AGENT_SETTINGS
        self.assertNotIn("LATS_RESPONSE_CLASS_ENABLED", d)      # classification is unconditional
        self.assertFalse([k for k in d if k.startswith("LATS_RC_DELTA")])

    def test_per_step_schema_has_response_class(self):
        self.assertEqual(PerStepAnalysis().response_class, "")
        self.assertEqual(PerStepAnalysis(response_class="error_leak").response_class,
                         "error_leak")

    def test_taxonomy_prompt_block_present(self):
        from prompts import RESPONSE_CLASS_TAXONOMY_BLOCK as blk
        self.assertIn("per_step", blk)
        self.assertIn("response_class", blk)
        for cls in ("exploit_confirmed", "filter_blacklist", "dead_endpoint",
                    "inconclusive"):
            self.assertIn(cls, blk)


class TestReflectionConditionedExpansion(unittest.TestCase):
    """When LATS grows children FROM a node, the node's response_class dictates
    what the next wave must contain (the move that converts the lead), replacing
    the generic 'pivot if blocked' fan-out."""

    def _tree_node(self, **kw):
        root = ExploitTreeNode(id="root", status="evaluated", depth=0)
        n = ExploitTreeNode(id="c1", parent_id="root", depth=1, status="evaluated",
                            tool_name="execute_curl", tool_args={"args": "x?p={{7*7}}"},
                            observation_summary="Invalid character in input", **kw)
        tree = ExploitTree(root_id="root", nodes={"root": root, "c1": n})
        root.children.append("c1")
        return tree, n

    def _user(self, node, tree):
        msgs = lats._expand_prompt_messages(
            {"current_phase": "exploitation", "objective": "reach the flag",
             "attack_path_type": "", "target_info": {"primary_target": "t"}},
            node, {"execute_curl"}, 6, tree)
        return msgs[1]["content"]

    def test_directives_cover_exactly_the_survivable_classes(self):
        above = {c for c, s in lats._RC_SCORES.items() if s >= PRUNE_FLOOR}
        self.assertEqual(set(lats._RC_EXPAND_DIRECTIVES), above)

    def test_directive_keys_are_valid_classes(self):
        self.assertTrue(set(lats._RC_EXPAND_DIRECTIVES).issubset(lats.RESPONSE_CLASSES))

    def test_filter_blacklist_node_gets_bypass_directive(self):
        tree, n = self._tree_node(response_class="filter_blacklist",
                                  reflection=lats._RC_REFLECTIONS["filter_blacklist"])
        u = self._user(n, tree)
        self.assertIn("`filter_blacklist`", u)        # the class is named
        self.assertIn("MUTATED", u)                   # the bypass directive
        self.assertIn("Do NOT pivot", u)
        self.assertIn("Lesson:", u)                   # the reflection is surfaced
        self.assertIn("[filter_blacklist]", u)        # rich tag, not the coarse verdict
        self.assertNotIn("pivot if blocked", u)       # generic ask was replaced

    def test_error_leak_node_gets_extraction_directive(self):
        tree, n = self._tree_node(response_class="error_leak",
                                  reflection=lats._RC_REFLECTIONS["error_leak"])
        u = self._user(n, tree)
        self.assertIn("`error_leak`", u)
        self.assertIn("EXTRACTION", u)

    def test_unclassified_node_falls_back_to_generic_ask(self):
        tree, n = self._tree_node(response_class="", verdict="blocked")
        u = self._user(n, tree)
        self.assertIn("pivot if blocked", u)          # generic fallback preserved
        self.assertNotIn("was classified", u)

    def test_render_path_shows_response_class(self):
        tree, n = self._tree_node(response_class="filter_blacklist")
        self.assertIn("[filter_blacklist]", lats._render_path(tree, n))

    def test_root_expansion_has_no_directive(self):
        tree, _ = self._tree_node(response_class="filter_blacklist")
        msgs = lats._expand_prompt_messages(
            {"current_phase": "exploitation", "objective": "o", "attack_path_type": "",
             "target_info": {}}, None, {"execute_curl"}, 6, tree)
        u = msgs[1]["content"]
        self.assertIn("entry probes", u)              # root fan-out ask
        self.assertNotIn("was classified", u)


if __name__ == "__main__":
    unittest.main(verbosity=2)
