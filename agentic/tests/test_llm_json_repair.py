"""Regression tests for conservative LLM JSON delimiter recovery."""

import json
import unittest

from orchestrator_helpers.json_utils import repair_trailing_json_delimiters
from orchestrator_helpers.parsing import try_parse_llm_decision


def _plan_decision() -> dict:
    return {
        "thought": "Run two independent discovery tools.",
        "reasoning": "The tools cover independent surfaces.",
        "action": "plan_tools",
        "tool_plan": {
            "steps": [
                {
                    "tool_name": "execute_httpx",
                    "tool_args": {"args": "-u http://example.test"},
                    "rationale": "Fingerprint HTTP.",
                },
                {
                    "tool_name": "execute_ffuf",
                    "tool_args": {"args": "-u http://example.test/FUZZ"},
                    "rationale": "Discover paths.",
                },
            ],
            "plan_rationale": "Independent discovery calls.",
        },
        "updated_todo_list": [],
        "output_analysis": {
            "interpretation": "The previous graph result was sparse.",
            "productivity": {
                "verdict": "no_progress",
                "new_information_gained": False,
                "what_was_new": "",
                "should_repeat_similar_call": False,
                "rationale": "No web endpoint was identified.",
            },
            "chain_findings": [],
        },
    }


class TrailingJsonRepairTests(unittest.TestCase):
    def test_recovers_missing_outer_object_brace_from_fenced_response(self):
        raw = json.dumps(_plan_decision(), indent=2)
        response = f"```json\n{raw[:-1]}\n```"

        decision, error = try_parse_llm_decision(response)

        self.assertIsNone(error)
        self.assertIsNotNone(decision)
        self.assertEqual(decision.action, "plan_tools")
        self.assertEqual(len(decision.tool_plan.steps), 2)
        self.assertEqual(decision.output_analysis.productivity.verdict, "no_progress")

    def test_recovers_multiple_missing_trailing_delimiters(self):
        repaired = repair_trailing_json_delimiters('{"items": [{"id": 1')

        self.assertEqual(json.loads(repaired), {"items": [{"id": 1}]})

    def test_does_not_repair_missing_internal_comma(self):
        malformed = (
            '{"thought": "x" "reasoning": "y", "action": "complete", '
            '"completion_reason": "done"}'
        )

        decision, error = try_parse_llm_decision(malformed)

        self.assertIsNone(decision)
        self.assertIn("Invalid JSON", error)

    def test_does_not_repair_unterminated_string(self):
        self.assertIsNone(repair_trailing_json_delimiters('{"thought": "unfinished'))


if __name__ == "__main__":
    unittest.main()
