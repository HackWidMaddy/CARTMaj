"""
Concurrency-isolation tests for the per-session settings + LLM + capture fix.

Covers the Tier 1 (settings ContextVar) and Tier 2 (current_llm ContextVar,
capture-from-settings, neo4j LLM) changes:

  - project_settings: get_settings resolution order (task ContextVar -> module
    global fallback -> governed defaults); load/reload cadence; backward-compat
    for the ~105 existing tests that assign `_settings` directly.
  - agent_context: current_llm set/get + task isolation.
  - Concurrency: two sessions for different projects must read their OWN values,
    both under a deterministic barrier AND under realistic await-interleaving
    (the actual race window: load -> await -> other session loads -> read).
  - ContextVar inheritance to child tasks (the mechanism fireteam members rely
    on: asyncio copies the context at create_task time).
  - Integration: llm_setup.apply_project_settings binds current_llm atomically;
    the graph-node resolution `current_llm.get() or self.llm` picks the session's
    own LLM even when the shared orchestrator.llm has been clobbered.

Unittest style (matches the repo's other tests). Runs in the agent container.
"""
import asyncio
import os
import unittest

os.environ.setdefault("WEBAPP_API_URL", "http://fake-webapp")

import project_settings as ps
import agent_context as ac


def _fake_fetch(key_map):
    """Return a fetch fn: project_id -> settings dict with per-project overrides."""
    def _f(project_id, webapp_url):
        s = dict(ps.DEFAULT_AGENT_SETTINGS)
        for k, per_proj in key_map.items():
            s[k] = per_proj[project_id]
        s["_PROJECT_MARKER"] = project_id
        return s
    return _f


class _ResetMixin:
    def setUp(self):
        self._orig_fetch = ps.fetch_agent_settings
        ps._settings = None
        ps._current_project_id = None
        ps._settings_ctx.set(None)
        ac.current_llm.set(None)

    def tearDown(self):
        ps.fetch_agent_settings = self._orig_fetch
        ps._settings = None
        ps._current_project_id = None
        ps._settings_ctx.set(None)
        ac.current_llm.set(None)


# ============================ UNIT: resolution order ========================
class TestSettingsResolution(_ResetMixin, unittest.TestCase):
    def test_defaults_when_nothing_loaded(self):
        # ctx None + global None -> governed DEFAULT_AGENT_SETTINGS
        self.assertIsNone(ps._settings_ctx.get())
        s = ps.get_settings()
        self.assertIn("LATS_SHADOW_MODE", s)
        # sentinel default returned for a missing key
        self.assertEqual(ps.get_setting("__NOPE__", "sentinel"), "sentinel")

    def test_global_fallback_used_when_ctx_unset(self):
        ps._settings = {"K": 111}
        self.assertIsNone(ps._settings_ctx.get())
        self.assertEqual(ps.get_setting("K"), 111)

    def test_ctx_takes_precedence_over_global(self):
        ps._settings = {"K": 111}
        ps._settings_ctx.set({"K": 222})
        self.assertEqual(ps.get_setting("K"), 222)

    def test_direct_settings_write_backward_compat(self):
        # The ~105 existing tests do exactly this: assign _settings directly.
        ps._settings = {"LATS_SHADOW_MODE": True, "MAX_ITERATIONS": 42}
        ps._settings_ctx.set(None)
        self.assertIs(ps.get_setting("LATS_SHADOW_MODE"), True)
        self.assertEqual(ps.get_setting("MAX_ITERATIONS"), 42)


# ============================ UNIT: load / reload ===========================
class TestLoadReload(_ResetMixin, unittest.TestCase):
    def test_load_sets_both_ctx_and_global(self):
        ps.fetch_agent_settings = _fake_fetch({"LATS_SHADOW_MODE": {"P": False}})
        out = ps.load_project_settings("P")
        self.assertIs(out["LATS_SHADOW_MODE"], False)
        self.assertIsNotNone(ps._settings_ctx.get())          # task-local set
        self.assertIsNotNone(ps._settings)                    # global fallback set
        self.assertEqual(ps._current_project_id, "P")
        self.assertIs(ps.get_setting("LATS_SHADOW_MODE"), False)

    def test_reload_clears_state(self):
        ps.fetch_agent_settings = _fake_fetch({"LATS_SHADOW_MODE": {"P": True}})
        ps.load_project_settings("P")
        ps.reload_settings()  # no project -> clear
        self.assertIsNone(ps._settings)
        self.assertIsNone(ps._settings_ctx.get())
        self.assertIsNone(ps._current_project_id)


