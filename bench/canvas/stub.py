"""The host's contract as a stand-in: what ``--self-check`` drives the bench's client against.

A bench that has never been run against a host is a bench nobody has checked. This stub answers the
routes the bench calls with the shapes the plugin answers them in — a start's 202, a record whose
version advances once per run posted and then holds still, a catalogue and a page of documents, a run
id, a delete — so the client's addresses, its bodies and its wait are read against the contract
rather than against hope. It stands in for a host and is nothing like one: no model answers, no
browser draws, and the page it writes is a line of markup. A real run is the only thing that grades
a page.

Run: python3 -m bench.canvas --self-check
"""

from __future__ import annotations

import json
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

# The page the stub writes: enough of a document for the store's own warnings to read and for the
# runner's request to carry. A real host's page is the thing being graded; this is a placeholder.
PAGE = (
    "<!DOCTYPE html><html><head><title>Stub</title></head>"
    "<body><h1>Stub page</h1><p>written by the stub</p></body></html>"
)

DOCUMENTS = [
    {
        "collection": "standups",
        "id": "a",
        "doc": {"who": "Ada", "said": "shipped the thing", "column": "yesterday"},
        "at": 1,
    }
]


def user_message(raw: Any) -> str:
    """The text a ``POST /v1/runs`` body carries, read the way the host reads it.

    Hermes takes ``input`` as a string, or as a list whose last message holds ``content``
    (``_run_user_message`` in ``gateway/platforms/api_server_runs``). Anything else is a run with no
    user message, which the host refuses with a 400 rather than starting — so the stub refuses it
    too, and a client that sends the wrong shape fails here instead of against a live host.
    """
    if not raw:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list) and isinstance(raw[-1], dict):
        return str(raw[-1].get("content") or "")
    return ""


class Stub:
    """One stub host: its canvases, the runs posted at them, and the writes each run left."""

    def __init__(self) -> None:
        self.canvases: Dict[str, Dict[str, Any]] = {}
        self.sessions: Dict[str, str] = {}
        self.deleted: List[str] = []
        self.runs: List[str] = []
        self.lock = threading.Lock()

    def start(self) -> Dict[str, Any]:
        canvas_id = f"stub-{len(self.canvases) + 1}"
        session_id = f"gots-{canvas_id}"
        canvas = {
            "id": canvas_id,
            "title": "Stub canvas",
            "session_id": session_id,
            "chat_id": f"chat-{canvas_id}",
            "version": 0,
            "at": int(time.time() * 1000),
            "html": "",
            "pending": 1,
        }
        self.canvases[canvas_id] = canvas
        self.sessions[session_id] = canvas_id
        return canvas

    def post_run(self, session_id: str) -> str:
        run_id = f"run-{len(self.runs) + 1}"
        self.runs.append(run_id)
        canvas = self.canvases.get(self.sessions.get(session_id, ""))
        if canvas is not None:
            canvas["pending"] = canvas.get("pending", 0) + 1
        return run_id

    def read(self, canvas_id: str) -> Optional[Dict[str, Any]]:
        """The record as it stands: a run posted and not yet answered writes its version once.

        The write lands on the read after the post — the shape a host's worker has, where the run
        ends by the record going still — so the bench's wait settles on the second quiet read.
        """
        canvas = self.canvases.get(canvas_id)
        if canvas is None:
            return None
        if canvas.get("pending", 0) > 0:
            canvas["pending"] -= 1
            canvas["version"] += 1
            canvas["at"] = int(time.time() * 1000)
            canvas["html"] = PAGE
        return canvas

    def delete(self, canvas_id: str) -> bool:
        if canvas_id not in self.canvases:
            return False
        session_id = self.canvases.pop(canvas_id)["session_id"]
        self.sessions.pop(session_id, None)
        self.deleted.append(canvas_id)
        return True


def serve(stub: Stub) -> Tuple[ThreadingHTTPServer, threading.Thread]:
    """The stub on a loopback port of its own, in a thread, ready to be shut down."""
    outer = stub

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:  # a stub is silent
            return

        def _answer(self, status: int, body: Dict[str, Any]) -> None:
            said = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(said)))
            self.end_headers()
            self.wfile.write(said)

        def _canvas_id(self) -> Optional[str]:
            parts = urllib.parse.urlparse(self.path).path.split("/")
            if len(parts) >= 6 and parts[5]:
                return urllib.parse.unquote(parts[5])
            return None

        def do_GET(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            if path == "/api/plugins/gots/info":
                return self._answer(
                    200,
                    {
                        "object": "gots.info",
                        "version": "0.0.0-stub",
                        "features": ["canvas", "canvas_checks"],
                    },
                )
            canvas_id = self._canvas_id()
            if canvas_id is None:
                return self._answer(404, {"error": {"message": "no canvas named"}})
            if path.endswith("/data"):
                return self._answer(
                    200,
                    {
                        "collections": [
                            {"collection": "standups", "count": len(DOCUMENTS), "newest_at": 1}
                        ],
                        "bytes": 120,
                    },
                )
            if "/data/" in path:
                return self._answer(
                    200, {"documents": DOCUMENTS, "next": None, "count": len(DOCUMENTS)}
                )
            with outer.lock:
                canvas = outer.read(canvas_id)
            if canvas is None:
                return self._answer(404, {"error": {"message": "There is no such canvas."}})
            return self._answer(200, {"object": "gots.canvas", "canvas": canvas})

        def do_POST(self) -> None:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
            path = urllib.parse.urlparse(self.path).path
            if path == "/v1/runs":
                if not user_message(body.get("input")):
                    return self._answer(
                        400, {"error": {"message": "No user message found in input"}}
                    )
                with outer.lock:
                    run_id = outer.post_run(body.get("session_id") or "")
                return self._answer(200, {"object": "gots.run", "run_id": run_id})
            if path == "/api/plugins/gots/canvases":
                # The plugin queues the app's own run body as the canvas's first turn, so a start
                # whose body the host would refuse is refused here too: that body is the one the
                # bench got wrong and no other check sees, since /v1/runs is never posted for it.
                asked = body.get("body")
                if not isinstance(asked, dict) or not user_message(asked.get("input")):
                    return self._answer(
                        400, {"error": {"message": "No user message found in input"}}
                    )
                with outer.lock:
                    canvas = outer.start()
                return self._answer(202, {"object": "gots.canvas", "canvas": canvas})
            return self._answer(404, {"error": {"message": f"no route for {path}"}})

        def do_DELETE(self) -> None:
            canvas_id = self._canvas_id()
            if canvas_id is None:
                return self._answer(404, {"error": {"message": "no canvas named"}})
            with outer.lock:
                gone = outer.delete(canvas_id)
            if not gone:
                return self._answer(404, {"error": {"message": "There is no such canvas."}})
            return self._answer(200, {"object": "gots.canvas", "deleted": True})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread
