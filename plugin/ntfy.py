"""ntfy: the same news as a push, published to a topic the user's phone subscribes to.

A phone built without Firebase, or one whose user would rather not go through it, gets its
notifications from the ntfy app instead: the Gots app hands this profile a server, a topic and an
access token (``POST push/ntfy``), and ``deliver`` publishes there whenever ``push.notify`` has news.
The plugin publishes itself — ntfy needs no key that can't live on a host, so nothing goes through
the registry — and what it says is what a push says: the title of what it is about and one sentence
of what happened, never what was asked.

**This is not Hermes's ntfy delivery platform.** That one carries a routine's own answer to a channel
the user set up in Hermes; this carries the app's "a session needs you" to the user's phone. The two
share a protocol and nothing else, and neither reads the other's configuration.

The target is the profile's own setting, one per store and written a field at a time, so it follows
the bot to every phone: a phone that joins reads where to publish from the host, never from itself,
and the categories it wants are one list for every phone on the topic. The devices that chose
ntfy are kept beside it, for two things — the registry is told to skip them, so a Firebase token
still on file can't deliver the same news twice, and a publish is held back while every one of them
has the app on screen.

ntfy's Android app has a channel per *priority*, not per category, so a category's switch has nothing
on the phone to stand on: the list the app sent is enforced here, before anything is published, and
its importance rides as the message's priority (4 peeks, 3 sounds, 2 is silent).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from .store import connect

logger = logging.getLogger(__name__)

KEY = "ntfy"
SEND_TIMEOUT = 10
MAX_DEVICES = 20
# ntfy's own rule for a topic and for a sequence id (`topicRegex` in its server).
TOPIC = re.compile(r"^[-_A-Za-z0-9]{1,64}$")
# A token rides in a header: printable ASCII with no spaces, as ntfy's `tk_…` tokens are.
TOKEN = re.compile(r"^[\x21-\x7e]{1,512}$")
DEVICE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
DEFAULT_PRIORITY = 3

# What happened, under the title of what it happened in. `app/netlify/lib/fcm.ts` and
# `app/public/push-sw.js` say the same; `tests/test_ntfy.py` fails when these drift from them.
WORDS = {
    "approval": "Waiting for your approval",
    "question": "You have a question waiting",
    "plan": "The plan is ready for your review",
    "run_done": "You have a new reply",
    "run_failed": "The run stopped with an error",
    "pr_checks": "Checks are failing on the pull request",
    "pr_merged": "Your pull request was merged",
    "clone_failed": "This project couldn't be set up",
    "routine_failed": "The last run failed",
    "research_brief": "The brief is ready for your review",
    "research_scope": "The scope is ready for your approval",
    "research_done": "Your research is ready",
    "research_failed": "The mission stopped with an error",
    "afk_pr": "A task's pull request is ready to review",
    "routine_message": "A bot has a message",
    "meeting_done": "Your meeting notes are ready",
    "meeting_failed": "Meeting notes failed",
    "room_input": "A room is waiting on you",
}

# When nothing names what the news is about.
UNTITLED = {
    "routine_failed": "A routine",
    "routine_message": "A bot",
    "clone_failed": "A project",
    "research_brief": "A research mission",
    "research_scope": "A research mission",
    "research_done": "A research mission",
    "research_failed": "A research mission",
    "meeting_done": "A meeting",
    "meeting_failed": "A meeting",
    "room_input": "A room",
}


def _error(message: str) -> Exception:
    from .push import PushError

    return PushError(message)


def clean_server(value: Any) -> str:
    """The server's address as it is published to: an http or https origin, with any path it sits
    under, and nothing else. Which servers are reachable is the host's own network's business, so a
    LAN server, a loopback one and a plain-http one are all taken; the caller holds the bot's key."""
    if not isinstance(value, str):
        raise _error("Not an ntfy server address.")
    parts = urllib.parse.urlsplit(value.strip())
    try:
        parts.port
    except ValueError:
        raise _error("Not an ntfy server address.") from None
    if (
        parts.scheme not in ("http", "https")
        or not parts.hostname
        or parts.username
        or parts.password
        or parts.query
        or parts.fragment
    ):
        raise _error("Not an ntfy server address.")
    return f"{parts.scheme}://{parts.netloc}{parts.path.rstrip('/')}"


def stored(path: Path) -> Dict[str, Any]:
    """What this profile holds about ntfy, whole or not: a target is written a field at a time."""
    if not path.exists():
        return {}
    conn = connect(path)
    try:
        row = conn.execute("SELECT value FROM push_prefs WHERE key = ?", (KEY,)).fetchone()
    finally:
        conn.close()
    try:
        value = json.loads(row[0]) if row else None
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def complete(held: Dict[str, Any]) -> bool:
    return all(isinstance(held.get(k), str) and held[k] for k in ("server", "topic", "token"))


def target(path: Path) -> Optional[Dict[str, Any]]:
    """Where this profile publishes, or None while any of the server, the topic or the token is
    missing: a target with no token can't publish, which is what makes the token required."""
    held = stored(path)
    return held if complete(held) else None


def _write(path: Path, value: Optional[Dict[str, Any]]) -> None:
    conn = connect(path)
    try:
        if value is None:
            conn.execute("DELETE FROM push_prefs WHERE key = ?", (KEY,))
        else:
            conn.execute(
                "INSERT OR REPLACE INTO push_prefs (key, value) VALUES (?, ?)",
                (KEY, json.dumps(value, separators=(",", ":"))),
            )
    finally:
        conn.close()


def _priorities(value: Any) -> Dict[str, int]:
    from .push import CATEGORIES

    if not isinstance(value, dict):
        return {}
    return {
        category: level
        for category in CATEGORIES
        if isinstance(level := value.get(category), int) and not isinstance(level, bool) and 1 <= level <= 5
    }


