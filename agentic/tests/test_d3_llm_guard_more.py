"""
D3 — additional coverage for the billed-LLM guard, complementing
test_d3_llm_guard.py. Focuses on paths that unit tests alone don't reach:

  * the DAILY-CAP 429 through the real FastAPI dependency (the unit test only
    exercises _DailyCap in isolation),
  * the ORDERING guarantee: a request denied by the rate limiter must NOT also
    consume a slot from the daily spend cap (rate-limit is checked first),
  * robustness of body parsing: a malformed / non-JSON body must degrade to the
    'anonymous' principal and never 500 the guard,
  * the camelCase ``userId`` extraction path used by some webapp proxies.

Run:  python -m unittest tests.test_d3_llm_guard_more -v
"""

import os
import unittest
from unittest import mock

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

import llm_guard
from llm_guard import _DailyCap, _TokenBucket, require_internal_auth

SECRET = "the-secret"
HDR = {"x-internal-key": SECRET}


def _app(counter):
    app = FastAPI()

    @app.post("/llm/fake", dependencies=[Depends(require_internal_auth)])
    async def fake(payload: dict):
        counter["n"] += 1
        return {"ok": True}

    return app


class TestDailyCapEndToEnd(unittest.TestCase):
    def setUp(self):
        llm_guard.reset_state()
        self.invoked = {"n": 0}
        self.client = TestClient(_app(self.invoked))

    def test_daily_cap_429_blocks_billed_handler(self):
        """Exceeding the daily spend cap returns 429 with its own message and
        the billed handler stops running."""
        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": SECRET}, clear=False), \
             mock.patch.object(llm_guard, "_daily_cap", _DailyCap(cap=2)):
            codes = [
                self.client.post("/llm/fake", json={"user_id": "u"}, headers=HDR)
                for _ in range(3)
            ]
            self.assertEqual([r.status_code for r in codes], [200, 200, 429])
            self.assertIn("Daily", codes[-1].json()["detail"])
            self.assertEqual(self.invoked["n"], 2, "billed handler ran exactly cap times")


class TestOrdering(unittest.TestCase):
    """A rate-limited (429) request must not silently burn daily-cap budget."""

    def setUp(self):
        llm_guard.reset_state()
        self.invoked = {"n": 0}
        self.client = TestClient(_app(self.invoked))

    def test_rate_limited_request_does_not_consume_daily_cap(self):
        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": SECRET}, clear=False), \
             mock.patch.object(llm_guard, "_rate_limiter", _TokenBucket(1, 0.0)), \
             mock.patch.object(llm_guard, "_daily_cap", _DailyCap(cap=100)):
            r1 = self.client.post("/llm/fake", json={"user_id": "u"}, headers=HDR)
            r2 = self.client.post("/llm/fake", json={"user_id": "u"}, headers=HDR)
            self.assertEqual(r1.status_code, 200)
            self.assertEqual(r2.status_code, 429)  # rate limiter, not the cap
            # Only the allowed request should have touched the daily cap.
            count, _ = llm_guard._daily_cap._state["u"]
            self.assertEqual(count, 1, "rate-limited call must not consume daily budget")


class TestBodyParsingRobustness(unittest.TestCase):
    def setUp(self):
        llm_guard.reset_state()
        self.invoked = {"n": 0}
        self.client = TestClient(_app(self.invoked))

    def test_malformed_body_with_valid_key_does_not_500(self):
        """Non-JSON body must not crash the guard; principal degrades to
        'anonymous' and auth still succeeds with a valid key."""
        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": SECRET}, clear=False):
            r = self.client.post(
                "/llm/fake",
                content=b"not-json-at-all",
                headers={**HDR, "content-type": "application/json"},
            )
            # 200 (guard passes) — the route's own body parsing may 422, but the
            # guard itself must never 500 on a bad body.
            self.assertNotEqual(r.status_code, 500)
            self.assertIn(r.status_code, (200, 422))

    def test_malformed_body_without_key_is_rejected_not_500(self):
        """A malformed body with no key must be rejected (401 auth, or 422 from
        FastAPI body validation which may run first) and NEVER reach the billed
        handler or 500. Either rejection is safe: no LLM call, no budget spent."""
        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": SECRET}, clear=False):
            r = self.client.post(
                "/llm/fake",
                content=b"}{garbage",
                headers={"content-type": "application/json"},
            )
            self.assertIn(r.status_code, (401, 422))
            self.assertEqual(self.invoked["n"], 0, "billed handler must not run")


class TestUserIdExtraction(unittest.TestCase):
    """camelCase userId (webapp proxy shape) must key the rate limiter."""

    def setUp(self):
        llm_guard.reset_state()
        self.invoked = {"n": 0}
        self.client = TestClient(_app(self.invoked))

    def test_camelcase_userId_keys_the_bucket(self):
        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": SECRET}, clear=False), \
             mock.patch.object(llm_guard, "_rate_limiter", _TokenBucket(5, 0.0)):
            r = self.client.post("/llm/fake", json={"userId": "camel"}, headers=HDR)
            self.assertEqual(r.status_code, 200)
            keys = list(llm_guard._rate_limiter._state.keys())
            self.assertTrue(any(k.startswith("camel|") for k in keys),
                            f"expected a bucket keyed by userId, got {keys}")

    def test_missing_user_id_falls_back_to_anonymous(self):
        with mock.patch.dict(os.environ, {"INTERNAL_API_KEY": SECRET}, clear=False), \
             mock.patch.object(llm_guard, "_rate_limiter", _TokenBucket(5, 0.0)):
            r = self.client.post("/llm/fake", json={"foo": "bar"}, headers=HDR)
            self.assertEqual(r.status_code, 200)
            keys = list(llm_guard._rate_limiter._state.keys())
            self.assertTrue(any(k.startswith("anonymous|") for k in keys),
                            f"expected an anonymous bucket, got {keys}")


if __name__ == "__main__":
    unittest.main()
