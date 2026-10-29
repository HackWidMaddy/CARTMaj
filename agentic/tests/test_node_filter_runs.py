"""Node filters on the agent: the preview gate and the apply-run lifecycle.

What is pinned:
  - a preview is a dry run with a deadline, one per project and two in total;
  - an apply applies the rules READ BACK FROM THE RUN, never a request body;
  - it heartbeats, stops when the webapp says so or stops answering, and always
    reports how it ended; the stats it reports carry counts, never finding text;
  - the endpoints refuse a weak key, a malformed run id and a duplicate start.
"""
import json
import os
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import api  # noqa: E402
import node_filter_runs as nfr  # noqa: E402

RUN = {
    "id": "run1", "projectId": "p1", "userId": "u1", "status": "running",
    "mode": "denylist", "revision": 7,
    "rules": {"version": 1, "kinds": {"vuln.nuclei": {"enabled": True, "action": "mute", "rules": []}}},
    "exemptions": [["Vulnerability", "v1"]],
}

STATS = {
    "ok": True, "mode": "denylist", "partial": False, "totals": {"muted": 2},
    "kinds": {"vuln.nuclei": {"active": True, "muted": 2, "missing": {"severity": 1},
                              "rules": {"k3f9a2": {"name": "Info", "matched": 2,
                                                   "samples": [{"name": "secret finding text"}]}}}},
    "errors": [],
}


