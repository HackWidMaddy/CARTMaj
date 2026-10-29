"""Node filters on the agent: the preview, and "apply to current graph" runs.

Both call the one sweep, `apply_node_filters` (graph_db/mixins/node_filter_mixin.py),
so a preview's counts are what an apply writes.

**Preview** is a dry run over the draft rules the webapp sends. It runs in the
request's worker thread (the endpoint is a plain `def`), one per project and two
in total, and stops at a 20 s deadline with the result marked partial, so a huge
graph cannot tie up the agent.

**Apply** is a tracked graph writer. The webapp creates a `NodeFilterRun` row
and passes only its id; this module fetches the run over the master-key internal
route and applies exactly the rules snapshotted into it, never anything from the
request. It heartbeats as it goes, stops when the webapp says so (Stop, a
project delete, a version activation) or when it can no longer reach the
webapp, and always reports how it ended from a `finally`.
"""

from __future__ import annotations

import logging
import os
import threading
import time

import httpx

logger = logging.getLogger(__name__)

WEBAPP_API_URL = os.environ.get("WEBAPP_API_URL", "http://webapp:3000")

#: How often an apply checks in. The webapp treats a run silent for five
#: minutes as lost.
HEARTBEAT_SECONDS = 30

#: Consecutive heartbeat failures before an apply stops itself: a webapp it
#: cannot reach is also one that cannot tell it to stop.
HEARTBEAT_FAILURE_LIMIT = 2

PREVIEW_DEADLINE_SECONDS = 20

_preview_slots = threading.BoundedSemaphore(2)
_preview_projects: set = set()
_preview_lock = threading.Lock()

_active_runs: set = set()
_runs_lock = threading.Lock()


def _headers() -> dict:
    return {"X-Internal-Key": os.environ.get("INTERNAL_API_KEY", "")}


class PreviewBusy(Exception):
    """A preview for this project, or two in total, is already running."""


