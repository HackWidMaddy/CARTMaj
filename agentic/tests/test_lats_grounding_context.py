"""LATS lean grounding context (expand-step) coverage.

The expand step of the value-guided exploit-path search must propose CORRECT
probes. A probe is "correct" when it:
  (a) hits a REAL target        -> grounding (chain_context + target_info)
  (b) uses the RIGHT technique  -> active built-in skill WORKFLOW
  (c) is EXECUTABLE             -> tool arg schema (system message)
  (d) doesn't repeat dead ends  -> failures / prior-tree deltas
  (e) stays in scope            -> Rules of Engagement

This file proves the context assembled for expand carries exactly that
minimal-but-complete set, and NOT the think-node bookkeeping we deliberately
excluded to keep the prompt lean (the full ~22k tool-inventory docs, the
switchable skill menu, phase definitions, and todo/qa/objective history) —
none of which change which probe is right.

It also covers the behavior-preserving extraction of
``build_builtin_skill_workflow`` out of ``get_phase_tools`` — the split that
lets LATS get the class technique playbook WITHOUT the tool-inventory bulk.

Run (inside the agent image, deps + DB fallback available):
    python -m pytest tests/test_lats_grounding_context.py -q
"""

from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import project_settings  # noqa: E402
from orchestrator_helpers import lats  # noqa: E402
from prompts import build_builtin_skill_workflow, get_phase_tools  # noqa: E402


# --------------------------------------------------------------------------- #
# helpers                                                                      #
# --------------------------------------------------------------------------- #
def _settings(**over):
    s = dict(project_settings.DEFAULT_AGENT_SETTINGS)
    s["LATS_ENABLED"] = True
    s["LATS_FULL_CONTEXT"] = True
    s["LATS_CONTEXT_WINDOW"] = 12
    s.update(over)
    return s


# A state carrying a REAL discovered surface: the /ping?host= endpoint and the
# "host param reflected" finding exist ONLY in the execution trace / chain
# memory — never in target_info.endpoints. That is the grounding acid test:
# the expand context must surface what the agent actually did, not just the
# (often empty) structured recon fields.
def _grounded_state(**over):
    st = {
        "current_phase": "exploitation",
        "attack_path_type": "rce",
        # Canonical execution_trace item schema (tool_name / tool_args / tool_output)
        # -- the keys format_chain_context actually renders. The /ping?host=
        # endpoint lives ONLY here, never in target_info.endpoints.
        "execution_trace": [
            {
                "tool_name": "execute_curl",
                "tool_args": {"args": "-s 'http://target/ping?host=127.0.0.1'"},
                "tool_output": "PING host=127.0.0.1 reflected in command output",
                "success": True,
                "iteration": 4,
                "phase": "exploitation",
            },
        ],
        "target_info": {
            "primary_target": "http://target",
            "technologies": ["PHP/7.4.33", "nginx/1.31.1"],
        },
        "chain_findings_memory": [
            {"title": "reflected host param on /ping", "finding_type": "param",
             "severity": "info", "step_iteration": 4,
             "evidence": "host param on /ping reflected in command output"},
        ],
        "chain_failures_memory": [
            {"failure_type": "blocked", "step_iteration": 3,
             "error_message": "/admin returned 403 (dead end)",
             "description": "/admin returned 403 (dead end)"},
        ],
        "chain_decisions_memory": [],
    }
    st.update(over)
    return st


# Content markers that ONLY the excluded think-node blocks produce.
EXCLUDED_HEADERS = [
    "## Todo list",
    "## Q&A history",
    "## Prior-session context",
]


