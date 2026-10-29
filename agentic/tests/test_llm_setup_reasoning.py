"""Unit tests for per-provider Ollama reasoning controls."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

_AGENTIC_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_AGENTIC_DIR))

from langchain_core.messages import HumanMessage  # noqa: E402
from orchestrator_helpers.llm_setup import setup_llm  # noqa: E402


class OllamaReasoningControlTests(unittest.TestCase):
    def _build(
        self,
        *,
        enabled: bool,
        effort: str = "high",
        base_url: str = "http://127.0.0.1:11434/v1",
    ):
        return setup_llm(
            "custom/ollama-test",
            custom_llm_config={
                "providerType": "openai_compatible",
                "modelIdentifier": "gemma4:latest",
                "baseUrl": base_url,
                "reasoningEnabled": enabled,
                "reasoningEffort": effort,
            },
        )

    def test_disabled_sends_nothing(self):
        # Disabled means no reasoning_effort at all, so the model's own default
        # thinking behavior is preserved (no auto "none").
        llm = self._build(enabled=False)
        self.assertIsNone(llm.reasoning_effort)
        payload = llm._get_request_payload([HumanMessage(content="Hello")])
        self.assertNotIn("reasoning_effort", payload)

    def test_all_supported_effort_levels_are_forwarded(self):
        for effort in ("low", "medium", "high", "max"):
            with self.subTest(effort=effort):
                llm = self._build(enabled=True, effort=effort)
                self.assertEqual(llm.reasoning_effort, effort)
                payload = llm._get_request_payload([HumanMessage(content="Hello")])
                self.assertEqual(payload["reasoning_effort"], effort)

    def test_disabled_non_ollama_provider_sends_nothing(self):
        llm = self._build(
            enabled=False,
            base_url="https://api.example.com/v1",
        )
        self.assertIsNone(llm.reasoning_effort)

    def test_enabled_reverse_proxy_still_receives_reasoning_effort(self):
        llm = self._build(
            enabled=True,
            effort="medium",
            base_url="https://llm-gateway.example.com/v1",
        )
        self.assertEqual(llm.reasoning_effort, "medium")

    def test_invalid_effort_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Invalid reasoning effort"):
            self._build(enabled=True, effort="extreme")


if __name__ == "__main__":
    unittest.main()
