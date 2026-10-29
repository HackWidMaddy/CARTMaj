"""Integration + wiring tests for Proposal 1 (behavior-triggered auto-transition)
and Proposal 3 (churn-aware productivity score).

INTEGRATION — exercises the real score function over a simulated "stuck in recon"
trajectory and asserts the emergent behavior: prolonged map-growth WITHOUT a
chain-advance escalates the score through the tier ladder (so Deep Think / LATS
fire), and a chain-advance resets the pressure. This is the end-to-end intent of
Proposal 3 (the pure-unit tests only check the pieces).

WIRING — source-inspection locks that think_node actually wires the helpers in
(the repo convention for the giant think_node — see test_switch_skill.py — is to
inspect source rather than build a full LangGraph fixture).
"""
import inspect

from orchestrator_helpers.productivity import compute_productivity_score, tier_for_score
from orchestrator_helpers.nodes import think_node as think_mod

DEEPTHINK = 4.0
GRACE = 3


def _recon_trace(n=5):
    # Distinct probes each returning a NEW endpoint => new_info verdict, but no
    # same-pattern loop and no chain-advance. This is the 056 shape: the agent
    # looks productive (finds something every turn) yet never confirms a sink.
    return [
        {
            "tool_name": "execute_curl",
            "tool_args": {"u": f"/path{i}"},
            "tool_output": f"discovered endpoint {i}",
            "productivity": {"verdict": "new_info", "new_information_gained": True},
        }
        for i in range(n)
    ]


def _score_at(isca, stall=0, iteration=10):
    return compute_productivity_score(
        execution_trace=_recon_trace(5),
        tested_axes={},
        iterations_since_state_grew=stall,   # map-growth keeps this 0 (the whole bug)
        iteration=iteration,
        max_iterations=100,
        phase="informational",
        iterations_since_chain_advance=isca,
        novelty_saturation_grace=GRACE,
    )


# --------------------------------------------------------------------------- #
# INTEGRATION — emergent escalation
# --------------------------------------------------------------------------- #
def test_pure_recon_churn_escalates_past_deepthink():
    """The exact 056 failure: enumerate forever, stall stays 0, score used to sit
    at green. With churn-aware on, the score must climb past the Deep Think
    threshold within a bounded number of iterations."""
    crossed_at = None
    for isca in range(1, 16):
        s = _score_at(isca)
        if s["score"] >= DEEPTHINK and crossed_at is None:
            crossed_at = isca
    assert crossed_at is not None, "churn-aware score never reached the Deep Think tier"
    assert crossed_at <= 12, f"escalated too slowly (isca={crossed_at})"


def test_churn_aware_disabled_stays_green():
    """With the toggle off (call site passes isca=0), the SAME churning trajectory
    stays green — proving the escalation is entirely attributable to the counter
    and that disabling it restores legacy behavior."""
    s = _score_at(isca=0)
    assert tier_for_score(s["score"], deepthink_threshold=DEEPTHINK) == "green"


def test_chain_advance_resets_pressure():
    """A confirmed finding / foothold drops isca back to 0; the score must fall
    back out of the escalated band on the very next evaluation."""
    stuck = _score_at(isca=12)
    recovered = _score_at(isca=0)
    assert stuck["score"] >= DEEPTHINK
    assert recovered["score"] < DEEPTHINK
    assert recovered["score"] < stuck["score"]


def test_chain_stall_is_capped():
    """isca beyond the cap (10) must not grow the badness without bound."""
    a = _score_at(isca=10)
    b = _score_at(isca=50)
    assert a["components"]["chain_stall"] == b["components"]["chain_stall"] == (10 - GRACE)


def test_grace_window_gives_recon_room():
    """Within the grace window the score is NOT penalized — legitimate early recon
    must not be punished."""
    for isca in range(0, GRACE + 1):
        s = _score_at(isca)
        assert s["components"]["chain_stall"] == 0
        assert s["components"]["novelty_scale"] == 1.0


# --------------------------------------------------------------------------- #
# WIRING — lock the think_node integration by source inspection
# --------------------------------------------------------------------------- #
def test_think_node_passes_chain_advance_to_score():
    src = inspect.getsource(think_mod)
    assert "iterations_since_chain_advance=" in src, "score call not wired to the chain counter"
    assert "PRODUCTIVITY_CHURN_AWARE" in src, "churn-aware toggle not consulted"


def test_think_node_updates_chain_counter_both_paths():
    src = inspect.getsource(think_mod)
    # Both the single-tool path and the wave path must maintain the counter.
    assert src.count('updates["_iterations_since_chain_advance"]') >= 2, \
        "chain-advance counter not updated on both step-completion paths"
    assert "detect_chain_advance(" in src


def test_think_node_wires_auto_transition():
    src = inspect.getsource(think_mod)
    assert "should_auto_transition_on_skill(" in src, "auto-transition helper not called"
    assert "AUTO_TRANSITION_ON_ATTACK_SKILL" in src, "auto-transition toggle not consulted"
    # Must honor the approval gate and only flip to exploitation.
    assert "REQUIRE_APPROVAL_FOR_EXPLOITATION" in src
    assert 'updates["current_phase"] = "exploitation"' in src
