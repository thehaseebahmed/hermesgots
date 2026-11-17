"""ntfy: the same news as a push, published to a topic the user's phone subscribes to.

A phone built without Firebase, or one whose user would rather not go through it, gets its
notifications from the ntfy app instead, and ``deliver`` publishes there whenever ``push.notify`` has
news. The plugin publishes itself — ntfy needs no key that can't live on a host, so nothing goes
through the registry — and what it says is what a push says: the title of what it is about and one
sentence of what happened, never what was asked.

**The server and the token are Hermes's own.** Hermes's ntfy platform reads ``NTFY_SERVER_URL``
(``https://ntfy.sh`` where unset) and ``NTFY_TOKEN`` (a bearer token, or ``user:pass`` for Basic) from
the profile's environment, and this module reads the same two through Hermes's credential helper and
writes them with Hermes's own ``.env`` writer, so a profile has one ntfy server and one token whichever
side set them. **The topic is Gots's alone**, kept in the plugin's store: Hermes's platform subscribes
to ``NTFY_TOPIC`` and reads what lands there as messages to the agent, so publishing Gots's news to
that topic would hand the agent its own notifications, and a topic equal to it is refused.

The target follows the bot to every phone: a phone that joins reads where to publish from the host,
never from itself, and the categories it wants are one list for every phone on the topic. The devices
that chose ntfy are kept beside it, for two things — the registry is told to skip them, so a Firebase
token still on file can't deliver the same news twice, and a publish is held back while every one of
them has the app on screen.

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

from . import link
from .notice import UNTITLED, WORDS, Notice
from .store import connect, home_of

logger = logging.getLogger(__name__)

KEY = "ntfy"
# The environment Hermes's own ntfy platform reads (`plugins/platforms/ntfy/plugin.yaml`).
SERVER_ENV = "NTFY_SERVER_URL"
TOKEN_ENV = "NTFY_TOKEN"
TOPIC_ENV = "NTFY_TOPIC"
DEFAULT_SERVER = "https://ntfy.sh"
SEND_TIMEOUT = 10
MAX_DEVICES = 20
# ntfy's own rule for a topic and for a sequence id (`topicRegex` in its server).
TOPIC = re.compile(r"^[-_A-Za-z0-9]{1,64}$")
# A token rides in a header: printable ASCII with no spaces, as ntfy's `tk_…` tokens are.
TOKEN = re.compile(r"^[\x21-\x7e]{1,512}$")
DEVICE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
DEFAULT_PRIORITY = 3


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


def _env(path: Path, key: str) -> str:
    """One of Hermes's own variables for this profile, through its credential helper and under the
    profile's scope — a delivery runs on a thread of its own, which carries no scope — or the
    profile's ``.env`` where this host has no helper."""
    from .profile_scope import profile_scope

    home = home_of(path)
    try:
        from agent.credential_pool import get_env_prefer_dotenv
    except ImportError:
        return link.env_value(home, key).strip()
    with profile_scope(home):
        return str(get_env_prefer_dotenv(key) or "").strip()


def stored(path: Path) -> Dict[str, Any]:
    """What the plugin keeps for this profile's ntfy: the topic, the phones and their categories."""
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


def held(path: Path) -> Dict[str, Any]:
    """The whole target as it stands: the plugin's own topic, and Hermes's server and token."""
    value = dict(stored(path))
    value.pop("token", None)
    value.pop("server", None)
    explicit = _env(path, SERVER_ENV)
    value["server"] = (explicit or DEFAULT_SERVER).rstrip("/")
    value["server_set"] = bool(explicit)
    token = _env(path, TOKEN_ENV)
    if token:
        value["token"] = token
    return value


def complete(value: Dict[str, Any]) -> bool:
    return all(isinstance(value.get(k), str) and value[k] for k in ("server", "topic", "token"))


