"""The host client: the prompts on a real host, over the routes the app itself calls.

A canvas request is sent the way the app sends one — the plugin's own ``POST /canvases`` queues the
prompt on the canvas's session, and a follow-up is posted to that session on Hermes's ``/v1/runs`` —
and a run's end is read the way the bench can read it: the canvas's record stops moving. The client
is a client and nothing more: no plugin code runs on the host's behalf, no store is touched, and
every answer is the host's own, refusals included.

The addresses are the app's own rule (``app/src/lib/host-url.ts``): the server root is the base URL
without its trailing ``/v1``, and the plugin's routes sit under it — with the profile inside the
plugin's own prefix where the bot is one a multiplexing gateway serves at ``/p/<profile>``.

Run: python3 -m bench.canvas --self-check drives this client against a stub of the host's contract.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

PLUGIN_ROOT = "/api/plugins/gots"


class HostError(Exception):
    """A host that refused, or couldn't answer: the host's own words where it gave any."""


def server_root(base_url: str) -> str:
    """The server root of a base URL: no query, no trailing slash, no trailing ``/v1``."""
    root = base_url.strip().split("?", 1)[0].split("#", 1)[0]
    root = root.rstrip("/")
    return root[:-3] if root.endswith("/v1") else root


def multiplexed_profile(base_url: str) -> Optional[str]:
    """The profile a multiplexing gateway serves this bot at, named by the base URL's own tail."""
    root = server_root(base_url)
    marker = "/p/"
    if marker not in root:
        return None
    tail = root.rsplit(marker, 1)[1]
    return tail or None


def plugin_root(base_url: str) -> str:
    """Where the Gots plugin serves this bot's routes, as the app builds it."""
    root = server_root(base_url)
    profile = multiplexed_profile(base_url)
    if not profile:
        return f"{root}{PLUGIN_ROOT}"
    return f"{root[: -len(f'/p/{profile}')]}{PLUGIN_ROOT}/p/{profile}"


@dataclass
class Settings:
    """What a run is sent with: where the host is, what it is asked with, and how long to wait."""

    base: str  # the bot's base URL, the shape the app holds
    key: str = ""
    provider: Optional[str] = None  # the pick the run body names; the host's own model where none
    model: Optional[str] = None
    profile: Optional[str] = None  # the bot's profile id, where a host serves more than one
    poll_ms: int = 5_000  # how often a waiting run reads the record
    quiet_ms: int = 30_000  # how still the record has to be before a run reads as ended
    max_wait_s: int = 900  # how long one prompt is given before it reads as unfinished
    timeout_s: int = 120  # one request's own deadline


