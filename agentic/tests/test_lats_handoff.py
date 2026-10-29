"""LATS handoff + lifecycle fixes (A / B1 / B2 / C).

Fix A  — the finished tree (structure + scores + best line + pruning reflections)
         is rendered into execution_trace, the ONLY channel the next think node
         reads, so the agent inherits what the search learned.
Fix B1 — a live tree that can produce no productive wave and has nothing pending
         is a DETERMINISTIC stall; the hook closes it out as `exhausted` instead
         of leaving a "zombie tree" in _exploit_tree forever.
Fix B2 — lats_active re-engages on a stall (no state growth) as well as on Deep
         Think, guarded by a re-activation cooldown since the last archive.
Fix C  — while a LATS tree is live and driving, Deep Think yields (tested via the
         lats_is_driving predicate think_node keys on).

See internal/LATS_integration.md §handoff.
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


# --------------------------------------------------------------------------- #
# helpers                                                                      #
# --------------------------------------------------------------------------- #
def _settings(**over):
    s = dict(project_settings.DEFAULT_AGENT_SETTINGS)
    s["LATS_ENABLED"] = True
    s["LATS_SHADOW_MODE"] = False        # drive mode by default for these tests
    s.update(over)
    return s


def _tree(objective="admin takeover", rollouts=3):
    # Root is synthetic and already-evaluated (matches _new_tree), so it never
    # counts as a queued probe in _single_open_line / _tree_exhausted.
    root = ExploitTreeNode(id="root", parent_id=None, depth=0,
                           status="evaluated", probe_rationale="root")
    return ExploitTree(root_id="root", nodes={"root": root},
                       objective=objective, rollouts=rollouts)


def _child(tree, parent_id, nid, *, tool_name="execute_curl", args=None,
           status="evaluated", value=0.4, visits=2, reflection="",
           observation="", exploit_succeeded=False, depth=None):
    p = tree.nodes[parent_id]
    n = ExploitTreeNode(
        id=nid, parent_id=parent_id,
        depth=(p.depth + 1 if depth is None else depth),
        tool_name=tool_name, tool_args=(args if args is not None else {"args": "x"}),
        status=status, value=value, visits=visits, reflection=reflection,
        observation_summary=observation, exploit_succeeded=exploit_succeeded,
    )
    tree.nodes[nid] = n
    p.children.append(nid)
    return n


def _state(**over):
    base = {
        "current_phase": "exploitation",
        "target_info": {"services": ["http"]},
        "chain_findings_memory": [],
        "conversation_objectives": [{"objective": "admin takeover"}],
        "current_objective_index": 0,
        "deep_think_ran_this_turn": True,
        "current_iteration": 20,
        "execution_trace": [],
        "_exploit_tree": None,
    }
    base.update(over)
    return base


def _decision(action="use_tool", tool_name="execute_curl", analysis=None):
    return {
        "action": action,
        "tool_name": tool_name,
        "tool_args": {"args": "https://t/login"},
        "output_analysis": analysis or {"per_step": [], "productivity": {"verdict": "new_info"}},
    }


class _CapCB:
    """Captures streamed LATS events as (kind, args) tuples."""
    def __init__(self):
        self.events = []

    async def on_lats_start(self, *a):        self.events.append(("start", a))
    async def on_lats_tree_update(self, *a):  self.events.append(("tree_update", a))
    async def on_lats_complete(self, *a):     self.events.append(("complete", a))

    def outcomes(self):
        # on_lats_complete(search_id, best_traj, outcome, metrics) -> a[2]
        return [a[2] for k, a in self.events if k == "complete"]


def _cb_registry():
    cb = _CapCB()
    return {"sess": cb}, cb


# =========================================================================== #
# Fix A — render + carry forward                                              #
# =========================================================================== #
class TestRenderTreeSummary(unittest.TestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    def _sample(self):
        t = _tree()
        _child(t, "root", "a", tool_name="execute_ffuf", value=0.15, visits=2,
               status="pruned", reflection="wordlist path missing; tool crashed")
        b = _child(t, "root", "b", tool_name="execute_curl", value=0.62, visits=3,
                   status="evaluated", observation="200 OK, input reflected")
        _child(t, "b", "c", tool_name="execute_curl", value=0.88, visits=1,
               status="terminal", exploit_succeeded=True,
               observation="SSTI confirmed: 49")
        t.best_terminal_id = "c"
        return t

    def test_summary_has_scores_status_and_reflections(self):
        out = lats._render_tree_summary(self._sample(), "terminal_success")
        self.assertIn("terminal_success", out)
        self.assertIn("execute_ffuf", out)
        self.assertIn("[pruned]", out)
        self.assertIn("wordlist path missing", out)   # reflection carried
        self.assertIn("v=0.62", out)                   # value carried
        self.assertIn("n=3", out)                      # visits carried
        self.assertIn("*SUCCESS*", out)                # exploit star
        self.assertIn("Best line:", out)

    def test_best_line_follows_terminal(self):
        labels = lats._trajectory_labels(self._sample())
        # root excluded; the winning line is root -> b -> c
        self.assertEqual(labels[-1], "execute_curl")
        self.assertGreaterEqual(len(labels), 1)

    def test_node_label_includes_args(self):
        n = ExploitTreeNode(id="x", tool_name="execute_nuclei",
                            tool_args={"args": "-u http://t -t ssti"})
        self.assertIn("execute_nuclei", lats._node_label(n))
        self.assertIn("ssti", lats._node_label(n))

    def test_summary_handles_cyclic_tree_without_hang(self):
        # Defensive: a malformed checkpoint with a self-referential child must
        # not infinite-loop the renderer (seen-guard).
        t = _tree()
        a = _child(t, "root", "a", tool_name="execute_curl")
        a.children.append("a")            # self-cycle
        out = lats._render_tree_summary(t, "exhausted")
        self.assertIn("execute_curl", out)   # returns, does not hang

    def test_summary_respects_node_cap(self):
        project_settings._settings = _settings(LATS_SUMMARY_MAX_NODES=3)
        t = _tree()
        for i in range(10):
            _child(t, "root", f"n{i}", value=0.1 * i)
        out = lats._render_tree_summary(t, "exhausted")
        self.assertIn("more nodes truncated", out)

    def test_directive_differs_success_vs_fail(self):
        succ = lats._carry_directive(self._sample(), "terminal_success")
        fail = lats._carry_directive(_tree(), "exhausted")
        self.assertIn("confirmed an exploit path", succ)
        self.assertIn("could not confirm", fail)
        self.assertIn("do not re-run", fail.lower())


class TestCarryForward(unittest.TestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    def test_appends_summary_step_to_execution_trace(self):
        t = _tree()
        _child(t, "root", "a", tool_name="execute_curl", value=0.6)
        _child(t, "root", "b", tool_name="execute_ffuf", value=0.15, status="pruned",
               reflection="cold")
        st = _state()
        lats._carry_tree_forward(st, t, "branch_collapsed")
        trace = st["execution_trace"]
        self.assertEqual(len(trace), 1)
        step = trace[0]
        self.assertEqual(step["tool_name"], "lats_search")
        self.assertIn("branch_collapsed", step["tool_output"])
        self.assertIn("execute_curl", step["tool_output"])
        # directive rides output_analysis (rendered un-wrapped as "Analysis:")
        self.assertIn("LATS", step["output_analysis"])
        self.assertEqual(step["step_id"], "lats-summary-root")

    def test_noop_for_single_node_tree(self):
        st = _state()
        lats._carry_tree_forward(st, _tree(), "exhausted")
        self.assertEqual(st["execution_trace"], [])

    def test_does_not_clobber_existing_trace(self):
        t = _tree()
        _child(t, "root", "a", value=0.6)
        st = _state(execution_trace=[{"tool_name": "execute_nmap"}])
        lats._carry_tree_forward(st, t, "exhausted")
        self.assertEqual(len(st["execution_trace"]), 2)
        self.assertEqual(st["execution_trace"][0]["tool_name"], "execute_nmap")


# =========================================================================== #
# Fix A via the hook — collapse carries in drive, NOT in shadow               #
# =========================================================================== #
class TestFinishSearchExits(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        project_settings._settings = None

    def _collapsible_state(self):
        """Live tree degenerated to one non-expandable leaf -> collapse."""
        t = _tree(rollouts=2)
        _child(t, "root", "a", tool_name="execute_curl", value=0.6,
               status="evaluated", depth=project_settings.DEFAULT_AGENT_SETTINGS["LATS_MAX_DEPTH"])
        return _state(_exploit_tree=t.model_dump())

    async def test_collapse_carries_forward_and_archives_in_drive(self):
        project_settings._settings = _settings(LATS_SHADOW_MODE=False)
        st = self._collapsible_state()
        reg, cb = _cb_registry()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[])):
            out = await lats.lats_hook(st, _decision(), llm=object(),
                                       streaming_callbacks=reg, session_id="sess")
        self.assertIsNone(st["_exploit_tree"])              # archived
        self.assertIn("branch_collapsed", cb.outcomes())    # completion streamed
        # tree carried into the trace the next think node reads
        self.assertTrue(any(s.get("tool_name") == "lats_search"
                            for s in st["execution_trace"]))
        # cooldown stamp set for Fix B2
        self.assertEqual(st["_lats_last_archive_iter"], st["current_iteration"])
        self.assertEqual(out["action"], "use_tool")         # legacy drives the line

    async def test_shadow_collapse_does_not_carry_forward(self):
        project_settings._settings = _settings(LATS_SHADOW_MODE=True)
        st = self._collapsible_state()
        reg, cb = _cb_registry()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[])):
            await lats.lats_hook(st, _decision(), llm=object(),
                                 streaming_callbacks=reg, session_id="sess")
        self.assertIsNone(st["_exploit_tree"])              # still archived
        self.assertIn("branch_collapsed", cb.outcomes())
        # shadow observes only: nothing injected into the agent's context
        self.assertFalse(any(s.get("tool_name") == "lats_search"
                             for s in st["execution_trace"]))


# =========================================================================== #
# Fix B1 — zombie exhaustion exit                                             #
# =========================================================================== #
class TestZombieExhaustionExit(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        project_settings._settings = None

    async def test_all_dead_leaves_exhaust_and_hand_back(self):
        # Two depth-capped (dead) leaves: nothing expandable, nothing queued ->
        # tree_exhausted at the top -> hand back to legacy WITH the summary
        # (does NOT force-complete the run).
        project_settings._settings = _settings(LATS_SHADOW_MODE=False)
        maxd = project_settings.DEFAULT_AGENT_SETTINGS["LATS_MAX_DEPTH"]
        t = _tree(rollouts=2)
        _child(t, "root", "a", tool_name="execute_curl", value=0.30, status="evaluated", depth=maxd)
        _child(t, "root", "b", tool_name="execute_ffuf", value=0.28, status="evaluated", depth=maxd)
        st = _state(_exploit_tree=t.model_dump())
        reg, cb = _cb_registry()
        out = await lats.lats_hook(st, _decision(), llm=object(),
                                   streaming_callbacks=reg, session_id="sess")
        self.assertIsNone(st["_exploit_tree"])          # handed back (archived)
        self.assertIn("exhausted", cb.outcomes())
        self.assertTrue(any(s.get("tool_name") == "lats_search"
                            for s in st["execution_trace"]))
        self.assertEqual(out["action"], "use_tool")     # legacy drives, NOT complete

    async def test_dead_frontier_is_pruned_not_archived_when_branches_remain(self):
        # SELECT's greedy UCT descent lands on 'a' (higher value, depth-capped =>
        # dead), but 'b' is still expandable. The dead frontier must be PRUNED,
        # NOT archived — otherwise we abandon the live branch (completeness bug).
        project_settings._settings = _settings(LATS_SHADOW_MODE=False)
        maxd = project_settings.DEFAULT_AGENT_SETTINGS["LATS_MAX_DEPTH"]
        t = _tree(rollouts=2)
        _child(t, "root", "a", tool_name="execute_curl", value=0.90, status="evaluated", depth=maxd)
        _child(t, "root", "b", tool_name="execute_ffuf", value=0.20, status="evaluated")  # depth 1, expandable
        st = _state(_exploit_tree=t.model_dump())
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[])):
            out = await lats.lats_hook(st, _decision(), llm=object())
        self.assertIsNotNone(st["_exploit_tree"])       # NOT archived — b remains
        tree = ExploitTree(**st["_exploit_tree"])
        self.assertEqual(tree.nodes["a"].status, "pruned")   # dead frontier pruned
        self.assertEqual(out["action"], "use_tool")     # agent drives this turn

    async def test_no_infinite_zombie_across_many_turns(self):
        """Regression: drive the hook repeatedly on a tree whose every expand
        yields nothing; it MUST converge to an archive within a bounded number of
        turns (pruning one dead frontier per stuck turn) rather than loop forever."""
        project_settings._settings = _settings(LATS_SHADOW_MODE=False)
        t = _tree(rollouts=2)
        _child(t, "root", "a", tool_name="execute_curl", value=0.30, status="evaluated")
        _child(t, "root", "b", tool_name="execute_ffuf", value=0.28, status="evaluated")
        st = _state(_exploit_tree=t.model_dump())
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[])):
            archived = False
            for _ in range(8):
                await lats.lats_hook(st, _decision(), llm=object())
                if st["_exploit_tree"] is None:
                    archived = True
                    break
        self.assertTrue(archived, "tree never archived — zombie regression")

    async def test_expandable_tree_does_not_exhaust(self):
        """A tree that CAN still grow keeps searching (no premature archive)."""
        project_settings._settings = _settings(LATS_SHADOW_MODE=False)
        t = _tree(rollouts=1)
        _child(t, "root", "a", tool_name="execute_curl", value=0.5, status="evaluated")
        _child(t, "root", "b", tool_name="execute_ffuf", value=0.5, status="evaluated")
        st = _state(_exploit_tree=t.model_dump())
        new_probes = [{"tool_name": "execute_curl", "tool_args": {"args": "y"},
                       "rationale": "deeper"}]
        with patch("orchestrator_helpers.lats.lats_expand",
                   AsyncMock(return_value=new_probes)):
            await lats.lats_hook(st, _decision(), llm=object())
        self.assertIsNotNone(st["_exploit_tree"])       # still live


# =========================================================================== #
# Expand INPUT CONTRACT — situational context + Deep Think seed + path + dedup #
# =========================================================================== #
class TestSituationalContext(unittest.TestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    def _rich_state(self):
        return _state(
            target_info={"primary_target": "http://lab-x/", "services": ["http"],
                         "endpoints": ["/login", "/admin"], "technologies": ["Struts2"]},
            chain_findings_memory=[{"finding_type": "endpoint", "description": "/greet?name= reflects input"}],
            chain_failures_memory=[{"description": "ffuf /admin wordlist path missing"}],
            execution_trace=[{"tool_name": "lats_search",
                              "tool_output": "LATS exploit-path search: exhausted\nBest line: execute_curl"}],
        )

    def test_includes_recon_surface_findings_failures_and_prior_trees(self):
        ctx = lats._situational_context(self._rich_state())
        self.assertIn("Recon surface", ctx)
        self.assertIn("/login", ctx)
        self.assertIn("Struts2", ctx)
        self.assertIn("greet?name", ctx)                 # finding
        self.assertIn("do not repeat", ctx.lower())      # failures header
        self.assertIn("wordlist path missing", ctx)      # failure detail
        self.assertIn("Prior LATS searches", ctx)        # prior tree summary
        self.assertIn("Best line", ctx)

    def test_empty_state_gives_fallback_not_crash(self):
        ctx = lats._situational_context(_state(target_info={}))
        self.assertIn("no findings yet", ctx)

    def test_prior_tree_summaries_only_pick_lats_search_steps(self):
        st = _state(execution_trace=[
            {"tool_name": "execute_curl", "tool_output": "not a summary"},
            {"tool_name": "lats_search", "tool_output": "SUMMARY-A"},
        ])
        out = lats._prior_tree_summaries(st)
        self.assertIn("SUMMARY-A", out)
        self.assertNotIn("not a summary", out)


class TestCumulativeTreeDigest(unittest.TestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    def _finished_tree(self, best_tool="execute_curl", pruned_tool="execute_ffuf"):
        t = _tree(objective="admin takeover")
        _child(t, "root", "win", tool_name=best_tool, value=0.7, status="evaluated")
        _child(t, "root", "dead", tool_name=pruned_tool, value=0.15, status="pruned")
        return t

    def test_carry_forward_appends_persistent_digest(self):
        st = _state()
        lats._carry_tree_forward(st, self._finished_tree(), "exhausted")
        digest = st["_lats_tree_digest"]
        self.assertEqual(len(digest), 1)
        self.assertIn("exhausted", digest[0])
        self.assertIn("execute_curl", digest[0])       # best line (per-tree narrative)
        # Ruled-out knowledge now lives in the merged, semantic _lats_dead store
        # (class@target), not the per-tree line — see test_lats_cross_tree_digest.
        self.assertIn("_lats_dead", st)

    def test_digest_ACCUMULATES_across_multiple_trees(self):
        st = _state()
        lats._carry_tree_forward(st, self._finished_tree("execute_curl", "execute_ffuf"), "exhausted")
        lats._carry_tree_forward(st, self._finished_tree("execute_nuclei", "execute_gau"), "branch_collapsed")
        digest = st["_lats_tree_digest"]
        self.assertEqual(len(digest), 2)               # both retained, not replaced
        self.assertIn("execute_curl", digest[0])
        self.assertIn("execute_nuclei", digest[1])

    def test_digest_is_capped(self):
        project_settings._settings = _settings(LATS_DIGEST_MAX=3)
        st = _state()
        for i in range(6):
            lats._carry_tree_forward(st, self._finished_tree(f"tool{i}"), "exhausted")
        self.assertEqual(len(st["_lats_tree_digest"]), 3)   # keeps the last 3
        self.assertIn("tool5", st["_lats_tree_digest"][-1])

    def test_prior_summaries_reads_the_persistent_digest(self):
        # The digest survives even with an EMPTY execution_trace (eviction-proof).
        st = _state(execution_trace=[])
        lats._carry_tree_forward(st, self._finished_tree("execute_sqlmap"), "exhausted")
        st["execution_trace"] = []                     # simulate trace eviction
        out = lats._prior_tree_summaries(st)
        self.assertIn("execute_sqlmap", out)

    def test_prior_summaries_falls_back_to_trace_when_no_digest(self):
        st = _state(_lats_tree_digest=None, execution_trace=[
            {"tool_name": "lats_search", "tool_output": "TRACE-SUMMARY-X"},
        ])
        self.assertIn("TRACE-SUMMARY-X", lats._prior_tree_summaries(st))

    def test_digest_field_is_declared_state_key(self):
        from state import AgentState
        self.assertIn("_lats_tree_digest", AgentState.__annotations__)

    def test_foothold_tagged_in_digest(self):
        t = _tree()
        _child(t, "root", "win", tool_name="execute_curl", exploit_succeeded=True, status="terminal")
        st = _state()
        lats._carry_tree_forward(st, t, "terminal_success")
        self.assertIn("FOOTHOLD", st["_lats_tree_digest"][0])


class TestExpandTokenAccounting(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    async def test_expand_tokens_captured_on_state(self):
        class _Resp:
            content = '{"probes": [{"tool_name": "execute_curl", "tool_args": {"args": "x"}, "rationale": "r"}]}'
            usage_metadata = {"input_tokens": 1200, "output_tokens": 80}
        st = _state()
        with patch("orchestrator_helpers.llm_retry.retry_llm_call", AsyncMock(return_value=_Resp())):
            await lats.lats_expand(object(), st, None)
        self.assertEqual(st["_lats_expand_tokens"], {"in": 1200, "out": 80})

    async def test_expand_tokens_are_additive(self):
        class _Resp:
            content = '{"probes": []}'
            usage_metadata = {"input_tokens": 100, "output_tokens": 10}
        st = _state(_lats_expand_tokens={"in": 500, "out": 50})
        with patch("orchestrator_helpers.llm_retry.retry_llm_call", AsyncMock(return_value=_Resp())):
            await lats.lats_expand(object(), st, None)
        self.assertEqual(st["_lats_expand_tokens"], {"in": 600, "out": 60})

    async def test_missing_usage_does_not_crash_or_set(self):
        class _Resp:
            content = '{"probes": []}'
        st = _state()
        with patch("orchestrator_helpers.llm_retry.retry_llm_call", AsyncMock(return_value=_Resp())):
            await lats.lats_expand(object(), st, None)
        self.assertIsNone(st.get("_lats_expand_tokens"))


class TestSkillMethodology(unittest.TestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    def test_empty_when_no_attack_path(self):
        self.assertEqual(lats._skill_methodology(_state(attack_path_type="")), "")

    def test_returns_active_path_playbook(self):
        with patch("prompts.base.build_attack_path_behavior",
                   return_value="SSTI PLAYBOOK: probe {{request}} then settings"):
            out = lats._skill_methodology(_state(attack_path_type="server_side_template_injection"))
        self.assertIn("SSTI PLAYBOOK", out)

    def test_guarded_against_builder_error(self):
        with patch("prompts.base.build_attack_path_behavior", side_effect=RuntimeError("boom")):
            self.assertEqual(lats._skill_methodology(_state(attack_path_type="x")), "")

    def test_methodology_lands_in_expand_prompt(self):
        st = _state(attack_path_type="ssti")
        with patch("prompts.base.build_attack_path_behavior", return_value="PLAYBOOK-XYZ-STEPS"):
            msgs = lats._expand_prompt_messages(st, None, {"execute_curl"}, 3, tree=None)
        user = msgs[1]["content"]
        self.assertIn("METHODOLOGY", user)
        self.assertIn("PLAYBOOK-XYZ-STEPS", user)

    def test_no_methodology_block_when_absent(self):
        st = _state(attack_path_type="")
        msgs = lats._expand_prompt_messages(st, None, {"execute_curl"}, 3, tree=None)
        self.assertNotIn("METHODOLOGY", msgs[1]["content"])


class TestDeepThinkSeed(unittest.TestCase):
    def tearDown(self):
        project_settings._settings = None

    def test_renders_hypotheses_and_vectors(self):
        st = _state(_lats_deep_think_hints={
            "hypotheses": [{"hypothesis": "SSTI in name param", "probe": "send ${7*7}"}],
            "attack_vectors": ["SSTI", "OGNL"],
        })
        block = lats._deep_think_seed_block(st)
        self.assertIn("SSTI in name param", block)
        self.assertIn("send ${7*7}", block)
        self.assertIn("Attack vectors", block)
        self.assertIn("OGNL", block)

    def test_empty_when_no_hints(self):
        self.assertEqual(lats._deep_think_seed_block(_state()), "")

    def test_excludes_recommended_plan_even_if_present(self):
        # Contract: only hypotheses + vectors are consumed; a stray plan key must
        # never leak into the seed (it would linearize the tree).
        st = _state(_lats_deep_think_hints={
            "hypotheses": [{"hypothesis": "h", "probe": "p"}],
            "attack_vectors": ["v"],
            "recommended_approach": "DO-EXACTLY-THIS-LINE",
            "priority_order": ["step1", "step2"],
        })
        block = lats._deep_think_seed_block(st)
        self.assertNotIn("DO-EXACTLY-THIS-LINE", block)
        self.assertNotIn("step1", block)


class TestPathAndDedup(unittest.TestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    def test_render_path_is_root_to_node_with_verdicts(self):
        t = _tree()
        _child(t, "root", "a", tool_name="execute_curl", status="evaluated")
        b = _child(t, "a", "b", tool_name="execute_ffuf", status="evaluated")
        t.nodes["a"].verdict = "new_info"
        t.nodes["b"].verdict = "blocked"
        path = lats._render_path(t, b)
        self.assertLess(path.index("execute_curl"), path.index("execute_ffuf"))  # root->leaf order
        self.assertIn("[new_info]", path)
        self.assertIn("[blocked]", path)
        self.assertNotIn("root", path)                   # synthetic root skipped

    def test_existing_probes_lists_tree_and_skips_root(self):
        t = _tree()
        _child(t, "root", "a", tool_name="execute_curl", args={"args": "x"})
        _child(t, "root", "b", tool_name="execute_ffuf", args={"args": "y"})
        out = lats._existing_probes(t)
        self.assertIn("execute_curl", out)
        self.assertIn("execute_ffuf", out)


class TestExpandPromptAssembly(unittest.TestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    def test_seed_prompt_has_situation_and_deep_think(self):
        st = _state(
            target_info={"endpoints": ["/greet"]},
            _lats_deep_think_hints={"hypotheses": [{"hypothesis": "SSTI", "probe": "${7*7}"}],
                                    "attack_vectors": ["SSTI"]},
        )
        msgs = lats._expand_prompt_messages(st, None, {"execute_curl"}, 3, tree=None)
        user = msgs[1]["content"]
        self.assertIn("SITUATION:", user)
        self.assertIn("/greet", user)
        self.assertIn("competing hypotheses", user)
        self.assertIn("${7*7}", user)
        self.assertIn("EXACTLY", msgs[0]["content"])      # schema regression

    def test_prompt_width_is_dynamic_not_forced(self):
        st = _state()
        msgs = lats._expand_prompt_messages(st, None, {"execute_curl"}, 6, tree=None)
        system = msgs[0]["content"]
        self.assertIn("never more than 6", system)  # ceiling, not a forced count
        self.assertIn("YOUR decision", system)      # count is the LLM's call now
        self.assertIn("waste rollouts", system)     # anti-padding rationale
        self.assertNotIn("aim to use the width", system)  # old forcing phrase removed
        self.assertIn("FULL WIDTH", msgs[1]["content"])   # root still fans out wide
        # schema guardrails preserved (regression)
        self.assertIn("EXACTLY", system)

    def test_node_prompt_has_path_and_dedup(self):
        t = _tree()
        _child(t, "root", "a", tool_name="execute_curl", args={"args": "x"}, status="evaluated")
        node = t.nodes["a"]
        st = _state()
        msgs = lats._expand_prompt_messages(st, node, {"execute_curl"}, 3, tree=t)
        user = msgs[1]["content"]
        self.assertIn("Current branch", user)
        self.assertIn("Path:", user)
        self.assertIn("do not repeat", user.lower())      # dedup block
        self.assertIn("execute_curl", user)


# =========================================================================== #
# Integration — full hook flows (ENTER, terminal, budget)                     #
# =========================================================================== #
_TWO_PROBES = [
    {"tool_name": "execute_curl", "tool_args": {"args": "a"}, "rationale": "sqli"},
    {"tool_name": "execute_httpx", "tool_args": {"args": "b"}, "rationale": "enum"},
]


class TestHookIntegration(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        project_settings._settings = None

    async def test_enter_via_score_trigger_builds_tree(self):
        # No tree, no Deep Think, not stalled — but the productivity score alone
        # crosses the LATS rung -> ENTER builds a tree (the escalation ladder).
        project_settings._settings = _settings(LATS_SHADOW_MODE=False)
        st = _state(_exploit_tree=None, deep_think_ran_this_turn=False,
                    _iterations_since_state_grew=1,
                    _last_productivity_score={"score": 4.5})
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=_TWO_PROBES)):
            await lats.lats_hook(st, _decision(), llm=object())
        self.assertIsNotNone(st["_exploit_tree"])
        tree = ExploitTree(**st["_exploit_tree"])
        self.assertEqual(len(tree.nodes[tree.root_id].children), 2)

    async def test_terminal_success_carries_forward_and_completes(self):
        # A terminal node ends the run (action=complete) AND leaves the tree
        # summary in execution_trace for the final report.
        project_settings._settings = _settings(LATS_SHADOW_MODE=False)
        t = _tree(rollouts=3)
        _child(t, "root", "win", tool_name="execute_curl", value=0.95,
               status="terminal", exploit_succeeded=True, observation="shell!")
        st = _state(_exploit_tree=t.model_dump())
        reg, cb = _cb_registry()
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[])):
            out = await lats.lats_hook(st, _decision(), llm=object(),
                                       streaming_callbacks=reg, session_id="sess")
        self.assertIn("terminal_success", cb.outcomes())
        self.assertTrue(any(s.get("tool_name") == "lats_search"
                            for s in st["execution_trace"]))
        self.assertEqual(out["action"], "complete")

    async def test_budget_cap_completes_run(self):
        # Hitting the rollout cap (still had moves) ENDS the run via complete —
        # distinct from tree_exhausted, which hands back.
        project_settings._settings = _settings(LATS_SHADOW_MODE=False)
        t = _tree(rollouts=int(project_settings.DEFAULT_AGENT_SETTINGS["LATS_MAX_ROLLOUTS"]))
        _child(t, "root", "a", tool_name="execute_curl", value=0.5, status="evaluated")
        st = _state(_exploit_tree=t.model_dump())
        with patch("orchestrator_helpers.lats.lats_expand", AsyncMock(return_value=[])):
            out = await lats.lats_hook(st, _decision(), llm=object())
        self.assertEqual(out["action"], "complete")


# =========================================================================== #
# Fix B2 — re-activation on stall + cooldown                                  #
# =========================================================================== #
class TestReactivation(unittest.TestCase):
    def setUp(self):
        project_settings._settings = _settings()

    def tearDown(self):
        project_settings._settings = None

    def test_activates_on_deep_think(self):
        self.assertTrue(lats.lats_active(_state(deep_think_ran_this_turn=True)))

    def test_activates_on_stall_without_deep_think(self):
        st = _state(deep_think_ran_this_turn=False, _iterations_since_state_grew=5)
        self.assertTrue(lats.lats_active(st))

    def test_no_activation_when_not_stalled_and_no_deep_think(self):
        st = _state(deep_think_ran_this_turn=False, _iterations_since_state_grew=4)
        self.assertFalse(lats.lats_active(st))

    def test_cooldown_blocks_immediate_reactivation(self):
        st = _state(deep_think_ran_this_turn=True, current_iteration=22,
                    _lats_last_archive_iter=20)   # 2 < cooldown(4)
        self.assertFalse(lats.lats_active(st))

    def test_reactivates_after_cooldown_elapses(self):
        st = _state(deep_think_ran_this_turn=True, current_iteration=25,
                    _lats_last_archive_iter=20)   # 5 >= cooldown(4)
        self.assertTrue(lats.lats_active(st))

    def test_first_activation_not_blocked_by_cooldown(self):
        st = _state(deep_think_ran_this_turn=True, current_iteration=1)
        st.pop("_lats_last_archive_iter", None)   # never archived
        self.assertTrue(lats.lats_active(st))

    def test_stuck_threshold_is_configurable(self):
        project_settings._settings = _settings(LATS_REACTIVATE_STUCK_TURNS=6)
        st = _state(deep_think_ran_this_turn=False, _iterations_since_state_grew=4)
        self.assertFalse(lats.lats_active(st))
        st["_iterations_since_state_grew"] = 6
        self.assertTrue(lats.lats_active(st))

    # --- score trigger (the escalation-ladder middle rung) --------------------
    def test_activates_on_productivity_score_over_threshold(self):
        # No Deep Think, not yet stalled, but the score crossed the LATS rung.
        st = _state(deep_think_ran_this_turn=False, _iterations_since_state_grew=1,
                    _last_productivity_score={"score": 4.5})
        self.assertTrue(lats.lats_active(st))

    def test_no_activation_when_score_below_threshold(self):
        st = _state(deep_think_ran_this_turn=False, _iterations_since_state_grew=1,
                    _last_productivity_score={"score": 2.9})   # below LATS_SCORE_THRESHOLD (3.0)
        self.assertFalse(lats.lats_active(st))

    def test_score_threshold_sits_below_deep_think(self):
        # The LATS rung (4.0) is below the Deep Think threshold (5.0), so LATS is
        # the first responder in the 4.0..5.0 band where Deep Think stays quiet.
        s = _settings()
        self.assertLess(s["LATS_SCORE_THRESHOLD"],
                        s["PRODUCTIVITY_SCORE_DEEPTHINK_THRESHOLD"])

    def test_score_threshold_is_configurable(self):
        project_settings._settings = _settings(LATS_SCORE_THRESHOLD=6.0)
        st = _state(deep_think_ran_this_turn=False, _iterations_since_state_grew=1,
                    _last_productivity_score={"score": 5.0})
        self.assertFalse(lats.lats_active(st))
        st["_last_productivity_score"] = {"score": 6.0}
        self.assertTrue(lats.lats_active(st))

    def test_missing_or_malformed_score_does_not_crash(self):
        for bad in (None, {}, {"score": None}, {"score": "x"}, "nope"):
            st = _state(deep_think_ran_this_turn=False, _iterations_since_state_grew=0,
                        _last_productivity_score=bad)
            self.assertFalse(lats.lats_active(st))   # degrades to no-trigger

    def test_cooldown_still_gates_the_score_trigger(self):
        # A high score must NOT bypass the re-activation cooldown.
        st = _state(deep_think_ran_this_turn=False, current_iteration=22,
                    _lats_last_archive_iter=20,             # 2 < cooldown(4)
                    _last_productivity_score={"score": 9.0})
        self.assertFalse(lats.lats_active(st))


# =========================================================================== #
# Fix B2 — cooldown STATE must persist across turns (else it never applies)    #
# =========================================================================== #
class TestCooldownPersistence(unittest.TestCase):
    def test_archive_iter_is_a_declared_state_key(self):
        # If _lats_last_archive_iter is not a declared AgentState key, LangGraph
        # strips it from think_node's updates (§20.1), so it resets to None every
        # turn and the re-activation cooldown silently never applies. (Found live:
        # search re-activated 1 iteration after archiving vs the 4-iter cooldown.)
        from state import AgentState
        self.assertIn("_lats_last_archive_iter", AgentState.__annotations__)

    def test_archive_stamps_the_iteration(self):
        t = _tree()
        st = _state(current_iteration=17)
        lats._archive_tree(st, t, "exhausted")
        self.assertEqual(st["_lats_last_archive_iter"], 17)


# =========================================================================== #
# Fix C — Deep Think yields to LATS while driving                             #
# =========================================================================== #
class TestDeepThinkYield(unittest.TestCase):
    def tearDown(self):
        project_settings._settings = None

    def test_driving_true_when_tree_live_and_not_shadow(self):
        project_settings._settings = _settings(LATS_SHADOW_MODE=False)
        self.assertTrue(lats.lats_is_driving(_state(_exploit_tree={"root_id": "r"})))

    def test_driving_false_in_shadow_mode(self):
        project_settings._settings = _settings(LATS_SHADOW_MODE=True)
        self.assertFalse(lats.lats_is_driving(_state(_exploit_tree={"root_id": "r"})))

    def test_driving_false_when_no_tree(self):
        project_settings._settings = _settings(LATS_SHADOW_MODE=False)
        self.assertFalse(lats.lats_is_driving(_state(_exploit_tree=None)))

    def test_driving_false_when_disabled(self):
        project_settings._settings = _settings(LATS_ENABLED=False, LATS_SHADOW_MODE=False)
        self.assertFalse(lats.lats_is_driving(_state(_exploit_tree={"root_id": "r"})))


if __name__ == "__main__":
    unittest.main()