# ==================== CONCURRENCY: settings isolation =======================
class TestSettingsConcurrency(_ResetMixin, unittest.TestCase):
    def test_barrier_isolation(self):
        ps.fetch_agent_settings = _fake_fetch(
            {"LATS_SHADOW_MODE": {"PF": False, "PT": True}}
        )
        results = {}
        barrier = asyncio.Barrier(2)

        async def sess(pid, label):
            ps.load_project_settings(pid)
            await barrier.wait()  # both loaded -> module global holds "last loader"
            results[label] = ps.get_setting("LATS_SHADOW_MODE")

        async def main():
            await asyncio.gather(sess("PF", "false"), sess("PT", "true"))

        asyncio.run(main())
        self.assertIs(results["false"], False, f"contaminated: {results}")
        self.assertIs(results["true"], True, f"contaminated: {results}")

    def test_await_interleave_isolation(self):
        # The REAL race window: load -> await (LLM/tool) -> other loads -> read.
        ps.fetch_agent_settings = _fake_fetch(
            {"LATS_SHADOW_MODE": {"PF": False, "PT": True}}
        )
        results = {}

        async def slow_false():
            ps.load_project_settings("PF")     # global := False
            await asyncio.sleep(0.05)           # yield; slow_true clobbers global -> True
            results["false"] = ps.get_setting("LATS_SHADOW_MODE")

        async def fast_true():
            await asyncio.sleep(0.01)
            ps.load_project_settings("PT")     # global := True while PF sleeps
            results["true"] = ps.get_setting("LATS_SHADOW_MODE")

        async def main():
            await asyncio.gather(slow_false(), fast_true())

        asyncio.run(main())
        self.assertIs(results["false"], False, f"await-race contaminated: {results}")
        self.assertIs(results["true"], True)


# ==================== CONCURRENCY: capture flag =============================
class TestCaptureFlagIsolation(_ResetMixin, unittest.TestCase):
    def test_capture_flag_per_session(self):
        # tools.py now gates capture on get_setting('CAPTURE_PROXY_ENABLED').
        ps.fetch_agent_settings = _fake_fetch(
            {"CAPTURE_PROXY_ENABLED": {"POFF": False, "PON": True}}
        )
        cap = {}
        barrier = asyncio.Barrier(2)

        async def sess(pid, label):
            ps.load_project_settings(pid)
            await barrier.wait()
            cap[label] = bool(ps.get_setting("CAPTURE_PROXY_ENABLED", False))

        async def main():
            await asyncio.gather(sess("POFF", "off"), sess("PON", "on"))

        asyncio.run(main())
        self.assertIs(cap["off"], False, f"capture leak: {cap}")
        self.assertIs(cap["on"], True, f"capture leak: {cap}")


# ==================== CONCURRENCY: current_llm =============================
class _FakeLLM:
    def __init__(self, model):
        self.model = model


class TestLlmContextIsolation(_ResetMixin, unittest.TestCase):
    def test_default_none(self):
        self.assertIsNone(ac.current_llm.get())
        self.assertIsNone(ac.get_llm_context())

    def test_barrier_isolation(self):
        read = {}
        barrier = asyncio.Barrier(2)

        async def sess(model, label):
            ac.set_llm_context(_FakeLLM(model))
            await barrier.wait()
            got = ac.current_llm.get()
            read[label] = got.model if got else None

        async def main():
            await asyncio.gather(sess("opus", "A"), sess("gpt", "B"))

        asyncio.run(main())
        self.assertEqual(read["A"], "opus", f"llm leak: {read}")
        self.assertEqual(read["B"], "gpt", f"llm leak: {read}")