def set_target(path: Path, body: Dict[str, Any]) -> Dict[str, Any]:
    """Writes what the body names of this profile's target, and that a device chose it. Raises
    ``PushError`` with a message for the app.

    The target is the profile's setting, edited one field at a time, so each of the server, the topic
    and the token is written only when named. The token is never read back, and it belongs to the
    server it was made on: a write that moves the target to another server drops it, so a token is
    never sent to a server it wasn't typed for.
    """
    from .push import clean_categories

    held = stored(path)
    value = dict(held)
    if "server" in body:
        server = clean_server(body.get("server"))
        if held.get("server") and server != held["server"]:
            value.pop("token", None)
        value["server"] = server
    if "topic" in body:
        topic = body.get("topic")
        if not isinstance(topic, str) or not TOPIC.match(topic):
            raise _error("Not an ntfy topic.")
        value["topic"] = topic
    if body.get("token") is not None:
        token = body["token"]
        if not isinstance(token, str) or not TOKEN.match(token):
            raise _error("Not an ntfy access token.")
        value["token"] = token
    device = body.get("device")
    if device is not None:
        if not isinstance(device, str) or not DEVICE.match(device):
            raise _error("Not a device.")
        if not complete(value):
            raise _error("Set this bot's ntfy server, topic and access token first.")
        devices = [d for d in held.get("devices") or [] if d != device] + [device]
        value["devices"] = devices[-MAX_DEVICES:]
    categories = clean_categories(body.get("categories"))
    if categories is not None:
        value["categories"] = categories
    priorities = _priorities(body.get("priorities"))
    if priorities:
        value["priorities"] = priorities
    _write(path, value)
    return value


def remove(path: Path, device: Optional[str]) -> Dict[str, Any]:
    """A device stops using ntfy, and the target stays the bot's; with no device named, the whole
    target goes, for every phone."""
    if not device:
        _write(path, None)
        return {}
    held = stored(path)
    if held:
        held["devices"] = [d for d in held.get("devices") or [] if d != device]
        _write(path, held)
    return held


def public(held: Optional[Dict[str, Any]], device: Optional[str] = None) -> Dict[str, Any]:
    """The target as the app may read it: everything but the token, which is only ever a boolean.
    ``configured`` is whether it can publish, ``joined`` whether the device asking chose ntfy here."""
    held = held or {}
    devices = [d for d in held.get("devices") or [] if isinstance(d, str)]
    return {
        "object": "gots.push_ntfy",
        "configured": complete(held),
        "server": held.get("server"),
        "topic": held.get("topic"),
        "token_set": bool(held.get("token")),
        "categories": held.get("categories"),
        "devices": len(devices),
        "joined": bool(device and device in devices),
    }


def devices(path: Path) -> List[str]:
    """The devices that get this profile's news over ntfy, so no other transport tells them too."""
    return [d for d in stored(path).get("devices") or [] if isinstance(d, str)]


def wants(held: Dict[str, Any], category: str) -> bool:
    from .push import LEGACY_CATEGORIES

    categories = held.get("categories")
    return category in (categories if isinstance(categories, list) else LEGACY_CATEGORIES)


def click(kind: str, session_id: str) -> str:
    """What a tap opens: the Gots app, told the kind and the id, which it turns into a screen itself
    (``pushPath``), so no route is spelled twice."""
    return "gots://open?" + urllib.parse.urlencode({"kind": kind, "id": session_id})


def message(
    held: Dict[str, Any], kind: str, category: str, session_id: str, extra: Optional[Dict[str, str]] = None
) -> Dict[str, Any]:
    """The JSON a publish posts to the server's root."""
    title = ((extra or {}).get("title") or "").strip() or UNTITLED.get(kind) or "Gots"
    priorities = held.get("priorities") if isinstance(held.get("priorities"), dict) else {}
    sequence = hashlib.sha256(f"{category}:{session_id}".encode()).digest()[:18]
    return {
        "topic": held["topic"],
        "title": title,
        "message": WORDS.get(kind, "Waiting for you"),
        "priority": priorities.get(category, DEFAULT_PRIORITY),
        "click": click(kind, session_id),
        # A newer message of the same category about the same thing replaces one still showing.
        "sequence_id": base64.urlsafe_b64encode(sequence).rstrip(b"=").decode(),
    }


def publish(held: Dict[str, Any], body: Dict[str, Any]) -> Optional[int]:
    """One message to the topic. The server's status, or None if it didn't answer."""
    request = urllib.request.Request(
        held["server"] + "/",
        data=json.dumps(body, separators=(",", ":")).encode(),
        headers={"Authorization": f"Bearer {held['token']}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=SEND_TIMEOUT) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, OSError):
        return None


def deliver(
    path: Path,
    kind: str,
    category: str,
    session_id: str,
    extra: Optional[Dict[str, str]] = None,
    on_screen: Optional[List[str]] = None,
) -> Optional[int]:
    """Publishes the news if this profile has a target that asked for its category. A topic reaches
    every phone subscribed to it, so it is held back only while every device that chose ntfy has the
    app open. Answers the server's status, or None when nothing was sent."""
    held = target(path)
    if not held or not wants(held, category):
        return None
    chosen = [d for d in held.get("devices") or [] if isinstance(d, str)]
    if chosen and all(device in (on_screen or []) for device in chosen):
        return None
    status = publish(held, message(held, kind, category, session_id, extra))
    if status is None or status >= 300:
        # 401 and 403 are the token; the app's own switch is where it is put right.
        logger.warning("gots: ntfy at %s answered %s", urllib.parse.urlsplit(held["server"]).netloc, status)
    return status
