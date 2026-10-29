"""Unit tests for OpenAI-compatible SSE streaming (PR #150).

Bug this fix addresses:
    A non-streaming completion against an OpenAI-compatible endpoint backed by
    a slow cloud runtime (e.g. Ollama Cloud) sends the request and then waits
    silently for the *entire* response. Long generations easily exceed 120s of
    silence, so an intermediary proxy or the client read-timeout fires
    (502 / APITimeoutError) even though generation is progressing fine.

The fix (agentic/orchestrator_helpers/llm_setup.py):
    For OpenAI-compatible providers we build ChatOpenAI with
    `streaming=True` + `stream_usage=True`. SSE keeps bytes flowing so idle
    timers never trip; `stream_usage` injects `stream_options={"include_usage":
    True}` so token accounting survives streaming. `ainvoke()` still returns a
    single aggregated AIMessage, so no caller changes.

These tests build a *real* ChatOpenAI via `setup_llm` (no network is touched
at construction time) and assert the streaming flags land on the right
providers and NOT on canonical OpenAI custom entries.

Run inside the agent container:
    python -m unittest tests.test_llm_setup_streaming
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_AGENTIC_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_AGENTIC_DIR))

from orchestrator_helpers.llm_setup import setup_llm  # noqa: E402

# Loopback base URL — passes the SSRF guard (loopback is preserved for
# self-hosted models) and requires no DNS/network at construction time.
_LOCAL_BASE = "http://127.0.0.1:11434/v1"


class OpenAICompatibleStreamingTests(unittest.TestCase):
    """custom/ providers of type `openai_compatible` must stream."""

    def _build(self, provider_type: str):
        cfg = {
            "id": "custom-test",
            "providerType": provider_type,
            "apiKey": "test-key",
            "modelIdentifier": "glm-4.5:cloud",
            "baseUrl": _LOCAL_BASE,
        }
        return setup_llm("custom/custom-test", custom_llm_config=cfg)

    def test_openai_compatible_enables_streaming(self):
        """The primary fix: openai_compatible → SSE streaming on."""
        llm = self._build("openai_compatible")
        self.assertTrue(llm.streaming, "openai_compatible must stream to avoid idle timeout")

    def test_openai_compatible_enables_stream_usage(self):
        """stream_usage must ride along so token accounting survives streaming.

        Without it OpenAI omits `usage` in streamed responses, silently
        zeroing token counts.
        """
        llm = self._build("openai_compatible")
        self.assertTrue(llm.stream_usage, "stream_usage must be on to keep token counts")

    def test_default_provider_type_streams(self):
        """providerType defaults to openai_compatible when omitted — must stream."""
        cfg = {
            "id": "custom-test",
            "apiKey": "test-key",
            "modelIdentifier": "glm-4.5:cloud",
            "baseUrl": _LOCAL_BASE,
        }
        llm = setup_llm("custom/custom-test", custom_llm_config=cfg)
        self.assertTrue(llm.streaming)
        self.assertTrue(llm.stream_usage)


class CanonicalOpenAIUnchangedTests(unittest.TestCase):
    """A custom entry of type `openai` shares the same code branch but must
    NOT be forced into streaming — the fix is scoped to openai_compatible."""

    def test_canonical_openai_custom_not_streamed(self):
        cfg = {
            "id": "custom-oai",
            "providerType": "openai",
            "apiKey": "sk-test",
            "modelIdentifier": "gpt-4o",
        }
        llm = setup_llm("custom/custom-oai", custom_llm_config=cfg)
        self.assertFalse(
            llm.streaming,
            "canonical OpenAI providers must keep their default (non-streaming) behavior",
        )


class LegacyOpenAICompatEnvPathTests(unittest.TestCase):
    """The legacy env-based `openai_compat/<model>` path (second hunk) also
    enables streaming, since it is OpenAI-compatible by definition."""

    def test_legacy_env_path_streams(self):
        llm = setup_llm(
            "openai_compat/glm-4.5:cloud",
            openai_compat_base_url=_LOCAL_BASE,
            openai_compat_api_key="ollama",
        )
        self.assertTrue(llm.streaming)
        self.assertTrue(llm.stream_usage)


if __name__ == "__main__":
    unittest.main()