# ============ CONCURRENCY: ContextVar inheritance to child tasks ===========
class TestChildTaskInheritance(_ResetMixin, unittest.TestCase):
    """Fireteam members are asyncio.create_task'd AFTER the parent loads
    settings/LLM; they must inherit the parent's snapshot (context copied at
    task creation), and two different parents' children must not cross."""

    def test_child_inherits_parent_snapshot(self):
        ps.fetch_agent_settings = _fake_fetch(
            {"LATS_SHADOW_MODE": {"PF": False, "PT": True}}
        )
        seen = {}
        barrier = asyncio.Barrier(2)

        async def child(label):
            # No load here; must inherit parent's ContextVars
            seen[label] = (
                ps.get_setting("LATS_SHADOW_MODE"),
                (ac.current_llm.get().model if ac.current_llm.get() else None),
            )

        async def parent(pid, model, label):
            ps.load_project_settings(pid)
            ac.set_llm_context(_FakeLLM(model))
            await barrier.wait()  # ensure both parents have set before spawning
            t = asyncio.create_task(child(label))  # inherits THIS parent's context
            await t

        async def main():
            await asyncio.gather(
                parent("PF", "opus", "childF"),
                parent("PT", "gpt", "childT"),
            )

        asyncio.run(main())
        self.assertEqual(seen["childF"], (False, "opus"), f"inheritance leak: {seen}")
        self.assertEqual(seen["childT"], (True, "gpt"), f"inheritance leak: {seen}")


# ==================== INTEGRATION: apply_project_settings ===================
class _FakeNeo4j:
    def __init__(self):
        self.llm = None


class _FakeOrch:
    def __init__(self):
        self.model_name = None
        self.llm = None
        self.neo4j_manager = _FakeNeo4j()
        self._user_settings = {}


class TestApplyBindsLlm(_ResetMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        from orchestrator_helpers import llm_setup
        self.llm_setup = llm_setup
        self._orig_setup_llm = llm_setup.setup_llm

    def tearDown(self):
        self.llm_setup.setup_llm = self._orig_setup_llm
        super().tearDown()

    def _install(self, model_map):
        ps.fetch_agent_settings = _fake_fetch({"OPENAI_MODEL": model_map})
        self.llm_setup.setup_llm = lambda model, **kw: _FakeLLM(model)

    def test_apply_binds_current_llm(self):
        self._install({"P": "modelX"})
        orch = _FakeOrch()
        self.llm_setup.apply_project_settings(orch, "P")
        got = ac.current_llm.get()
        self.assertIsNotNone(got)
        self.assertEqual(got.model, "modelX")
        self.assertIs(orch.llm, got)  # shared field also set (fallback)

    def test_apply_failure_sets_none(self):
        ps.fetch_agent_settings = _fake_fetch({"OPENAI_MODEL": {"P": "boom"}})

        def _boom(model, **kw):
            raise ValueError("no key")

        self.llm_setup.setup_llm = _boom
        orch = _FakeOrch()
        self.llm_setup.apply_project_settings(orch, "P")
        self.assertIsNone(ac.current_llm.get())
        self.assertIsNone(orch.llm)

    def test_shared_orch_two_projects_isolated(self):
        # ONE shared orchestrator (as in production), two concurrent sessions on
        # different models. The graph-node resolution is `current_llm.get() or
        # self.llm`; even though orch.llm is clobbered to the last applier, each
        # session must resolve its OWN model.
        self._install({"PA": "opus", "PB": "gpt"})
        orch = _FakeOrch()
        resolved = {}
        barrier = asyncio.Barrier(2)

        async def sess(pid, label):
            self.llm_setup.apply_project_settings(orch, pid)  # sync; sets ctx + orch.llm
            await barrier.wait()  # orch.llm now = last applier
            node_llm = ac.current_llm.get() or orch.llm  # the node-closure pattern
            resolved[label] = node_llm.model

        async def main():
            await asyncio.gather(sess("PA", "A"), sess("PB", "B"))

        asyncio.run(main())
        self.assertEqual(resolved["A"], "opus", f"node-llm leak: {resolved}")
        self.assertEqual(resolved["B"], "gpt", f"node-llm leak: {resolved}")


# ============================ SMOKE ========================================
class TestSmoke(_ResetMixin, unittest.TestCase):
    def test_modules_import_and_roundtrip(self):
        import importlib
        for m in ("agent_context", "project_settings", "tools",
                  "orchestrator_helpers.llm_setup", "orchestrator"):
            importlib.import_module(m)
        # minimal round-trip
        ps.fetch_agent_settings = _fake_fetch({"LATS_SHADOW_MODE": {"P": False}})
        ps.load_project_settings("P")
        self.assertIs(ps.get_setting("LATS_SHADOW_MODE"), False)
        ac.set_llm_context(_FakeLLM("m"))
        self.assertEqual(ac.current_llm.get().model, "m")


if __name__ == "__main__":
    unittest.main(verbosity=2)
