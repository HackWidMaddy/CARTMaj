"""Durability: the _exploit_tree state key must survive a real LangGraph
checkpoint round-trip (§18.1), which requires it to be a DECLARED AgentState
field (§20.1 — LangGraph strips undeclared keys on merge). This test proves both
by round-tripping through a compiled StateGraph + MemorySaver and asserting the
tree persists while an undeclared key is stripped.
"""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from unittest.mock import MagicMock  # noqa: E402
from langgraph.graph import StateGraph, START, END  # noqa: E402
from langgraph.checkpoint.memory import MemorySaver  # noqa: E402

from state import AgentState, ExploitTree, ExploitTreeNode  # noqa: E402

# Another focused-suite test (test_tool_confirmation) stubs langgraph modules
# into sys.modules process-wide. This durability test needs the REAL langgraph;
# if it was collected after that stubbing, StateGraph/MemorySaver are MagicMocks
# and we skip rather than error. Run standalone (or collected first) to exercise
# it for real. See run_tests.sh ordering.
_LANGGRAPH_REAL = not isinstance(StateGraph, MagicMock) and not isinstance(MemorySaver, MagicMock)


def _seed_node(state):
    tree = ExploitTree(
        root_id="root",
        nodes={"root": ExploitTreeNode(id="root", status="evaluated")},
        objective="admin takeover",
        rollouts=3,
    )
    return {
        "_exploit_tree": tree.model_dump(),
        "deep_think_ran_this_turn": True,
        "guidance_drained_this_turn": False,
        # An UNDECLARED key: LangGraph must strip it on merge.
        "_undeclared_lats_key": 123,
    }


def _build_app():
    g = StateGraph(AgentState)
    g.add_node("seed", _seed_node)
    g.add_edge(START, "seed")
    g.add_edge("seed", END)
    return g.compile(checkpointer=MemorySaver())


@unittest.skipUnless(_LANGGRAPH_REAL, "langgraph stubbed in-process by another test; run standalone")
class TestCheckpointRoundTrip(unittest.TestCase):
    def test_exploit_tree_survives_checkpoint(self):
        app = _build_app()
        config = {"configurable": {"thread_id": "lats-cp-1"}}
        app.invoke({"messages": []}, config)

        snap = app.get_state(config)
        values = snap.values

        # The declared LATS keys round-trip.
        self.assertIsNotNone(values.get("_exploit_tree"))
        self.assertTrue(values.get("deep_think_ran_this_turn"))

        # ...and the tree deserializes back into an ExploitTree, so the search
        # can resume verbatim after a restart.
        tree = ExploitTree(**values["_exploit_tree"])
        self.assertEqual(tree.rollouts, 3)
        self.assertEqual(tree.objective, "admin takeover")
        self.assertIn("root", tree.nodes)

    def test_undeclared_key_is_stripped(self):
        # Guards the §20.1 rationale: an undeclared key does NOT survive, which
        # is exactly why every LATS state field must be declared on AgentState.
        app = _build_app()
        config = {"configurable": {"thread_id": "lats-cp-2"}}
        app.invoke({"messages": []}, config)
        values = app.get_state(config).values
        self.assertNotIn("_undeclared_lats_key", values)


if __name__ == "__main__":
    unittest.main()
