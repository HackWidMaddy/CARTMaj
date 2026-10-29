"""
Flush-on-connect: when a client (re)connects to a session whose agent is still
running, the backend must flush the live StreamingCallback's persist queue to the
DB BEFORE confirming the connection. Otherwise the client's restore read races
ahead of the async persist queue and shows a stale/empty timeline that only fills
in over the next few seconds ("empty chat on reopening a running session").

Run in-container: python -m unittest tests.test_persist_flush_on_connect
"""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

_AGENTIC_DIR = str(Path(__file__).resolve().parents[1])
if _AGENTIC_DIR not in sys.path:
    sys.path.insert(0, _AGENTIC_DIR)

try:
    import websocket_api
    from websocket_api import WebSocketManager, WebSocketConnection, StreamingCallback
    _HAVE = True
except Exception:
    _HAVE = False


class _FakeWS:
    def __init__(self):
        self.sent = []
        self.closed = False
        self.client = "test"

    async def send_json(self, msg):
        self.sent.append(msg)

    async def close(self, code=1000, reason=""):
        self.closed = True


def _conn(session_id="s"):
    c = WebSocketConnection(_FakeWS())
    c.user_id, c.project_id, c.session_id = "u", "p", session_id
    c.authenticated = True
    return c


@unittest.skipUnless(_HAVE, "agent deps unavailable (run in-container)")
class FlushOnConnect(unittest.TestCase):
    def test_flush_drains_queue_without_stopping_worker(self):
        """flush_persist_queue writes everything queued and leaves the worker
        alive so the run keeps persisting (unlike drain_persist_queue)."""
        async def scenario():
            saved = []

            async def fake_save(**kw):
                await asyncio.sleep(0.005)
                saved.append(kw["msg_type"])

            with patch.object(websocket_api, "save_chat_message", side_effect=fake_save):
                cb = StreamingCallback(_conn(), WebSocketManager())
                for i in range(5):
                    cb._persist("thinking", {"thought": f"t{i}"})
                self.assertGreater(cb._persist_queue.qsize(), 0)

                ok = await cb.flush_persist_queue(timeout=3.0)

                self.assertTrue(ok)
                self.assertEqual(cb._persist_queue.qsize(), 0)
                self.assertEqual(len(saved), 5)
                self.assertIsNotNone(cb._persist_worker_task)
                self.assertFalse(cb._persist_worker_task.done())

                # Worker still usable: enqueue + flush again.
                cb._persist("tool_start", {"tool_name": "x"})
                self.assertTrue(await cb.flush_persist_queue())
                self.assertEqual(len(saved), 6)

        asyncio.run(scenario())

    def test_flush_empty_queue_is_noop(self):
        async def scenario():
            cb = StreamingCallback(_conn(), WebSocketManager())
            self.assertTrue(await cb.flush_persist_queue())
        asyncio.run(scenario())

    def test_flush_times_out_without_cancelling_worker(self):
        """A stuck/slow writer must not block the handshake forever: flush returns
        False after the bound and the worker keeps trying."""
        async def scenario():
            async def slow_save(**kw):
                await asyncio.sleep(10)

            with patch.object(websocket_api, "save_chat_message", side_effect=slow_save):
                cb = StreamingCallback(_conn(), WebSocketManager())
                cb._persist("thinking", {"thought": "stuck"})
                ok = await cb.flush_persist_queue(timeout=0.1)
                self.assertFalse(ok)
                # Not fully drained, but worker is still running (not cancelled).
                self.assertFalse(cb._persist_worker_task.done())
        asyncio.run(scenario())

    def test_manager_callback_registry_survives_reconnect(self):
        """A NEW connection object for the same session_key resolves to the live
        callback registered by the running task — the path handle_init uses."""
        async def scenario():
            mgr = WebSocketManager()
            first = _conn()
            await mgr.authenticate(first, "u", "p", "s", verified=True)
            cb = StreamingCallback(first, mgr)
            mgr.register_callback(first.get_key(), cb)

            # Reconnect: a different connection object, same identity/session.
            second = _conn()
            await mgr.authenticate(second, "u", "p", "s", verified=True)

            self.assertIs(mgr.get_callback(second.get_key()), cb)

            mgr.clear_callback(second.get_key())
            self.assertIsNone(mgr.get_callback(second.get_key()))
        asyncio.run(scenario())

    def test_handle_init_flushes_live_callback_before_connected(self):
        """End-to-end wiring: the flush block in handle_init drains the registered
        callback's backlog so the DB is current when CONNECTED is emitted."""
        async def scenario():
            saved = []

            async def fake_save(**kw):
                await asyncio.sleep(0.005)
                saved.append(kw["msg_type"])

            with patch.object(websocket_api, "save_chat_message", side_effect=fake_save):
                mgr = WebSocketManager()
                conn = _conn()
                await mgr.authenticate(conn, "u", "p", "s", verified=True)
                cb = StreamingCallback(conn, mgr)
                for i in range(4):
                    cb._persist("thinking", {"thought": f"t{i}"})
                mgr.register_callback(conn.get_key(), cb)

                # Mirror exactly what handle_init does before sending CONNECTED.
                live_cb = mgr.get_callback(conn.get_key())
                self.assertIsNotNone(live_cb)
                await live_cb.flush_persist_queue()

                self.assertEqual(cb._persist_queue.qsize(), 0)
                self.assertEqual(len(saved), 4)
        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