class FakeGraph:
    def __init__(self, stats=None, raises=None, gate=None):
        self.stats = stats or STATS
        self.raises = raises
        self.gate = gate
        self.calls = []

    def apply_node_filters(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        if self.gate:
            self.gate.wait(5)
        if kwargs.get("heartbeat"):
            kwargs["heartbeat"]({"kind": "vuln.nuclei", "scanned": 10})
        if self.raises:
            raise self.raises
        return self.stats


class FakeRunClient:
    def __init__(self, run=None, abort=None):
        self.run = run or RUN
        self.abort = abort
        self.finished = []
        self.beats = []

    def fetch(self):
        return self.run

    def heartbeat(self, progress=None):
        self.beats.append(progress)
        if self.abort:
            raise nfr.NodeFilterRunAborted(self.abort)

    def finish(self, status, stats=None, error=None):
        self.finished.append((status, stats, error))


class TestPreview(unittest.TestCase):
    def test_is_a_dry_run_with_a_deadline(self):
        g = FakeGraph()
        nfr.preview(g, "u1", "p1", "denylist", RUN["rules"], exemptions=[["Secret", "s1"]])
        (args, kwargs), = g.calls
        self.assertEqual(args[:3], ("u1", "p1", {"mode": "denylist", "rules": RUN["rules"]}))
        self.assertTrue(kwargs["dry_run"])
        self.assertIsNotNone(kwargs["deadline"])
        self.assertEqual(kwargs["exemptions"], [("Secret", "s1")])

    def _hold(self, project, gate, errors):
        try:
            nfr.preview(FakeGraph(gate=gate), "u1", project, "denylist", None)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    def test_one_per_project_and_two_in_total(self):
        gate, errors = threading.Event(), []
        threads = [threading.Thread(target=self._hold, args=(p, gate, errors)) for p in ("p1", "p2")]
        for t in threads:
            t.start()
        for _ in range(100):
            if len(nfr._preview_projects) == 2:
                break
            threading.Event().wait(0.01)
        with self.assertRaises(nfr.PreviewBusy):
            nfr.preview(FakeGraph(), "u1", "p1", "denylist", None)
        with self.assertRaises(nfr.PreviewBusy):
            nfr.preview(FakeGraph(), "u1", "p3", "denylist", None)
        gate.set()
        for t in threads:
            t.join(5)
        self.assertEqual(errors, [])
        # Both slots are free again.
        nfr.preview(FakeGraph(), "u1", "p1", "denylist", None)

    def test_a_failed_preview_frees_its_slot(self):
        with self.assertRaises(RuntimeError):
            nfr.preview(FakeGraph(raises=RuntimeError("neo4j down")), "u1", "p9", "denylist", None)
        self.assertNotIn("p9", nfr._preview_projects)
        nfr.preview(FakeGraph(), "u1", "p9", "denylist", None)


class TestApply(unittest.TestCase):
    def test_applies_what_the_run_row_holds(self):
        g, rc = FakeGraph(), FakeRunClient()
        status = nfr.run_apply("run1", lambda: g, run_client=rc)
        self.assertEqual(status, "completed")
        (args, kwargs), = g.calls
        self.assertEqual(args, ("u1", "p1", {"mode": "denylist", "rules": RUN["rules"]}))
        self.assertEqual(kwargs["exemptions"], [("Vulnerability", "v1")])
        self.assertEqual(kwargs["heartbeat"], rc.heartbeat)
        self.assertFalse(kwargs.get("dry_run", False))

    def test_the_reported_stats_carry_counts_never_finding_text(self):
        rc = FakeRunClient()
        nfr.run_apply("run1", lambda: FakeGraph(), run_client=rc)
        (status, stats, error), = rc.finished
        self.assertEqual((status, error), ("completed", None))
        self.assertEqual(stats["kinds"]["vuln.nuclei"]["rules"], {"k3f9a2": 2})
        self.assertNotIn("secret finding text", str(stats))
        self.assertNotIn("missing", stats["kinds"]["vuln.nuclei"])

    def test_the_webapp_can_stop_it(self):
        rc = FakeRunClient(abort="a version activation started")
        self.assertEqual(nfr.run_apply("run1", lambda: FakeGraph(), run_client=rc), "stopped")
        self.assertEqual(rc.finished[0][0], "stopped")
        self.assertEqual(rc.finished[0][2], "a version activation started")

    def test_a_crash_is_reported_as_failed(self):
        rc = FakeRunClient()
        nfr.run_apply("run1", lambda: FakeGraph(raises=RuntimeError("neo4j down")), run_client=rc)
        self.assertEqual(rc.finished[0][0], "failed")
        self.assertIn("neo4j down", rc.finished[0][2])

    def test_a_graph_client_that_cannot_be_built_is_reported_too(self):
        rc = FakeRunClient()

        def broken():
            raise RuntimeError("no driver")
        nfr.run_apply("run1", broken, run_client=rc)
        self.assertEqual(rc.finished[0][0], "failed")

    def test_unusable_rules_fail_the_run(self):
        rc = FakeRunClient()
        nfr.run_apply("run1", lambda: FakeGraph(stats={"ok": False, "error": "unreadable rules"}),
                      run_client=rc)
        self.assertEqual(rc.finished[0][0], "failed")
        self.assertEqual(rc.finished[0][2], "unreadable rules")

    def test_a_run_that_is_no_longer_running_is_left_alone(self):
        g, rc = FakeGraph(), FakeRunClient(run={**RUN, "status": "stopped"})
        self.assertEqual(nfr.run_apply("run1", lambda: g, run_client=rc), "stopped")
        self.assertEqual(g.calls, [])
        self.assertEqual(rc.finished, [])


class FakeResponse:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body or {}
        self.content = b"x"

    def json(self):
        return self._body


RUN_CALLBACKS_CONTRACT = (Path(__file__).resolve().parents[2]
                          / "webapp/src/lib/nodeFilters/contracts/run_callbacks.json")


class TestRunClientResources(unittest.TestCase):
    def test_run_client_http_pool_leak(self):
        # Every apply built an httpx.Client and never closed it: one leaked
        # connection pool per apply, for the life of the agent.
        pool = mock.Mock()
        pool.get.return_value = FakeResponse(404)
        pool.post.return_value = FakeResponse(200)
        with mock.patch.object(nfr.httpx, "Client", return_value=pool):
            nfr.run_apply("run1", lambda: FakeGraph())
        pool.close.assert_called_once_with()

    def test_a_client_it_was_handed_is_left_open(self):
        http = mock.Mock()
        http.get.return_value = FakeResponse(200, RUN)
        http.post.return_value = FakeResponse(200, {"abort": False})
        nfr.run_apply("run1", lambda: FakeGraph(),
                      run_client=nfr.NodeFilterRunClient("run1", http=http))
        http.close.assert_not_called()


class TestWebappContract(unittest.TestCase):
    def test_the_bodies_sent_to_the_webapp_are_the_ones_its_routes_replay(self):
        # nodeFilterRuns.routes.test.ts posts this same file to the heartbeat and
        # finish routes. If the agent's bodies drift from what those routes read,
        # a run's progress and final counts are silently dropped.
        # Regenerate with NODE_FILTER_CONTRACT_WRITE=1 after a deliberate change.
        http = mock.Mock()
        http.get.return_value = FakeResponse(200, RUN)
        http.post.return_value = FakeResponse(200, {"status": "running", "abort": False})
        ticks = iter(range(0, 10_000, 31))  # every clock read is one heartbeat interval later
        client = nfr.NodeFilterRunClient("run1", http=http, clock=lambda: next(ticks))

        self.assertEqual(nfr.run_apply("run1", lambda: FakeGraph(), run_client=client), "completed")
        sent = {call.args[0].rsplit("/", 1)[-1]: call.kwargs["json"] for call in http.post.call_args_list}
        self.assertEqual(set(sent), {"heartbeat", "finish"})

        if os.environ.get("NODE_FILTER_CONTRACT_WRITE") == "1":
            RUN_CALLBACKS_CONTRACT.write_text(json.dumps(sent, indent=2, sort_keys=True) + "\n")
        self.assertEqual(sent, json.loads(RUN_CALLBACKS_CONTRACT.read_text()))


class TestHeartbeat(unittest.TestCase):
    def _client(self, responses):
        http = mock.Mock()
        http.post.side_effect = responses
        now = [0.0]
        client = nfr.NodeFilterRunClient("run1", http=http, clock=lambda: now[0])
        return client, http, now

    def test_checks_in_at_most_every_thirty_seconds_with_progress(self):
        client, http, now = self._client([FakeResponse(200, {"abort": False})])
        client.heartbeat({"kind": "vuln.nuclei", "scanned": 100})
        self.assertEqual(http.post.call_count, 0)
        now[0] = 31
        client.heartbeat({"kind": "secret", "scanned": 5})
        self.assertEqual(http.post.call_count, 1)
        self.assertEqual(http.post.call_args.kwargs["json"], {"progress": {"scanned": 105}})
        self.assertTrue(http.post.call_args.args[0].endswith("/api/internal/node-filter-runs/run1/heartbeat"))

    def test_an_abort_stops_the_sweep(self):
        client, _http, now = self._client([FakeResponse(200, {"abort": True, "reason": "Stop pressed"})])
        now[0] = 31
        with self.assertRaises(nfr.NodeFilterRunAborted) as ctx:
            client.heartbeat()
        self.assertEqual(ctx.exception.reason, "Stop pressed")

    def test_two_failures_in_a_row_stop_it(self):
        client, _http, now = self._client([ConnectionError("down"), FakeResponse(500)])
        now[0] = 31
        client.heartbeat()
        now[0] = 62
        with self.assertRaises(nfr.NodeFilterRunAborted):
            client.heartbeat()

    def test_the_master_key_is_sent(self):
        client, http, now = self._client([FakeResponse(200, {"abort": False})])
        now[0] = 31
        with mock.patch.dict("os.environ", {"INTERNAL_API_KEY": "master"}):
            client.heartbeat()
        self.assertEqual(http.post.call_args.kwargs["headers"], {"X-Internal-Key": "master"})


class TestEndpoints(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._patches = [mock.patch.object(api, "master_key_is_weak", lambda: False)]
        for p in self._patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self._patches])

    def test_preview_busy_is_429(self):
        with mock.patch.object(api, "_triage_graph_client", lambda: FakeGraph()), \
             mock.patch("node_filter_runs.preview", side_effect=nfr.PreviewBusy("busy")):
            resp = api.node_filters_preview(api.NodeFilterPreviewRequest(
                user_id="u1", project_id="p1", mode="denylist"))
        self.assertEqual(resp.status_code, 429)

    def test_preview_returns_the_counts(self):
        with mock.patch.object(api, "_triage_graph_client", lambda: FakeGraph()):
            resp = api.node_filters_preview(api.NodeFilterPreviewRequest(
                user_id="u1", project_id="p42", mode="denylist", rules=RUN["rules"]))
        self.assertEqual(resp.status_code, 200)

    def test_preview_refuses_a_weak_key(self):
        with mock.patch.object(api, "master_key_is_weak", lambda: True):
            resp = api.node_filters_preview(api.NodeFilterPreviewRequest(
                user_id="u1", project_id="p1", mode="denylist"))
        self.assertEqual(resp.status_code, 503)

    async def test_apply_starts_in_the_background_and_answers_202(self):
        with mock.patch("node_filter_runs.start_apply", return_value=True) as start:
            resp = await api.node_filters_apply(api.NodeFilterApplyRequest(run_id="clx0run1"))
        self.assertEqual(resp.status_code, 202)
        self.assertEqual(start.call_args.args[0], "clx0run1")

    async def test_apply_takes_only_a_run_id(self):
        # A body carrying rules is not an error, but they are never read.
        req = api.NodeFilterApplyRequest(run_id="clx0run1", rules={"evil": True}, project_id="other")
        self.assertFalse(hasattr(req, "rules"))
        self.assertFalse(hasattr(req, "project_id"))

    async def test_apply_refuses_a_malformed_id_and_a_duplicate(self):
        resp = await api.node_filters_apply(api.NodeFilterApplyRequest(run_id="../../etc"))
        self.assertEqual(resp.status_code, 400)
        with mock.patch("node_filter_runs.start_apply", return_value=False):
            resp = await api.node_filters_apply(api.NodeFilterApplyRequest(run_id="clx0run1"))
        self.assertEqual(resp.status_code, 409)

    async def test_apply_refuses_a_weak_key(self):
        with mock.patch.object(api, "master_key_is_weak", lambda: True):
            resp = await api.node_filters_apply(api.NodeFilterApplyRequest(run_id="clx0run1"))
        self.assertEqual(resp.status_code, 503)


if __name__ == "__main__":
    unittest.main()
