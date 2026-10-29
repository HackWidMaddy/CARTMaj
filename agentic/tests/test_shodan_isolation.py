"""
Tier 3 / Stage 2: Shodan enable/disable is a per-session gate read at
execute-time from the task-isolated SHODAN_ENABLED setting, instead of swapping
the tool in/out of the shared registry (which raced across concurrent sessions).
"""
import os
import unittest
from unittest.mock import MagicMock, AsyncMock

os.environ.setdefault("WEBAPP_API_URL", "http://fake-webapp")
import project_settings as ps
from tools import PhaseAwareToolExecutor


def _make_executor():
    shodan_tool = MagicMock()
    shodan_tool.name = "shodan"
    shodan_tool.ainvoke = AsyncMock(return_value="shodan-ok")
    # ctor: (mcp_manager, graph_tool, web_search_tool, shodan_tool, google_dork_tool, tradecraft_tool)
    return PhaseAwareToolExecutor(MagicMock(), MagicMock(), MagicMock(), shodan_tool, None, None)


class TestShodanGate(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        ps._settings = None
        ps._settings_ctx.set(None)

    def tearDown(self):
        ps._settings = None
        ps._settings_ctx.set(None)

    async def test_disabled_blocks_shodan(self):
        ps._settings = {**ps.DEFAULT_AGENT_SETTINGS, "SHODAN_ENABLED": False}
        ex = _make_executor()
        res = await ex.execute(
            "shodan", {"action": "host", "query": "1.1.1.1"},
            "reconnaissance", skip_phase_check=True,
        )
        self.assertFalse(res["success"])
        self.assertIn("disabled", (res.get("error") or "").lower())

    async def test_enabled_does_not_block(self):
        ps._settings = {**ps.DEFAULT_AGENT_SETTINGS, "SHODAN_ENABLED": True}
        ex = _make_executor()
        res = await ex.execute(
            "shodan", {"action": "host", "query": "1.1.1.1"},
            "reconnaissance", skip_phase_check=True,
        )
        # The gate must NOT block when enabled (no "disabled" error).
        self.assertNotIn("disabled", (res.get("error") or "").lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