class Host:
    """One host, as the bench reaches it: the plugin's routes for a canvas, Hermes's for a run."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.root = plugin_root(settings.base)
        self.server = server_root(settings.base)
        self._features: Optional[List[str]] = None

    def builds(self) -> bool:
        """Whether this host's requests are builds, which is the path the bench measures now.

        An app that knows `canvas_builds` queues its request on the canvas's chat and the plugin
        hands it to a build (ADR 0170); a host without it still takes a first build on the canvas's
        own session, which is the "before" path the baseline was taken on.
        """
        if self._features is None:
            self._features = list(self.info().get("features") or ())
        return "canvas_builds" in self._features

    def _ask(self, url: str, method: str = "GET", body: Optional[Dict[str, Any]] = None):
        headers = {"Content-Type": "application/json"}
        if self.settings.key:
            headers["Authorization"] = f"Bearer {self.settings.key}"
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.settings.timeout_s) as response:
                return json.loads(response.read().decode() or "{}")
        except urllib.error.HTTPError as error:
            said = error.read().decode(errors="replace")
            try:
                message = (json.loads(said).get("error") or {}).get("message")
            except ValueError:
                message = said.strip()
            raise HostError(f"{method} {url} answered {error.code}: {message or said[:200]}")
        except urllib.error.URLError as error:
            raise HostError(f"{method} {url} couldn't be reached: {error.reason}")

    def info(self) -> Dict[str, Any]:
        """The plugin's own ``info``: its version and what it advertises."""
        return self._ask(f"{self.root}/info")

    def start(self, prompt: str) -> Dict[str, Any]:
        """A canvas from a prompt: the record, its session, and the run queued on it.

        The body is the run request a first send would carry — the pick and the words — so the
        canvas is built by the host with the app closed, which is the whole of the path being
        measured.
        """
        body: Dict[str, Any] = {"input": [{"type": "text", "text": prompt}]}
        if self.settings.provider:
            body["provider"] = self.settings.provider
        if self.settings.model:
            body["model"] = self.settings.model
        answer = self._ask(
            f"{self.root}/canvases",
            "POST",
            {
                "prompt": prompt,
                **({"profile_id": self.settings.profile} if self.settings.profile else {}),
                "body": body,
                # Where the host holds builds, the canvas is made the way the app makes one: its
                # requests are builds, so the prompt opens the first of them (ADR 0170).
                **({"builds": True} if self.builds() else {}),
            },
        )
        canvas = answer.get("canvas")
        if not isinstance(canvas, dict) or not canvas.get("id"):
            raise HostError("the host answered a start with no canvas")
        return canvas

    def read(self, canvas_id: str) -> Dict[str, Any]:
        """One canvas: the record and the document its version points at."""
        answer = self._ask(f"{self.root}/canvases/{canvas_id}?docs=none")
        canvas = answer.get("canvas")
        if not isinstance(canvas, dict):
            raise HostError("the host answered a read with no canvas")
        return canvas

    def sweep(self, canvas_id: str, pages: int = 50) -> Dict[str, List[Dict[str, Any]]]:
        """The canvas's documents, collection by collection, a page at a time.

        The read-only snapshot a check is answered from. The page count bounds a canvas whose data
        outgrew what a bench wants to carry: the record says which collections were cut.
        """
        catalogue = self._ask(f"{self.root}/canvases/{canvas_id}/data")
        held: Dict[str, List[Dict[str, Any]]] = {}
        for row in catalogue.get("collections") or ():
            name = row.get("collection")
            if not name:
                continue
            rows: List[Dict[str, Any]] = []
            after: Optional[str] = None
            for _ in range(pages):
                page = self._ask(
                    f"{self.root}/canvases/{canvas_id}/data/{name}"
                    + (f"?after={after}" if after else "")
                )
                rows.extend(page.get("documents") or ())
                after = page.get("next")
                if not after:
                    break
            held[name] = rows
        return held

    def turn(self, session_id: str, prompt: str) -> str:
        """A follow-up on the canvas's chat: one request queued there, as the app sends one.

        Where the host holds builds the queue hands it to the canvas's open build, or opens one, so
        the prompt is measured on the path a reader's request takes. A host without builds takes the
        request as a run of the canvas's own session, which is the "before" path.
        """
        body: Dict[str, Any] = {
            "session_id": session_id,
            # The host reads `input` as a string, or as a list whose last message carries `content`
            # (`_run_user_message` in Hermes's `api_server_runs`). A `{"type": "text"}` part has no
            # `content`, so the host answers 400 "No user message found in input" and no run ever
            # starts: send the turn the way the app sends one.
            "input": [{"role": "user", "content": prompt}],
        }
        if self.settings.provider:
            body["provider"] = self.settings.provider
        if self.settings.model:
            body["model"] = self.settings.model
        if self.builds():
            answer = self._ask(f"{self.root}/sessions/{session_id}/queue", "POST", body)
            item = answer.get("item")
            if not isinstance(item, dict) or not item.get("id"):
                raise HostError("the host answered a queued request with no item")
            return str(item["id"])
        answer = self._ask(f"{self.server}/v1/runs", "POST", body)
        run_id = answer.get("run_id")
        if not (isinstance(run_id, str) and run_id):
            raise HostError("the host answered a run with no run id")
        return run_id

    def delete(self, canvas_id: str) -> None:
        """The canvas this run made, taken back: a bench leaves nothing on the host it graded."""
        self._ask(f"{self.root}/canvases/{canvas_id}", "DELETE")

    def wait(self, canvas_id: str, since: Optional[int] = None) -> Tuple[Dict[str, Any], bool]:
        """The record once its run has ended, and whether it ended inside the wait's own bound.

        A run's end is read the way a bench can read it: the record's version and its clock stop
        moving for the quiet window. Where the host holds builds, the build's own record says when
        it is open, and a build that opened after ``since`` has to have published a version past it
        before stillness counts — a record that has not moved yet is a build that has not started.
        A page still being written when the bound runs out is answered as unfinished rather than
        graded as it stood, and the record says so.
        """
        started = time.monotonic()
        last: Tuple[Any, Any] = (None, None)
        still_since: Optional[float] = None
        canvas = self.read(canvas_id)
        while True:
            moved = since is None or (canvas.get("version") or 0) > since
            now = (canvas.get("version"), canvas.get("at"))
            if self.builds() and canvas.get("build"):
                # A build working is a record that has not ended, however still its version is.
                last, still_since = now, None
            elif now != last:
                last, still_since = now, time.monotonic()
            elif (
                still_since is not None
                and moved
                and (time.monotonic() - still_since) * 1000 >= (self.settings.quiet_ms)
            ):
                return canvas, True
            if time.monotonic() - started >= self.settings.max_wait_s:
                return canvas, False
            time.sleep(self.settings.poll_ms / 1000)
            canvas = self.read(canvas_id)
