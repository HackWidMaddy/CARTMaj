"""
Tier 3 / Stage 4: tradecraft scalar knobs (TRADECRAFT_FETCH_TIMEOUT,
TRADECRAFT_TIER2_THRESHOLD_BYTES, TRADECRAFT_DEFAULT_TTL_SEC) are read per
session at use-time from the task-isolated settings, exactly as
TradecraftLookupManager now does:  get_setting(KEY, self.<field>).

Proves the use-time read isolates concurrent sessions (each in its own
contextvars.Context, as asyncio.create_task copies the context per task), while
the shared module global reflects only the last loader.

Deliberately sets the settings ContextVar directly (does NOT monkeypatch
fetch_agent_settings) so the test is robust to suite-ordering state leaks.
"""
import os
import contextvars
import unittest

os.environ.setdefault("WEBAPP_API_URL", "http://fake-webapp")
import project_settings as ps


class TestTradecraftScalarIsolation(unittest.TestCase):
    def setUp(self):
        # test_t14_prompt_injection_previews replaces sys.modules["project_settings"]
        # with a stub at import time and never restores it, so any test module that
        # imports project_settings AFTER it (alphabetically) gets the stub. Skip
        # rather than error on that pre-existing suite pollution; the test runs
        # correctly in isolation and when the real module is present.
        if not hasattr(ps, "DEFAULT_AGENT_SETTINGS"):
            self.skipTest("project_settings stubbed by an earlier test (test_t14 pollution)")

    def tearDown(self):
        if hasattr(ps, "_settings_ctx"):
            ps._settings = None
            ps._settings_ctx.set(None)

    def test_before_contaminates_after_isolates(self):
        construction_baseline = 30  # the manager's constructor value (fallback)

        def run_session(pid):
            settings = dict(ps.DEFAULT_AGENT_SETTINGS)
            settings["TRADECRAFT_FETCH_TIMEOUT"] = {"PA": 10, "PB": 45}[pid]
            ps._settings_ctx.set(settings)  # task-local (isolated) primary
            ps._settings = settings          # shared module global (last-writer)
            # AFTER read site: use-time read resolves from the context-local value.
            return ps.get_setting("TRADECRAFT_FETCH_TIMEOUT", construction_baseline)

        ctx_a = contextvars.copy_context()
        ctx_b = contextvars.copy_context()
        after_a = ctx_a.run(run_session, "PA")
        after_b = ctx_b.run(run_session, "PB")

        # BEFORE: the shared module global reflects only the last loader (PB).
        self.assertEqual(ps._settings["TRADECRAFT_FETCH_TIMEOUT"], 45)
        # AFTER: each context read its OWN project value (isolated).
        self.assertEqual(after_a, 10)
        self.assertEqual(after_b, 45)


class TestTradecraftResourcesIsolation(unittest.TestCase):
    """Stage 5b: the parsed tradecraft resource catalog (self._resources /
    self._by_slug) is per-session (ContextVar-backed), so the tool fetches THIS
    project's resources, consistent with the per-session prompt catalog."""

    def test_resources_isolated_per_context(self):
        try:
            from orchestrator_helpers.tradecraft_lookup import TradecraftLookupManager as M
        except Exception:
            self.skipTest("orchestrator_helpers stubbed by an earlier test (test_t14)")

        m = M(llm=None, mcp_manager=None)  # ONE shared manager instance

        def sess(rows):
            m.set_resources(rows)
            return (len(m._resources), set(m._by_slug.keys()))

        a = contextvars.copy_context().run(
            sess, [{"id": "a", "slug": "sa", "name": "n", "url": "http://a"}])
        b = contextvars.copy_context().run(
            sess, [{"id": "b1", "slug": "sb1", "name": "n", "url": "http://b"},
                   {"id": "b2", "slug": "sb2", "name": "n", "url": "http://b2"}])
        self.assertEqual(a, (1, {"sa"}))
        self.assertEqual(b, (2, {"sb1", "sb2"}))

    def test_tool_stays_registered_and_graceful_without_resources(self):
        # Presence-race fix: the tool is always registered (get_tool never None),
        # so a concurrent disabled project can't remove it from under an enabled
        # one; with no resources for THIS session it degrades gracefully.
        try:
            from orchestrator_helpers.tradecraft_lookup import TradecraftLookupManager as M
        except Exception:
            self.skipTest("orchestrator_helpers stubbed by an earlier test (test_t14)")
        import asyncio
        m = M(llm=None, mcp_manager=None)
        m.set_resources([])
        self.assertIsNotNone(m.get_tool())
        out = asyncio.run(m._invoke(resource_id="anything", query="x",
                                    cve_id=None, section_path=None, force_refresh=False))
        self.assertIn("not configured", out.lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
