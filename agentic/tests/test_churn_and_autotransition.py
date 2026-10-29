"""Tests for Proposal 1 (behavior-triggered auto-transition) and Proposal 3
(churn-aware productivity score).

Covers:
  - detect_chain_advance: DEPTH signal (confirmed finding / foothold) vs
    map-growth (new endpoint) which must NOT count as an advance.
  - compute_productivity_score novelty saturation: with the chain-advance counter
    past the grace window, the novelty reward decays so pure enumeration stops
    pinning the score to green. isca=0 must be byte-identical to legacy behavior.
  - should_auto_transition_on_skill: offensive skill in informational -> transition;
    unclassified / already-exploiting / empty -> no transition.
"""
import pytest

from orchestrator_helpers.productivity import (
    detect_chain_advance,
    detect_state_growth,
    compute_productivity_score,
)
from state import should_auto_transition_on_skill


# --------------------------------------------------------------------------- #
# detect_chain_advance
# --------------------------------------------------------------------------- #
def _st(endpoints=0, vulns=0, creds=0, sessions=0, findings=0):
    return {
        "target_info": {
            "endpoints": [f"e{i}" for i in range(endpoints)],
            "vulnerabilities": [f"v{i}" for i in range(vulns)],
            "credentials": [f"c{i}" for i in range(creds)],
            "sessions": [f"s{i}" for i in range(sessions)],
        },
        "chain_findings_memory": [{"i": i} for i in range(findings)],
    }


def test_chain_advance_ignores_map_growth():
    # A newly discovered endpoint is map-growth (breadth), NOT a chain advance.
    before, after = _st(endpoints=1), _st(endpoints=5)
    assert detect_state_growth(before, after) is True    # state DID grow (map)
    assert detect_chain_advance(before, after) is False  # but chain did NOT advance


def test_chain_advance_ignores_vuln_candidates():
    # target_info.vulnerabilities are candidates (map), not confirmed findings.
    before, after = _st(vulns=1), _st(vulns=4)
    assert detect_chain_advance(before, after) is False


def test_chain_advance_on_confirmed_finding():
    before, after = _st(findings=0), _st(findings=1)
    assert detect_chain_advance(before, after) is True


def test_chain_advance_on_foothold():
    assert detect_chain_advance(_st(creds=0), _st(creds=1)) is True
    assert detect_chain_advance(_st(sessions=0), _st(sessions=1)) is True


def test_chain_advance_none_on_no_change():
    s = _st(endpoints=3, findings=2)
    assert detect_chain_advance(s, s) is False


# --------------------------------------------------------------------------- #
# compute_productivity_score — novelty saturation
# --------------------------------------------------------------------------- #
def _novel_trace(n=5):
    return [
        {"productivity": {"verdict": "new_info", "new_information_gained": True}}
        for _ in range(n)
    ]


def _score(isca, grace=3, stall=5):
    return compute_productivity_score(
        execution_trace=_novel_trace(5),
        tested_axes={},
        iterations_since_state_grew=stall,
        iteration=10,
        max_iterations=100,
        phase="informational",
        iterations_since_chain_advance=isca,
        novelty_saturation_grace=grace,
    )


def test_novelty_scale_is_1_within_grace():
    # isca <= grace => scale 1.0 => novelty at full strength.
    s = _score(isca=3, grace=3)
    assert s["components"]["novelty_scale"] == 1.0


def test_novelty_scale_decays_past_grace():
    s = _score(isca=13, grace=3)  # sat = 10 -> 1/11
    assert 0.0 < s["components"]["novelty_scale"] < 1.0


def test_saturation_raises_score_when_churning():
    # Same trace + same badness, but many iterations without a chain advance:
    # novelty stops cancelling badness, so the score must be HIGHER (more stuck).
    low = _score(isca=0)     # full novelty credit (legacy behaviour)
    high = _score(isca=20)   # heavily saturated
    assert high["score"] > low["score"], (low["score"], high["score"])


def test_isca_zero_is_legacy_identical():
    # The default path (isca=0) must reproduce the pre-churn score exactly, so
    # existing callers/tests are unaffected.
    legacy = compute_productivity_score(
        execution_trace=_novel_trace(5), tested_axes={},
        iterations_since_state_grew=5, iteration=10, max_iterations=100,
        phase="informational",
    )
    with_default = _score(isca=0)
    assert legacy["score"] == with_default["score"]
    assert legacy["weighted"]["new_info_events"] == with_default["weighted"]["new_info_events"]


def test_chain_advance_resets_novelty_credit():
    # After a chain advance (isca back to 0), novelty is at full strength again ->
    # score returns to the low (healthy) value.
    stuck = _score(isca=20)
    recovered = _score(isca=0)
    assert recovered["score"] < stuck["score"]


# --------------------------------------------------------------------------- #
# should_auto_transition_on_skill
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("skill", ["rce", "sql_injection", "xss", "ssrf",
                                    "path_traversal", "cve_exploit",
                                    "brute_force_credential_guess", "user_skill:42"])
def test_auto_transition_offensive_in_informational(skill):
    assert should_auto_transition_on_skill(skill, "informational") is True


def test_no_transition_when_already_exploiting():
    assert should_auto_transition_on_skill("rce", "exploitation") is False
    assert should_auto_transition_on_skill("rce", "post_exploitation") is False


def test_no_transition_for_unclassified():
    assert should_auto_transition_on_skill("web-unclassified", "informational") is False


def test_no_transition_for_empty():
    assert should_auto_transition_on_skill("", "informational") is False
    assert should_auto_transition_on_skill(None, "informational") is False
