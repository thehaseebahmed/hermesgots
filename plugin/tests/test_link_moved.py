"""Check-ins follow the app to a new address.

Run: python3 -m unittest plugin.tests.test_link_moved -v
"""

from __future__ import annotations

import http.server
import json
import threading
import unittest
from typing import Any, Dict, List

from plugin import link


def serve(handler: type) -> http.server.HTTPServer:
    server = http.server.HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class MovedTest(unittest.TestCase):
    def setUp(self) -> None:
        seen: List[Dict[str, Any]] = []
        self.seen = seen

        class Registry(http.server.BaseHTTPRequestHandler):
            def answer(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                seen.append({
                    "method": self.command,
                    "path": self.path,
                    "auth": self.headers.get("Authorization"),
                    "body": json.loads(self.rfile.read(length) or b"null"),
                })
                body = json.dumps({"ok": True}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = do_PUT = answer

            def log_message(self, *args: Any) -> None:
                pass

        self.registry = serve(Registry)
        self.new = f"http://127.0.0.1:{self.registry.server_port}"
        target = self.new

        class Old(http.server.BaseHTTPRequestHandler):
            def answer(self) -> None:
                path = self.path if "elsewhere" not in self.path else "/somewhere-else"
                self.send_response(301)
                self.send_header("Location", target + path)
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_GET = do_POST = do_PUT = answer

            def log_message(self, *args: Any) -> None:
                pass

        self.old_server = serve(Old)
        self.old = f"http://127.0.0.1:{self.old_server.server_port}"

    def tearDown(self) -> None:
        for server in (self.registry, self.old_server):
            server.shutdown()
            server.server_close()

    def test_keeps_the_method_and_body_and_reports_the_new_site(self) -> None:
        moves: List[str] = []
        answer = link.call(
            self.old, "POST", "seen", token="mh_t", body={"bots": ["b"]}, moved=moves.append
        )
        self.assertEqual(answer, {"ok": True})
        self.assertEqual(
            self.seen,
            [{
                "method": "POST",
                "path": "/.netlify/functions/registry?route=seen",
                "auth": "Bearer mh_t",
                "body": {"bots": ["b"]},
            }],
        )
        self.assertEqual(moves, [self.new])

    def test_follows_a_put(self) -> None:
        link.call(self.old, "PUT", "bots", token="mh_t", bot_id="b", body={"keyId": "k"})
        self.assertEqual(self.seen[0]["method"], "PUT")

    def test_stays_put_when_the_site_did_not_move(self) -> None:
        moves: List[str] = []
        link.call(self.new, "GET", "inbox", token="mh_t", moved=moves.append)
        self.assertEqual(moves, [])

    def test_refuses_a_redirect_to_another_path(self) -> None:
        with self.assertRaises(link.LinkError) as caught:
            link.call(self.old, "GET", "elsewhere", token="mh_t")
        self.assertEqual(caught.exception.status, 301)
        self.assertEqual(self.seen, [])


if __name__ == "__main__":
    unittest.main()
