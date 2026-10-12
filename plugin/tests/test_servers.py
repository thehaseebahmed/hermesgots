"""Tests for the session server registry: ownership, ports, teardown.

Real spawns against a temp home, using ``python3 -m http.server`` as the probe server —
it listens on exactly the port it's given, which is the whole contract ``serve`` depends on.
"""

import socket
import sys
import tempfile
import time
import unittest
from pathlib import Path

from plugin import servers
from plugin.store import connect


PROBE_SCRIPT = """
import argparse
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser()
parser.add_argument("positional", nargs="?", type=int)
parser.add_argument("--port", dest="flag_port", type=int)
args = parser.parse_args()
port = args.positional or args.flag_port or int(os.environ["PROBE_PORT"])
ThreadingHTTPServer(("127.0.0.1", port), SimpleHTTPRequestHandler).serve_forever()
"""


def _home(tmp: str):
    home = Path(tmp)
    path = home / "memento" / "memento.db"
    connect(path).close()  # Creates the schema.
    probe = home / "probe_server.py"
    probe.write_text(PROBE_SCRIPT, encoding="utf-8")
    return path, home


PROBE = f'"{sys.executable}" probe_server.py {{port}}'


def _probe_row(path: Path, home: Path, session: str, name: str = "probe"):
    return servers._read(path, session, name)


class ServerLifecycleTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.path, self.home = _home(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _start(self, session="session-a", name="probe", command=PROBE, cwd=None, **kwargs):
        return servers.start(
            self.path, self.home, session, name, command, cwd or str(self.home), **kwargs
        )

    def _cleanup_servers(self):
        for row in servers._read_all(self.path):
            servers._stop_row(self.path, row)

    def assertListening(self, port):
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            pass

    def test_two_sessions_get_different_live_ports(self):
        # The reported incident: two sessions, one default port, one collision.
        first = self._start(session="session-a")
        second = self._start(session="session-b")
        self.addCleanup(self._cleanup_servers)
        self.assertNotEqual(first["port"], second["port"])
        self.assertListening(first["port"])
        self.assertListening(second["port"])
        status_a = servers.status(self.path, "session-a")
        self.assertIn(second["port"], status_a["ports_in_use"])

    def test_start_is_idempotent_per_name(self):
        first = self._start()
        self.addCleanup(self._cleanup_servers)
        second = self._start()
        self.assertEqual(first["status"], "started")
        self.assertEqual(second["status"], "running")
        self.assertEqual(first["port"], second["port"])
        self.assertEqual(first["pid"], second["pid"])

    def test_start_without_port_mechanism_is_refused(self):
        with self.assertRaises(servers.ServerError):
            self._start(command=f'"{sys.executable}" -m http.server --bind 127.0.0.1')

    def test_two_mechanisms_is_refused(self):
        with self.assertRaises(servers.ServerError):
            self._start(command=PROBE, port_env="PORT", port_flag="--port")

    def test_port_env_and_port_flag_mechanisms(self):
        base = f'"{sys.executable}" probe_server.py'
        env_row = self._start(name="via-env", command=base, port_env="PROBE_PORT")
        flag_row = self._start(name="via-flag", command=base, port_flag="--port")
        self.addCleanup(self._cleanup_servers)
        self.assertListening(env_row["port"])
        self.assertListening(flag_row["port"])

    def test_stop_frees_port_and_clears_row(self):
        started = self._start()
        port = started["port"]
        stopped = servers.stop(self.path, "session-a", "probe")
        self.assertTrue(stopped["stopped"])
        self.assertIsNone(_probe_row(self.path, self.home, "session-a"))
        time.sleep(0.2)
        with self.assertRaises(OSError):
            self.assertListening(port)

    def test_dead_row_is_replaced_on_start(self):
        first = self._start()
        row = servers._read(self.path, "session-a", "probe")
        assert row is not None  # noqa: S101 — a plain assert narrows for the type checker
        servers._stop_row(self.path, row)
        second = self._start()
        self.addCleanup(self._cleanup_servers)
        self.assertEqual(second["status"], "started")
        self.assertNotEqual(first["pid"], second["pid"])

    def test_sweep_kills_server_of_ended_session(self):
        self._start(session="session-a")
        # A session is open while its workspace record exists; none was created, so it has ended.
        stopped = servers.sweep(self.path, self.home)
        self.assertGreaterEqual(stopped, 1)
        self.assertIsNone(_probe_row(self.path, self.home, "session-a"))

    def test_recover_kills_survivor_after_restart(self):
        self._start(session="session-a")
        stopped = servers.recover(self.path, self.home)
        self.assertEqual(stopped, 1)
        rows = servers._read_all(self.path)
        self.assertEqual(rows, [])

    def test_alive_refuses_recycled_pid(self):
        row = {"session_id": "s", "name": "n", "pid": 1, "start_time": 999999}
        # PID 1 exists but was not started at tick 999999: not ours.
        self.assertFalse(servers._alive(row))
        # No start-time baseline (legacy row): degrade to a liveness check.
        self.assertTrue(servers._alive({"pid": 1, "start_time": None}))


if __name__ == "__main__":
    unittest.main()