def target(path: Path) -> Optional[Dict[str, Any]]:
    """Where this profile publishes, or None while it has no topic or Hermes holds no token: a
    target with no token publishes nothing, which is what makes the token required."""
    if not stored(path).get("topic"):
        return None
    value = held(path)
    return value if complete(value) else None


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
    """Writes what the body names, and that a device chose this target. Raises ``PushError`` with a
    message for the app.

    The topic is kept here; the server and the token are Hermes's own variables and are written to
    the profile's ``.env`` with Hermes's own writer, so Hermes's ntfy platform reads what was set
    here and the other way round. An empty server is the default one. The token is never read back.
    """
    from .push import clean_categories

    value = dict(stored(path))
    value.pop("server", None)
    value.pop("token", None)
    home = home_of(path)
    if "topic" in body:
        topic = body.get("topic")
        if not isinstance(topic, str) or not TOPIC.match(topic):
            raise _error("Not an ntfy topic.")
        if topic == _env(path, TOPIC_ENV):
            raise _error(
                "That's the topic Hermes listens on for messages, so it can't carry notifications."
            )
        value["topic"] = topic
    server: Optional[str] = None
    if "server" in body:
        typed = body.get("server")
        server = "" if typed in ("", None) else clean_server(typed)
    token = body.get("token")
    if token is not None and (not isinstance(token, str) or not TOKEN.match(token)):
        raise _error("Not an ntfy access token.")
    device = body.get("device")
    if device is not None:
        if not isinstance(device, str) or not DEVICE.match(device):
            raise _error("Not a device.")
        whole = {**held(path), **value}
        if server is not None:
            whole["server"] = server or DEFAULT_SERVER
        if token:
            whole["token"] = token
        if not complete(whole):
            raise _error("Set this bot's ntfy topic and Hermes's ntfy token first.")
        devices = [d for d in value.get("devices") or [] if d != device] + [device]
        value["devices"] = devices[-MAX_DEVICES:]
    categories = clean_categories(body.get("categories"))
    if categories is not None:
        value["categories"] = categories
    priorities = _priorities(body.get("priorities"))
    if priorities:
        value["priorities"] = priorities
    # Every check has passed, so nothing below is left half-written.
    if server is not None:
        link.set_env(home, SERVER_ENV, server)
    if token:
        link.set_env(home, TOKEN_ENV, token)
    _write(path, value)
    return held(path)


def remove(path: Path, device: Optional[str]) -> Dict[str, Any]:
    """A device stops using ntfy, and the target stays the bot's. With no device named, the plugin's
    own part goes — the topic and its phones — and Hermes's server and token stay, being Hermes's."""
    if not device:
        _write(path, None)
        return held(path)
    value = stored(path)
    if value:
        value["devices"] = [d for d in value.get("devices") or [] if d != device]
        _write(path, value)
    return held(path)


def public(value: Optional[Dict[str, Any]], device: Optional[str] = None) -> Dict[str, Any]:
    """The target as the app may read it: everything but the token, which is only ever a boolean.
    ``configured`` is whether it can publish, ``joined`` whether the device asking chose ntfy here,
    and ``server_set`` whether the server is the profile's own or the default."""
    value = value or {}
    devices = [d for d in value.get("devices") or [] if isinstance(d, str)]
    return {
        "object": "gots.push_ntfy",
        "configured": complete(value),
        "server": value.get("server") or DEFAULT_SERVER,
        "server_set": bool(value.get("server_set")),
        "topic": value.get("topic"),
        "token_set": bool(value.get("token")),
        "categories": value.get("categories"),
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
    held: Dict[str, Any], kind: str, category: str, session_id: str, notice: Optional[Notice] = None
) -> Dict[str, Any]:
    """The JSON a publish posts to the server's root: the notice's title over its body, with the
    kind's own line standing in where the notice names no words."""
    title = ((notice or {}).get("title") or "").strip() or UNTITLED.get(kind) or "Gots"
    words = ((notice or {}).get("body") or "").strip() or WORDS.get(kind, "Waiting for you")
    priorities = held.get("priorities") if isinstance(held.get("priorities"), dict) else {}
    sequence = hashlib.sha256(f"{category}:{session_id}".encode()).digest()[:18]
    return {
        "topic": held["topic"],
        "title": title,
        "message": words,
        "priority": priorities.get(category, DEFAULT_PRIORITY),
        "click": click(kind, session_id),
        # A newer message of the same category about the same thing replaces one still showing.
        "sequence_id": base64.urlsafe_b64encode(sequence).rstrip(b"=").decode(),
    }


def auth_header(token: str) -> Dict[str, str]:
    """The ``Authorization`` header Hermes's own ntfy platform builds from ``NTFY_TOKEN``: a
    ``user:pass`` token is Basic, anything else Bearer — one token, read the same way on both sides."""
    token = token.strip()
    if not token:
        return {}
    if ":" in token:
        return {"Authorization": "Basic " + base64.b64encode(token.encode()).decode()}
    return {"Authorization": f"Bearer {token}"}


def publish(held: Dict[str, Any], body: Dict[str, Any]) -> Optional[int]:
    """One message to the topic. The server's status, or None if it didn't answer."""
    request = urllib.request.Request(
        held["server"] + "/",
        data=json.dumps(body, separators=(",", ":")).encode(),
        headers={**auth_header(held["token"]), "Content-Type": "application/json"},
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
    notice: Optional[Notice] = None,
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
    status = publish(held, message(held, kind, category, session_id, notice))
    if status is None or status >= 300:
        # 401 and 403 are the token; the app's own switch is where it is put right.
        logger.warning("gots: ntfy at %s answered %s", urllib.parse.urlsplit(held["server"]).netloc, status)
    return status