class NodeFilterRunAborted(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def preview(client, user_id: str, project_id: str, mode: str, rules, exemptions=(),
            kinds=None, deadline_seconds: float = PREVIEW_DEADLINE_SECONDS) -> dict:
    """A dry run of draft rules. Raises PreviewBusy rather than queueing."""
    with _preview_lock:
        if project_id in _preview_projects:
            raise PreviewBusy("a preview is already running for this project")
        if not _preview_slots.acquire(blocking=False):
            raise PreviewBusy("two previews are already running")
        _preview_projects.add(project_id)
    try:
        return client.apply_node_filters(
            user_id, project_id, {"mode": mode, "rules": rules},
            exemptions=[tuple(e) for e in exemptions or ()], kinds=kinds, dry_run=True,
            deadline=time.monotonic() + deadline_seconds, log=lambda *_: None,
        )
    finally:
        with _preview_lock:
            _preview_projects.discard(project_id)
            _preview_slots.release()


def compact_stats(stats: dict) -> dict:
    """Counts only, for NodeFilterRun.stats. Never finding text or samples."""
    return {
        "ok": bool(stats.get("ok")),
        "mode": stats.get("mode"),
        "partial": bool(stats.get("partial")),
        "totals": stats.get("totals", {}),
        "kinds": {
            kind: {
                **{k: v for k, v in ks.items() if k not in ("rules", "missing")},
                "rules": {rid: r.get("matched", 0) for rid, r in (ks.get("rules") or {}).items()},
            }
            for kind, ks in (stats.get("kinds") or {}).items()
        },
        "errors": list(stats.get("errors") or [])[:20],
    }


class NodeFilterRunClient:
    """The agent's half of one run: fetch, heartbeat, finish."""

    def __init__(self, run_id: str, http=None, clock=time.monotonic):
        self.run_id = run_id
        self._owns_http = http is None
        self._http = http or httpx.Client(timeout=15.0)
        self._clock = clock
        self._last_beat = clock()
        self._failures = 0
        self._scanned: dict = {}

    def _url(self, suffix: str = "") -> str:
        return f"{WEBAPP_API_URL}/api/internal/node-filter-runs/{self.run_id}{suffix}"

    def fetch(self) -> dict:
        res = self._http.get(self._url(), headers=_headers())
        if res.status_code != 200:
            raise NodeFilterRunAborted(f"the run could not be read (HTTP {res.status_code})")
        return res.json()

    def heartbeat(self, progress: dict | None = None) -> None:
        """Called per page; checks in at most every HEARTBEAT_SECONDS. Raises to stop."""
        if progress:
            self._scanned[progress.get("kind")] = int(progress.get("scanned") or 0)
        if self._clock() - self._last_beat < HEARTBEAT_SECONDS:
            return
        self._last_beat = self._clock()
        try:
            res = self._http.post(self._url("/heartbeat"), headers=_headers(),
                                  json={"progress": {"scanned": sum(self._scanned.values())}})
            body = res.json() if res.content else {}
            if res.status_code == 200 and not body.get("abort"):
                self._failures = 0
                return
            if body.get("abort"):
                raise NodeFilterRunAborted(body.get("reason") or "the webapp asked the run to stop")
            self._failures += 1
        except NodeFilterRunAborted:
            raise
        except Exception as e:  # noqa: BLE001 - counted, then fail closed
            logger.warning("node-filter run %s heartbeat failed: %s", self.run_id, e)
            self._failures += 1
        if self._failures >= HEARTBEAT_FAILURE_LIMIT:
            raise NodeFilterRunAborted("the webapp stopped answering heartbeats")

    def finish(self, status: str, stats: dict | None = None, error: str | None = None) -> None:
        try:
            self._http.post(self._url("/finish"), headers=_headers(),
                            json={"status": status, "stats": stats, "error": error})
        except Exception as e:  # noqa: BLE001 - the heartbeat TTL releases the project
            logger.error("node-filter run %s could not report its end: %s", self.run_id, e)

    def close(self) -> None:
        """Release the connection pool this client opened (never one it was handed)."""
        if self._owns_http:
            self._http.close()


def run_apply(run_id: str, graph_client_factory, run_client=None, log_event=None) -> str:
    """The background body of one apply. Returns the status it finished with."""
    rc = run_client or NodeFilterRunClient(run_id)
    status, stats, error = "failed", None, None
    report = True
    try:
        run = rc.fetch()
        if run.get("status") != "running":
            # Stopped or swept before this thread started: someone else ended it.
            report = False
            status = run.get("status") or "gone"
            return status
        result = graph_client_factory().apply_node_filters(
            run["userId"], run["projectId"], {"mode": run["mode"], "rules": run["rules"]},
            exemptions=[tuple(e) for e in run.get("exemptions") or []],
            heartbeat=rc.heartbeat,
        )
        stats = compact_stats(result)
        status = "completed" if result.get("ok") else "failed"
        error = None if result.get("ok") else result.get("error")
        if log_event is not None:
            log_event("node_filters_applied", run_id=run_id, project_id=run["projectId"],
                      user_id=run["userId"], revision=run.get("revision"),
                      totals=stats.get("totals"))
    except NodeFilterRunAborted as e:
        status, error = "stopped", e.reason
    except Exception as e:  # noqa: BLE001 - reported to the run row, never raised
        logger.exception("node-filter run %s failed", run_id)
        status, error = "failed", str(e)[:500]
    finally:
        if report:
            rc.finish(status, stats, error)
        if run_client is None:
            rc.close()
        with _runs_lock:
            _active_runs.discard(run_id)
    return status


def start_apply(run_id: str, graph_client_factory, log_event=None) -> bool:
    """Start one run in a daemon thread. False when that run is already going."""
    with _runs_lock:
        if run_id in _active_runs:
            return False
        _active_runs.add(run_id)
    thread = threading.Thread(
        target=lambda: run_apply(run_id, graph_client_factory, log_event=log_event),
        name=f"node-filter-apply-{run_id}", daemon=True,
    )
    thread.start()
    return True