class _SettingsCtx(unittest.TestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None


# --------------------------------------------------------------------------- #
# 1. build_builtin_skill_workflow — behavior-preserving extraction             #
# --------------------------------------------------------------------------- #
class TestSkillWorkflowExtraction(_SettingsCtx):
    def test_rce_workflow_nonempty_and_carries_payload_reference(self):
        wf = build_builtin_skill_workflow("rce", ["kali_shell", "execute_curl"])
        self.assertTrue(wf, "rce should produce a workflow when kali_shell is allowed")
        joined = "\n".join(wf).upper()
        self.assertIn("PAYLOAD", joined, "workflow must carry the class payload technique")

    def test_unknown_class_returns_empty(self):
        self.assertEqual(build_builtin_skill_workflow("not_a_real_class", ["kali_shell"]), [])

    def test_missing_required_tool_gates_off(self):
        # rce requires kali_shell; without it the workflow must NOT be emitted
        # (gating preserved through the extraction).
        self.assertEqual(build_builtin_skill_workflow("rce", ["execute_curl"]), [])

    def test_parity_get_phase_tools_still_contains_the_workflow(self):
        """The split must not change what the THINK node gets: every part the
        standalone builder returns must still appear verbatim inside the full
        get_phase_tools exploitation prompt."""
        from project_settings import get_allowed_tools_for_phase
        allowed = get_allowed_tools_for_phase("exploitation")
        wf = build_builtin_skill_workflow("rce", allowed, execution_trace=[])
        self.assertTrue(wf)
        full = get_phase_tools("exploitation", attack_path_type="rce", execution_trace=[])
        for part in wf:
            # compare on a stable head slice (the parts are .format()-ed the same way)
            self.assertIn(part[:200], full,
                          "get_phase_tools lost a skill-workflow part after the extraction")


# --------------------------------------------------------------------------- #
# 2. _full_think_context — the lean set (includes / excludes / grounding)      #
# --------------------------------------------------------------------------- #
class TestLeanFullThinkContext(_SettingsCtx):
    def test_includes_the_five_lean_blocks(self):
        with patch("orchestrator_helpers.skill_loader.list_skills",
                   return_value=[{"id": "xss-deep", "description": "advanced xss"}]), \
             patch("prompts.base.build_roe_prompt_section",
                   return_value="## Rules of Engagement\nStay on http://target only."):
            ctx = lats._full_think_context(_grounded_state())
        self.assertIn("## Attack-chain so far", ctx)          # (a) grounding
        self.assertIn("## Target info", ctx)                   # (a) grounding
        self.assertIn("Rules of Engagement", ctx)              # (e) scope
        self.assertIn("## Active attack-skill workflow", ctx)  # (b) technique
        self.assertIn("## Available Agent/Chat skills", ctx)   # (b) specialist technique

    def test_grounds_on_real_endpoint_from_execution_trace(self):
        """The acid test: /ping?host= lives ONLY in the execution trace, never in
        target_info.endpoints. The context must surface it so expand probes the
        REAL surface instead of hallucinating one."""
        ctx = lats._full_think_context(_grounded_state())
        self.assertIn("/ping", ctx)
        self.assertIn("host=127.0.0.1", ctx)
        self.assertIn("reflected", ctx)

    def test_surfaces_failed_dead_ends_for_dedup(self):
        # (d) don't repeat: the /admin 403 dead end must be visible.
        ctx = lats._full_think_context(_grounded_state())
        self.assertIn("/admin", ctx)

    def test_excludes_think_node_bookkeeping(self):
        """Todo / Q&A / prior-session blocks must NOT appear even when the state
        carries that data — they don't change which probe is right."""
        st = _grounded_state(
            todo_list=[{"status": "pending", "description": "SHOULD-NOT-APPEAR-todo"}],
            qa_history=[{"question": "SHOULD-NOT-APPEAR-q", "answer": "a"}],
            _prior_chain_context="SHOULD-NOT-APPEAR-prior",
        )
        ctx = lats._full_think_context(st)
        for header in EXCLUDED_HEADERS:
            self.assertNotIn(header, ctx)
        for leak in ("SHOULD-NOT-APPEAR-todo", "SHOULD-NOT-APPEAR-q", "SHOULD-NOT-APPEAR-prior"):
            self.assertNotIn(leak, ctx)

    def test_excludes_full_tool_inventory_but_keeps_workflow(self):
        """The lean context must be materially smaller than the full
        get_phase_tools (which bundles the ~22k tool-inventory docs), while
        still carrying the skill workflow. Proves we split the playbook from the
        inventory rather than shipping everything."""
        st = _grounded_state()
        ctx = lats._full_think_context(st)
        full = get_phase_tools("exploitation", attack_path_type="rce", execution_trace=[])
        # workflow present in both
        self.assertIn("## Active attack-skill workflow", ctx)
        # the lean context is a real reduction vs the full inventory prompt
        self.assertLess(len(ctx), len(full),
                        "lean context should be smaller than the full tool-inventory prompt")
        # the per-tool inventory header get_phase_tools renders must be absent here
        from prompts.base import build_informational_tool_descriptions
        from project_settings import get_allowed_tools_for_phase
        inv = build_informational_tool_descriptions(get_allowed_tools_for_phase("exploitation"))
        # a distinctive head slice of the inventory block must not be in the lean ctx
        if inv.strip():
            self.assertNotIn(inv.strip()[:120], ctx,
                             "full tool-inventory docs leaked into the lean context")

    def test_disabling_full_context_yields_empty(self):
        project_settings._settings = _settings(LATS_FULL_CONTEXT=False)
        # _full_think_context itself is unconditional; the gate lives in
        # _situational_context. Assert the gate there:
        st = _grounded_state()
        sit = lats._situational_context(st)
        self.assertNotIn("## Attack-chain so far", sit,
                         "full context must not be prepended when LATS_FULL_CONTEXT is off")


# --------------------------------------------------------------------------- #
# 3. _situational_context — composition (full context + LATS deltas)           #
# --------------------------------------------------------------------------- #
class TestSituationalComposition(_SettingsCtx):
    def test_full_context_leads_then_lats_deltas(self):
        sit = lats._situational_context(_grounded_state())
        self.assertIn("## Attack-chain so far", sit)   # lean context leads
        self.assertIn("## LATS deltas", sit)           # deltas follow
        # ordering: grounding before deltas
        self.assertLess(sit.index("## Attack-chain so far"), sit.index("## LATS deltas"))

    def test_deltas_carry_failed_dead_ends(self):
        sit = lats._situational_context(_grounded_state())
        self.assertIn("do not repeat these dead ends", sit.lower().replace("do not", "do not"))


# --------------------------------------------------------------------------- #
# 4. _expand_prompt_messages — grounding + technique + executability reach LLM  #
# --------------------------------------------------------------------------- #
class TestExpandPromptGrounding(_SettingsCtx):
    def test_seed_expand_carries_all_five_requirements(self):
        allowed = {"execute_curl", "kali_shell"}
        msgs = lats._expand_prompt_messages(_grounded_state(), node=None,
                                            allowed_tools=allowed, branching=6, tree=None)
        self.assertEqual(msgs[0]["role"], "system")
        self.assertEqual(msgs[1]["role"], "user")
        system, user = msgs[0]["content"], msgs[1]["content"]

        # (c) EXECUTABLE — arg schema is in the system message
        self.assertIn("tool_args", system)
        self.assertIn("execute_curl", system)

        # (a) grounding — the real endpoint reaches the user message
        self.assertIn("/ping", user)
        self.assertIn("host=127.0.0.1", user)

        # (b) technique — the skill workflow / methodology reaches the user message
        self.assertIn("## Active attack-skill workflow", user)

        # (d) dedup — failed dead ends visible
        self.assertIn("/admin", user)

        # width intent honored
        self.assertIn("6", system)


# --------------------------------------------------------------------------- #
# 5. Probe dedup - hard cross-tree/within-batch dedup + conservative key         #
# --------------------------------------------------------------------------- #
class TestProbeDedup(_SettingsCtx):
    def _probes_json(self, *pairs):
        import json as _json
        return _json.dumps({"probes": [
            {"tool_name": tn, "tool_args": {"args": a}, "rationale": "x"} for tn, a in pairs
        ]})

    def test_key_collapses_only_byte_identical_not_distinct_payloads(self):
        # The regression the 36%-false-positive taught us: different files on the
        # SAME lfi vector must stay DISTINCT keys, only identical probes collapse.
        k = lats._probe_dedup_key
        base = "-s 'http://t/post.php?id=../../../../{}'"
        self.assertNotEqual(k("execute_curl", {"args": base.format("etc/passwd")}),
                            k("execute_curl", {"args": base.format("etc/hosts")}))
        self.assertNotEqual(k("execute_curl", {"args": base.format("flag")}),
                            k("execute_curl", {"args": base.format("etc/passwd")}))
        # identical (modulo whitespace) collapse
        self.assertEqual(k("execute_curl", {"args": "-s  http://t/a"}),
                         k("execute_curl", {"args": "-s http://t/a"}))
        # same args, different tool => distinct
        self.assertNotEqual(k("execute_curl", {"args": "http://t/a"}),
                            k("kali_shell", {"args": "http://t/a"}))

    def test_parse_drops_probe_already_in_tree(self):
        existing = {lats._probe_dedup_key("execute_curl", {"args": "-s http://t/seen"})}
        out = lats._parse_expand_response(
            self._probes_json(("execute_curl", "-s http://t/seen"),
                              ("execute_curl", "-s http://t/fresh")),
            {"execute_curl"}, 6, existing_keys=existing)
        args = [p["tool_args"]["args"] for p in out]
        self.assertNotIn("-s http://t/seen", args, "re-proposal of a tree probe must be HARD-dropped")
        self.assertIn("-s http://t/fresh", args)

    def test_parse_drops_within_batch_duplicate(self):
        out = lats._parse_expand_response(
            self._probes_json(("execute_curl", "-s http://t/dup"),
                              ("execute_curl", "-s http://t/dup"),
                              ("execute_curl", "-s http://t/other")),
            {"execute_curl"}, 6, existing_keys=set())
        args = [p["tool_args"]["args"] for p in out]
        self.assertEqual(args.count("-s http://t/dup"), 1, "a probe repeated in one response is emitted once")
        self.assertIn("-s http://t/other", args)

    def test_parse_keeps_distinct_lfi_payloads(self):
        # No false dedup: exhaustive enumeration of one vector survives intact.
        base = "-s 'http://t/post.php?id=../../../../{}'"
        out = lats._parse_expand_response(
            self._probes_json(("execute_curl", base.format("etc/passwd")),
                              ("execute_curl", base.format("etc/hosts")),
                              ("execute_curl", base.format("flag"))),
            {"execute_curl"}, 6, existing_keys=set())
        self.assertEqual(len(out), 3, "distinct LFI files must all survive dedup")

    def test_existing_probe_keys_is_uncapped(self):
        # Build a tree with 45 probe-nodes; the key set must cover all of them,
        # unlike the readability-capped _existing_probes render.
        from state import ExploitTree, ExploitTreeNode
        tree = ExploitTree(root_id="root", objective="x")
        tree.nodes["root"] = ExploitTreeNode(id="root", parent_id=None, depth=0)
        for i in range(45):
            tree.nodes[f"n{i}"] = ExploitTreeNode(
                id=f"n{i}", parent_id="root", depth=1,
                tool_name="execute_curl", tool_args={"args": f"-s http://t/p{i}"})
        keys = lats._existing_probe_keys(tree)
        self.assertEqual(len(keys), 45, "dedup key set must be uncapped (covers deep trees)")
        # and a probe at index 40 (beyond the old cap of 20) is still blocked
        blocked = lats._probe_dedup_key("execute_curl", {"args": "-s http://t/p40"})
        self.assertIn(blocked, keys)


# --------------------------------------------------------------------------- #
# 6. Cross-tree probe ledger - HARD dedup ACROSS trees (§3 continuity fix)       #
# --------------------------------------------------------------------------- #
class TestCrossTreeProbeLedger(_SettingsCtx):
    def _tree(self, probes):
        """Build a one-level tree. `probes` = list of (args, status)."""
        from state import ExploitTree, ExploitTreeNode
        t = ExploitTree(root_id="root", objective="recover the flag")
        t.nodes["root"] = ExploitTreeNode(id="root", parent_id=None, depth=0)
        for i, (a, st) in enumerate(probes):
            t.nodes[f"n{i}"] = ExploitTreeNode(
                id=f"n{i}", parent_id="root", depth=1,
                tool_name="execute_curl", tool_args={"args": a}, status=st)
        return t

    def _k(self, args):
        return lats._probe_dedup_key("execute_curl", {"args": args})

    def test_completion_harvests_executed_probes_only(self):
        state = {}
        t = self._tree([("-s http://t/ran", "evaluated"),
                        ("-s http://t/pruned", "pruned"),
                        ("-s http://t/never", "proposed")])
        lats._append_tree_digest(state, t, "branch_collapsed")
        ledger = set(state.get("_lats_probe_ledger") or [])
        self.assertIn(self._k("-s http://t/ran"), ledger)
        self.assertIn(self._k("-s http://t/pruned"), ledger)      # pruned = it ran, then lost
        self.assertNotIn(self._k("-s http://t/never"), ledger,
                         "an untried (proposed) probe must NOT enter the ledger - a later tree may still want to run it")

    def test_digest_still_populated_no_regression(self):
        state = {}
        lats._append_tree_digest(state, self._tree([("-s http://t/a", "evaluated")]), "branch_collapsed")
        self.assertTrue(state.get("_lats_tree_digest"), "soft digest must still be written alongside the ledger")

    def test_ledger_accumulates_and_dedups_across_trees(self):
        state = {}
        lats._append_tree_digest(state, self._tree([("-s http://t/a", "evaluated")]), "reset")
        lats._append_tree_digest(state, self._tree([("-s http://t/a", "evaluated"),   # repeat across trees
                                                    ("-s http://t/b", "evaluated")]), "reset")
        ledger = state.get("_lats_probe_ledger") or []
        self.assertEqual(len(ledger), len(set(ledger)), "ledger must be deduped")
        self.assertEqual(set(ledger), {self._k("-s http://t/a"), self._k("-s http://t/b")})

    def test_ledger_respects_cap(self):
        project_settings._settings = _settings(LATS_PROBE_LEDGER_MAX=3)
        state = {}
        probes = [(f"-s http://t/p{i}", "evaluated") for i in range(10)]
        lats._append_tree_digest(state, self._tree(probes), "reset")
        self.assertEqual(len(state["_lats_probe_ledger"]), 3, "ledger must cap at LATS_PROBE_LEDGER_MAX")

    def test_next_tree_expand_drops_prior_tree_probe(self):
        """End-to-end mirror of what lats_expand does: union the ledger with the
        (fresh, empty) tree's keys and feed it to the parser - a probe a PRIOR
        tree ran is dropped even though the new tree shares no nodes with it."""
        import json as _json
        state = {}
        lats._append_tree_digest(state, self._tree([("-s http://t/tried", "evaluated")]), "reset")
        tree2 = self._tree([])                          # brand-new tree, no shared nodes
        existing = lats._existing_probe_keys(tree2) | set(state.get("_lats_probe_ledger") or ())
        resp = _json.dumps({"probes": [
            {"tool_name": "execute_curl", "tool_args": {"args": "-s http://t/tried"}, "rationale": "x"},
            {"tool_name": "execute_curl", "tool_args": {"args": "-s http://t/new"}, "rationale": "x"}]})
        out = lats._parse_expand_response(resp, {"execute_curl"}, 6, existing_keys=existing)
        args = [p["tool_args"]["args"] for p in out]
        self.assertNotIn("-s http://t/tried", args, "a probe a PRIOR tree already ran must be cross-tree dropped")
        self.assertIn("-s http://t/new", args)

    def test_distinct_payload_survives_cross_tree(self):
        import json as _json
        state = {}
        lats._append_tree_digest(state, self._tree([("-s 'http://t/post.php?id=../../etc/passwd'", "evaluated")]), "reset")
        existing = set(state.get("_lats_probe_ledger") or ())
        resp = _json.dumps({"probes": [
            {"tool_name": "execute_curl", "tool_args": {"args": "-s 'http://t/post.php?id=../../flag'"}, "rationale": "x"}]})
        out = lats._parse_expand_response(resp, {"execute_curl"}, 6, existing_keys=existing)
        self.assertEqual(len(out), 1, "a DIFFERENT payload on the same vector must survive cross-tree dedup")

    def test_no_ledger_means_no_cross_tree_blocking(self):
        # Baseline: with an empty/absent ledger the parser blocks nothing extra.
        import json as _json
        resp = _json.dumps({"probes": [
            {"tool_name": "execute_curl", "tool_args": {"args": "-s http://t/x"}, "rationale": "x"}]})
        out = lats._parse_expand_response(resp, {"execute_curl"}, 6, existing_keys=set())
        self.assertEqual(len(out), 1)


# --------------------------------------------------------------------------- #
# 7. Reset guard normalization - no false target_change / objective resets       #
# --------------------------------------------------------------------------- #
class TestResetNormalization(_SettingsCtx):
    def _state(self, *, target="http://lab-x", objective="recover the flag", apt="xss",
               phase="exploitation", findings=None, task_complete=False):
        return {
            "task_complete": task_complete,
            "current_phase": phase,
            "chain_findings_memory": findings or [],
            "conversation_objectives": [{"content": objective}],
            "current_objective_index": 0,
            "attack_path_type": apt,
            "target_info": {"primary_target": target},
        }

    def _tree(self, *, target="http://lab-x", objective="recover the flag", apt="xss"):
        from state import ExploitTree
        return ExploitTree(root_id="session_x:abc123", objective=objective,
                           attack_path_type=apt, primary_target=target)

    # ---- _same_target: host identity, port-lenient ----
    def test_same_target_scheme_slash_and_added_port(self):
        st = lats._same_target
        # scheme / slash jitter (XBEN-064)
        self.assertTrue(st("http://lab-444446f3/", "http://lab-444446f3"))
        self.assertTrue(st("http://lab-444446f3", "lab-444446f3"))
        self.assertTrue(st("HTTPS://Lab-444446f3/", "lab-444446f3"))
        # recon ADDS the port over the run (XBEN-066): bare host == host:port
        self.assertTrue(st("lab-ccd179d3", "lab-ccd179d3:8002"))
        self.assertTrue(st("http://lab-ccd179d3:8002/", "lab-ccd179d3"))

    def test_same_target_rejects_real_changes(self):
        st = lats._same_target
        self.assertFalse(st("http://10.0.0.9", "http://lab-x"))     # different host
        self.assertFalse(st("lab-x:8002", "lab-x:9000"))            # different explicit ports

    # ---- _reset_reasons: detection, empty-guarded (no debounce) ----
    def test_no_target_reason_on_scheme_slash_or_port_jitter(self):
        for stamped, live in [("http://lab-444446f3/", "http://lab-444446f3"),
                              ("http://lab-444446f3", "lab-444446f3"),
                              ("lab-ccd179d3", "lab-ccd179d3:8002")]:   # port added (066)
            r = lats._reset_reasons(self._state(target=live), self._tree(target=stamped))
            self.assertNotIn("target_change", r, f"{stamped!r} vs {live!r} is not a real change")

    def test_target_reason_on_real_change(self):
        r1 = lats._reset_reasons(self._state(target="http://10.0.0.9"), self._tree(target="http://lab-x"))
        self.assertIn("target_change", r1)
        r2 = lats._reset_reasons(self._state(target="http://lab-x:9000"), self._tree(target="http://lab-x:8002"))
        self.assertIn("target_change", r2)

    def test_no_objective_reason_on_whitespace(self):
        r = lats._reset_reasons(self._state(objective="  recover the flag\n"),
                                self._tree(objective="recover the flag"))
        self.assertNotIn("objective_changed", r)

    def test_empty_live_values_never_a_reason(self):
        # The systemic false-reset: a transient blank live value must NOT count.
        for over in (dict(target=""), dict(apt=""), dict(phase=""), dict(objective="")):
            r = lats._reset_reasons(self._state(**over), self._tree())
            self.assertEqual(r, [], f"blank live value {over} must produce no reset reason")

    def test_already_exploited_off_by_default_on_by_setting(self):
        s = self._state(findings=[{"finding_type": "access_gained"}])
        self.assertNotIn("already_exploited", lats._reset_reasons(s, self._tree()))
        project_settings._settings["LATS_STOP_ON_FOOTHOLD"] = True
        self.assertIn("already_exploited", lats._reset_reasons(s, self._tree()))

    # ---- _lats_should_reset: debounce behavior ----
    def test_task_complete_is_immediate(self):
        self.assertTrue(lats._lats_should_reset(self._state(task_complete=True), self._tree()))

    def test_genuine_change_debounced_then_fires(self):
        s = self._state(apt="rce")            # real skill switch, held
        tree = self._tree(apt="xss")
        self.assertFalse(lats._lats_should_reset(s, tree), "turn 1: within debounce, no reset")
        self.assertTrue(lats._lats_should_reset(s, tree), "turn 2 (held): reset")

    def test_one_turn_blip_reverts_without_reset(self):
        tree = self._tree(apt="xss")
        s = self._state(apt="xss")
        s["attack_path_type"] = "rce"                                   # turn 1: differs (blip)
        self.assertFalse(lats._lats_should_reset(s, tree))              # streak 1
        s["attack_path_type"] = "xss"                                  # turn 2: reverted
        self.assertFalse(lats._lats_should_reset(s, tree))             # streak cleared
        s["attack_path_type"] = "rce"                                  # turn 3: differs again (isolated)
        self.assertFalse(lats._lats_should_reset(s, tree))             # streak 1 again, still no reset

    def test_healthy_state_does_not_reset(self):
        self.assertFalse(lats._lats_should_reset(self._state(), self._tree()))


# --------------------------------------------------------------------------- #
# 8. Probe quality: ffuf FUZZ guard, tool cheatsheet, dynamic expansion width    #
# --------------------------------------------------------------------------- #
class TestExpandProbeQuality(_SettingsCtx):
    def _ext_tree_and_node(self):
        from state import ExploitTree, ExploitTreeNode
        tree = ExploitTree(root_id="session_x:1", objective="recover the flag")
        tree.nodes["root"] = ExploitTreeNode(id="root", parent_id=None, depth=0)
        node = ExploitTreeNode(id="n1", parent_id="root", depth=1,
                               tool_name="execute_curl", tool_args={"args": "-s http://t/a"})
        tree.nodes["n1"] = node
        return tree, node

    # ---- BUG 1a: ffuf FUZZ pre-flight guard ----
    def test_ffuf_without_fuzz_is_invalid(self):
        self.assertFalse(lats._probe_args_valid("execute_ffuf", {"args": "-w /wl -u http://h/"}))
        self.assertTrue(lats._probe_args_valid("execute_ffuf", {"args": "-w /wl -u http://h/FUZZ"}))

    def test_parse_drops_ffuf_missing_fuzz(self):
        import json as _json
        resp = _json.dumps({"probes": [
            {"tool_name": "execute_ffuf", "tool_args": {"args": "-w /wl -u http://h/"}, "rationale": "x"},
            {"tool_name": "execute_ffuf", "tool_args": {"args": "-w /wl -u http://h/FUZZ"}, "rationale": "x"}]})
        out = lats._parse_expand_response(resp, {"execute_ffuf"}, 6, existing_keys=set())
        self.assertEqual(len(out), 1, "the ffuf probe missing FUZZ must be pre-flight dropped")
        self.assertIn("FUZZ", out[0]["tool_args"]["args"])

    # ---- BUG 1b: compact tool cheatsheet ----
    def test_tool_hints_cover_failing_tools_only(self):
        h = lats._expand_tool_hints({"execute_ffuf", "execute_arjun", "execute_katana", "query_graph"})
        self.assertIn("FUZZ", h)           # ffuf
        self.assertIn("-m GET", h)         # arjun (NOT --get)
        self.assertIn("execute_katana", h)
        self.assertNotIn("query_graph", h)  # unhinted tool not padded in
        self.assertEqual(lats._expand_tool_hints({"query_graph", "web_search"}), "")

    def test_system_message_carries_cheatsheet(self):
        msgs = lats._expand_prompt_messages(_grounded_state(), None, {"execute_ffuf"}, 6, tree=None)
        self.assertIn("FUZZ", msgs[0]["content"])

    # ---- dynamic expansion width ----
    def test_root_uses_full_width(self):
        msgs = lats._expand_prompt_messages(_grounded_state(), None, {"execute_curl"}, 6, tree=None)
        user = msgs[1]["content"]
        self.assertIn("6 DISTINCT entry probes", user)
        self.assertIn("FULL WIDTH", user)

    def test_extension_uses_dynamic_range_no_padding(self):
        tree, node = self._ext_tree_and_node()
        msgs = lats._expand_prompt_messages(_grounded_state(), node, {"execute_curl"}, 6, tree=tree)
        user = msgs[1]["content"]
        self.assertIn("between 3 and 6", user)   # lo = max(3, 6//2) = 3
        self.assertIn("Do NOT pad", user)

    def test_system_drops_the_use_the_width_bias(self):
        msgs = lats._expand_prompt_messages(_grounded_state(), None, {"execute_curl"}, 6, tree=None)
        system = msgs[0]["content"]
        self.assertNotIn("aim to use the width", system)   # the old forcing phrase is gone
        self.assertIn("YOUR decision", system)             # count is now the LLM's call

    def test_width_floor_scales_with_cap(self):
        # lo = min(cap, max(3, cap//2)) — never exceeds the cap for small caps.
        tree, node = self._ext_tree_and_node()
        for cap, lo in ((6, 3), (8, 4), (4, 3), (2, 2)):
            msgs = lats._expand_prompt_messages(_grounded_state(), node, {"execute_curl"}, cap, tree=tree)
            self.assertIn(f"between {lo} and {cap}", msgs[1]["content"], f"cap={cap} -> lo={lo}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
