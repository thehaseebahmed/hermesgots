"""Web Push: tells a device that a session is waiting on the user, or has news, while the app is closed.

The app hands each device's push subscription to the plugin, together with a VAPID key it made for
that device (one browser subscription is tied to one key, so a device can't have a key per bot).
When a run starts waiting (an approval, a question) or a plan is ready, ``notify`` sends every
subscription of the profile a small message, encrypted to that device (RFC 8291) and signed with its
VAPID key (RFC 8292), through the push service the browser named. The message says what kind of
news, which session, its title (the chat's, the routine's or the project's name) and which bot
character to show, never what was asked; the push service can't read it either.

The Android app has no Push API, so for it the plugin asks the Gots registry (``link.py``) to send
through Firebase, since the service account key can't live on every host: the message is the same, so
the registry and Firebase see the title, never what was asked.

A device that has the app open (it holds an ``events`` stream) is skipped: it already knows. A
session another surface started is no device's news at all: a push about a session goes only when
that session, or an ancestor of it, is one of the app's chats — the chat compression moved it
onto, and the chat a subagent forked it off, are both the chat's news — or is the profile's own
Bot Chat, which is the bot's Main, or carries a chat record, which is how a routine's run is the
app's news.
Everything here is best effort and runs on its own thread, so a slow push service never holds up
Hermes.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import logging
import os
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from . import answers, link, ntfy
from .notice import (
    CATEGORIES,
    KINDS,
    KINDS_BY_NAME,
    LEGACY_CATEGORIES,
    SESSION_KINDS,
    Action,
    Notice,
    carried,
    category_of,
    flatten,
)
from .store import connect, current_path, home_of

logger = logging.getLogger(__name__)

# A message waits this long at the push service for an offline device.
TTL_SECONDS = 600
SEND_TIMEOUT = 10
RELAY_TRIES = 4
RELAY_RETRY_SECONDS = 1.1
# One notification per kind and session in this window.
THROTTLE_SECONDS = 5
# A notification's title is cut here; the push services accept 4096 bytes in all.
TITLE_MAX = 80
# The push services accept 4096 bytes; ours are far smaller.
RECORD_SIZE = 4096
MAX_SUBSCRIPTIONS = 20

_lock = threading.Lock()
_last: Dict[Tuple[str, str, str], float] = {}
# Streams open per (database, device): the app on screen.
_open: Dict[Tuple[str, str], int] = {}


class PushError(ValueError):
    pass


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _point(public_key: ec.EllipticCurvePublicKey) -> bytes:
    return public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )


def encrypt(payload: bytes, p256dh: str, auth: str) -> bytes:
    """``aes128gcm`` (RFC 8291): the request body for a message to one subscription."""
    ua_public = _unb64(p256dh)
    ua_key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_public)
    sender = ec.generate_private_key(ec.SECP256R1())
    sender_public = _point(sender.public_key())
    secret = sender.exchange(ec.ECDH(), ua_key)
    key_info = b"WebPush: info\x00" + ua_public + sender_public
    ikm = HKDF(hashes.SHA256(), 32, _unb64(auth), key_info).derive(secret)
    salt = os.urandom(16)
    key = HKDF(hashes.SHA256(), 16, salt, b"Content-Encoding: aes128gcm\x00").derive(ikm)
    nonce = HKDF(hashes.SHA256(), 12, salt, b"Content-Encoding: nonce\x00").derive(ikm)
    # A single record, so the padding delimiter is the last-record marker.
    sealed = AESGCM(key).encrypt(nonce, payload + b"\x02", None)
    header = salt + RECORD_SIZE.to_bytes(4, "big") + bytes([len(sender_public)]) + sender_public
    return header + sealed


def vapid_headers(endpoint: str, vapid_key: str, subject: str) -> Dict[str, str]:
    """The ``Authorization`` header of RFC 8292: a short-lived ES256 token for the push service."""
    parts = urllib.parse.urlsplit(endpoint)
    private = ec.derive_private_key(int.from_bytes(_unb64(vapid_key), "big"), ec.SECP256R1())

    def segment(value: Dict[str, Any]) -> str:
        return _b64(json.dumps(value, separators=(",", ":")).encode())

    signing = (
        segment({"typ": "JWT", "alg": "ES256"})
        + "."
        + segment(
            {
                "aud": f"{parts.scheme}://{parts.netloc}",
                "exp": int(time.time()) + 12 * 3600,
                "sub": subject,
            }
        )
    )
    r, s = decode_dss_signature(private.sign(signing.encode(), ec.ECDSA(hashes.SHA256())))
    token = signing + "." + _b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    return {"Authorization": f"vapid t={token}, k={_b64(_point(private.public_key()))}"}


def _public_endpoint(endpoint: str) -> bool:
    """Whether an endpoint is a public https URL: the plugin posts to whatever it is handed."""
    parts = urllib.parse.urlsplit(endpoint)
    host = parts.hostname
    if parts.scheme != "https" or not host or parts.username or parts.password:
        return False
    if host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return "." in host
    return address.is_global


def clean_categories(value: Any) -> Optional[List[str]]:
    """The categories a device asked for, without any this plugin doesn't know. None means it didn't
    say, which an older app doesn't."""
    if not isinstance(value, list):
        return None
    return [category for category in CATEGORIES if category in value]


def wants(row: Dict[str, Any], category: str) -> bool:
    """Whether a subscription asked for this category of push."""
    try:
        categories = json.loads(row["categories"]) if row.get("categories") else None
    except ValueError:
        categories = None
    return category in (categories if isinstance(categories, list) else LEGACY_CATEGORIES)


def subscribe(path: Path, body: Dict[str, Any]) -> None:
    """Keeps a device's subscription. Raises ``PushError`` with a message for the app."""
    sub = body.get("subscription")
    keys = sub.get("keys") if isinstance(sub, dict) else None
    endpoint = sub.get("endpoint") if isinstance(sub, dict) else None
    device, vapid_key, subject = body.get("device"), body.get("vapid_key"), body.get("subject")
    if not (isinstance(keys, dict) and isinstance(endpoint, str)):
        raise PushError("Missing subscription.")
    p256dh, auth = keys.get("p256dh"), keys.get("auth")
    if not all(isinstance(v, str) and v for v in (p256dh, auth, device, vapid_key, subject)):
        raise PushError("Missing subscription fields.")
    if not _public_endpoint(endpoint) or urllib.parse.urlsplit(str(subject)).scheme not in ("https", "mailto"):
        raise PushError("Not a push service address.")
    try:
        # Rejects a malformed key now rather than on the first message.
        encrypt(b"", p256dh, auth)
        vapid_headers(endpoint, vapid_key, subject)
    except Exception as exc:
        raise PushError("Not a usable subscription.") from exc
    categories = clean_categories(body.get("categories"))
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        # A device has one subscription: a new one replaces the old.
        conn.execute("DELETE FROM push_subscriptions WHERE device = ? AND endpoint != ?", (device, endpoint))
        conn.execute(
            """INSERT INTO push_subscriptions (endpoint, device, p256dh, auth, vapid_key, subject, created_at, categories)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(endpoint) DO UPDATE SET device = excluded.device, p256dh = excluded.p256dh,
                 auth = excluded.auth, vapid_key = excluded.vapid_key, subject = excluded.subject,
                 categories = excluded.categories""",
            (
                endpoint,
                device,
                p256dh,
                auth,
                vapid_key,
                subject,
                int(time.time() * 1000),
                json.dumps(categories) if categories is not None else None,
            ),
        )
        count = conn.execute("SELECT COUNT(*) FROM push_subscriptions").fetchone()[0]
        if count > MAX_SUBSCRIPTIONS:
            conn.execute(
                "DELETE FROM push_subscriptions WHERE endpoint IN "
                "(SELECT endpoint FROM push_subscriptions ORDER BY created_at LIMIT ?)",
                (count - MAX_SUBSCRIPTIONS,),
            )
        conn.execute("COMMIT")
    finally:
        conn.close()


def unsubscribe(path: Path, endpoint: str) -> None:
    conn = connect(path)
    try:
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))
    finally:
        conn.close()


def _rows(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    conn = connect(path)
    try:
        cursor = conn.execute(
            "SELECT endpoint, device, p256dh, auth, vapid_key, subject, categories FROM push_subscriptions"
        )
        names = [c[0] for c in cursor.description]
        return [dict(zip(names, row)) for row in cursor.fetchall()]
    finally:
        conn.close()


def watching(path: Path, device: str) -> "_Watch":
    """Marks a device as having the app on screen while its stream is open."""
    return _Watch((str(path), device))


class _Watch:
    def __init__(self, key: Tuple[str, str]):
        self.key = key

    def __enter__(self) -> None:
        with _lock:
            _open[self.key] = _open.get(self.key, 0) + 1

    def __exit__(self, *exc: Any) -> None:
        with _lock:
            left = _open.get(self.key, 1) - 1
            if left > 0:
                _open[self.key] = left
            else:
                _open.pop(self.key, None)


def _on_screen(path: Path, device: str) -> bool:
    with _lock:
        return (str(path), device) in _open


def send(row: Dict[str, Any], payload: Dict[str, Any], topic: str) -> Optional[int]:
    """One message to one subscription. The push service's status, or None if it didn't answer."""
    body = encrypt(json.dumps(payload, separators=(",", ":")).encode(), row["p256dh"], row["auth"])
    headers = {
        **vapid_headers(row["endpoint"], row["vapid_key"], row["subject"]),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": str(TTL_SECONDS),
        "Urgency": "high",
        # A newer message about the same wait replaces one still queued.
        "Topic": topic,
    }
    request = urllib.request.Request(row["endpoint"], data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=SEND_TIMEOUT) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, OSError):
        return None


def _on_screen_devices(path: Path) -> List[str]:
    with _lock:
        return [device for (db, device) in _open if db == str(path)]


def _relay(path: Path, kind: str, category: str, session_id: str, notice: Notice) -> None:
    """Asks the registry to push to the account's Android installs, if this profile is linked."""
    home = home_of(path)
    state = link.load_state(home)
    if not state.get("token") or state.get("revoked") or not state.get("site"):
        return
    fields = carried(notice)
    # The chat it is about and the buttons that act on it: only the phone's own tray can draw them.
    conversation = notice.conversation if isinstance(notice, Notice) else {}
    # The phone draws the notice itself (a notification payload is Android's to draw, and its drawing
    # can carry no button), so it is told whose picture to wear and where that picture is: the app's
    # own file, at the origin its subscription named, never the host's address, which may be a
    # tunnel. It is the bot's plain face rather than the badge the browser's tray and ntfy wear:
    # Android badges a conversation's picture with the app's icon itself.
    picture = face(web(path), fields.get("bot"))
    answer = None
    for attempt in range(RELAY_TRIES):
        try:
            answer = link.call(
                state["site"],
                "POST",
                "push",
                token=state["token"],
                body={
                    "kind": kind,
                    "category": category,
                    "session_id": session_id,
                    # A device that chose ntfy is told there, so a token it left on file stays quiet.
                    "skip": list(dict.fromkeys(_on_screen_devices(path) + ntfy.devices(path)))[:50],
                    **fields,
                    **conversation,
                    **({"icon": picture} if picture else {}),
                },
            )
            break
        except link.LinkError as error:
            if error.status == 429 and attempt + 1 < RELAY_TRIES:
                # The registry takes one push a second from a host, and news can come in bunches.
                time.sleep(RELAY_RETRY_SECONDS)
                continue
            # 503: the site has no Firebase key. Not worth a retry.
            logger.warning("gots: the registry wouldn't push (%s)", error)
            break
    if isinstance(answer, dict) and not answer.get("sent") and answer.get("failed"):
        logger.warning("gots: the registry couldn't deliver the push (%s)", answer)
    if not (isinstance(answer, dict) and answer.get("sent")):
        # A reply link is minted for the relay alone, so one the relay put on no phone — every
        # device on screen or not wanting the category, or a push that never went — is withdrawn.
        answers.withdraw(path, conversation.get("reply"))


def face(origin: Optional[str], bot: Optional[str]) -> Optional[str]:
    """This profile's bot's own picture, unbadged, at the app's own origin, or None while either is
    unknown: what the Android tray wears (``ntfy.icon`` is the badged one, for trays that can't)."""
    if not origin or not bot:
        return None
    return f"{origin}/bots/{bot}/happy.png"


def reachable(path: Path) -> bool:
    """Whether any device could be told: a browser subscription, an ntfy topic, or a link to the
    registry."""
    return bool(_rows(path)) or ntfy.target(path) is not None or _linked(path)


def _linked(path: Path) -> bool:
    state = link.load_state(home_of(path))
    return bool(state.get("token") and not state.get("revoked") and state.get("site"))


def _deliver(path: Path, kind: str, category: str, session_id: str, notice: Optional[Notice] = None) -> None:
    # A notice with no words is still a notice: it may carry buttons, and an empty mapping is falsy.
    notice = notice if notice is not None else Notice()
    # At most 32 characters of base64url, and distinct per session however long its id is.
    topic = _b64(hashlib.sha256(f"{kind}:{session_id}".encode()).digest()[:18])
    payload = {"kind": kind, "session_id": session_id, **carried(notice)}
    for row in _rows(path):
        if _on_screen(path, row["device"]) or not wants(row, category):
            continue
        status = send(row, payload, topic)
        if status in (404, 410):
            # The browser dropped the subscription (or the user revoked it).
            unsubscribe(path, row["endpoint"])
        elif status is None or status >= 300:
            logger.debug("gots: push to %s answered %s", urllib.parse.urlsplit(row["endpoint"]).netloc, status)
    try:
        ntfy.deliver(path, kind, category, session_id, notice, _on_screen_devices(path))
    except Exception:
        logger.debug("gots: an ntfy publish failed", exc_info=True)
    _relay(path, kind, category, session_id, notice)


SEEN_KEEP_MS = 30 * 24 * 3600 * 1000


def once(path: Path, key: str) -> bool:
    """True the first time a key is seen (and remembers it), so a thing that can show up again on
    every pass, like a failed routine run, is pushed once."""
    now = int(time.time() * 1000)
    conn = connect(path)
    try:
        conn.execute("DELETE FROM push_seen WHERE at < ?", (now - SEEN_KEEP_MS,))
        cursor = conn.execute("INSERT OR IGNORE INTO push_seen (key, at) VALUES (?, ?)", (key, now))
        return cursor.rowcount == 1
    finally:
        conn.close()


def clear(path: Path, key: str) -> None:
    """Forgets a key, so the next time it comes up it is pushed again."""
    conn = connect(path)
    try:
        conn.execute("DELETE FROM push_seen WHERE key = ?", (key,))
    finally:
        conn.close()


def _gots_chat(path: Path, session_id: str) -> bool:
    """Whether a session is one of this app's: one it minted (or an ancestor it minted), the
    profile's own Main, or one a chat record names.

    ``sessions.is_chat`` answers the ids the app made and the profile's canonical Bot Chat — which
    is Main, so a reply there is the bot's own news; a routine's run wrote in a session of its own,
    which the app never minted, and the chat record its delivery published names it — that record is
    what makes the run the app's news. An id with none of the three is another surface's and
    nobody's news.
    """
    from . import chats, sessions

    if sessions.is_chat(home_of(path), session_id):
        return True
    return chats.by_session(path, session_id) is not None


def notify(
    kind: str,
    session_id: Optional[str],
    path: Optional[Path] = None,
    title: Optional[str] = None,
    body: Optional[str] = None,
    answer: Optional[Dict[str, Any]] = None,
) -> None:
    """Something a device should hear about. ``session_id`` is the session it is about, or for the
    kinds that aren't about one the routine's job id (``routine_failed``), the project's id
    (``clone_failed``), the research mission's id (``research_*``) or the room's id
    (``room_input``); it only picks what a tap opens. ``title`` names what it is about when that
    isn't a session (whose chat title is looked up), and ``body`` is what it says where a kind's own
    line is not the news — a finished run's paragraph, a failed one's error. ``answer`` is the
    approval the notice is about, as ``answers.run_target`` or ``answers.room_target`` spells it,
    and the notice then carries the two buttons that settle it — where this host knows the address
    the app dialled, since a button that can't be pressed is worse than no button. A kind about a
    session (``SESSION_KINDS``) is only pushed for a session that is one of the app's chats, or one
    a chat record names; another surface's session is no device's news. Answers whether a push will
    be sent — a device exists that asked for this category, and one of this kind for this id wasn't
    told a moment ago — so a caller that remembers what it has told the user doesn't remember a
    push that was dropped. Never raises: it runs inside Hermes's hooks."""
    try:
        if kind not in KINDS or not session_id:
            return False
        if path is None:
            # Hooks run inside the turn's profile scope, so this is that profile's store.
            path = current_path()
        if kind in SESSION_KINDS and not _gots_chat(path, session_id):
            return False
        now = time.monotonic()
        key = (str(path), kind, session_id)
        with _lock:
            if now - _last.get(key, -THROTTLE_SECONDS) < THROTTLE_SECONDS:
                return False
            _last[key] = now
            if len(_last) > 512:
                _last.clear()
        if not reachable(path):
            return False
        threading.Thread(
            target=_run, args=(path, kind, session_id, title, body, answer), name="gots-push", daemon=True
        ).start()
        return True
    except Exception:
        logger.debug("gots: couldn't send a push", exc_info=True)
        return False


BOT_ID = re.compile(r"^[a-z0-9-]{1,32}$")


def _pref(path: Path, key: str, valid: Any = None) -> Optional[str]:
    """One value this profile keeps in `push_prefs`, where it holds one this build still accepts."""
    if not path.exists():
        return None
    conn = connect(path)
    try:
        row = conn.execute("SELECT value FROM push_prefs WHERE key = ?", (key,)).fetchone()
    finally:
        conn.close()
    if row is None or not isinstance(row[0], str):
        return None
    return row[0] if valid is None or valid.match(row[0]) else None


def _set_pref(path: Path, key: str, value: Optional[str]) -> None:
    """Keeps one value in `push_prefs`, or drops the row while there is none to keep."""
    conn = connect(path)
    try:
        if value:
            conn.execute("INSERT OR REPLACE INTO push_prefs (key, value) VALUES (?, ?)", (key, value))
        else:
            conn.execute("DELETE FROM push_prefs WHERE key = ?", (key,))
    finally:
        conn.close()


def set_bot(path: Path, bot: str) -> None:
    """Which of the app's bot characters this profile is, so a notification shows its picture."""
    if not BOT_ID.match(bot):
        raise PushError("Not a bot.")
    _set_pref(path, "bot", bot)


def bot(path: Path) -> Optional[str]:
    return _pref(path, "bot", BOT_ID)


def set_bot_muted(path: Path, muted: bool) -> None:
    """Mutes or unmutes every push from this profile (the bot), whatever device would get it."""
    _set_pref(path, "muted", "1" if muted else None)


def bot_muted(path: Path) -> bool:
    return _pref(path, "muted") is not None


def _lineage(path: Path, session_id: str) -> List[str]:
    """The session and its compression ancestors: the chat knows the oldest."""
    from . import sessions

    found: List[str] = []
    current: Optional[str] = session_id
    for _ in range(sessions.MAX_PARENT_HOPS + 1):
        if not current or current in found:
            break
        found.append(current)
        current = sessions._parent_of(home_of(path), current)
    return found


def _chat_entry(path: Path, session_id: str) -> Optional[Tuple[str, Dict[str, Any]]]:
    """This session's chat as the app last synced it: its id and its chat list record."""
    from . import chats

    ids = set(_lineage(path, session_id))
    for chat_id, entry in chats.read(path).items():
        value = entry.get("value")
        if entry.get("deleted") or not isinstance(value, dict):
            continue
        if value.get("hermesSessionId") in ids:
            return chat_id, value
    return None


def _chat(path: Path, session_id: str) -> Optional[Dict[str, Any]]:
    """The chat list record of this session's chat, as the app last synced it."""
    found = _chat_entry(path, session_id)
    return found[1] if found else None


def thread_muted(path: Path, session_id: str) -> bool:
    """Whether the chat of this session was muted in the app (``muted`` in its chat list record)."""
    chat = _chat(path, session_id)
    return bool(chat and chat.get("muted"))


def _hermes_title(path: Path, session_id: str) -> Optional[str]:
    """The title Hermes gave the session or its nearest ancestor, for a chat the app hasn't synced."""
    state = home_of(path) / "state.db"
    if not state.exists():
        return None
    try:
        with sqlite3.connect(f"{state.as_uri()}?mode=ro", uri=True, timeout=2) as conn:
            for current in _lineage(path, session_id):
                row = conn.execute("SELECT title FROM sessions WHERE id = ?", (current,)).fetchone()
                if row and isinstance(row[0], str) and row[0].strip():
                    return row[0]
    except sqlite3.Error:
        return None
    return None


def session_title(path: Path, session_id: str, chat: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """What the user calls the session's chat: the app's title (renames included), else Hermes's.

    ``chat`` is that chat's record where the caller has already found it.
    """
    chat = chat if chat is not None else _chat(path, session_id)
    title = chat.get("title") if chat else None
    if isinstance(title, str) and title.strip():
        return title
    return _hermes_title(path, session_id)


def _short(text: Optional[str]) -> Optional[str]:
    if not isinstance(text, str):
        return None
    return flatten(text, TITLE_MAX) or None


def muted(path: Path, kind: str, session_id: str) -> bool:
    return bot_muted(path) or (kind in SESSION_KINDS and thread_muted(path, session_id))


def _project_session(path: Path, session_id: str) -> bool:
    from . import sessions

    return bool(sessions.record_for(path, home_of(path), session_id))


def _run(
    path: Path,
    kind: str,
    session_id: str,
    title: Optional[str] = None,
    body: Optional[str] = None,
    answer: Optional[Dict[str, Any]] = None,
) -> None:
    try:
        if muted(path, kind, session_id):
            return
        project = kind in SESSION_KINDS and _project_session(path, session_id)
        notice = _notice(path, kind, session_id, title, body, answer)
        _deliver(path, kind, category_of(kind, project), session_id, notice)
    except Exception:
        logger.debug("gots: a push failed", exc_info=True)


def _notice(
    path: Path,
    kind: str,
    session_id: str,
    title: Optional[str],
    body: Optional[str],
    answer: Optional[Dict[str, Any]],
) -> Notice:
    """The whole notice one piece of news makes: its words, its bot, its buttons and the part only
    the Android tray draws, built in one place so every transport is handed the same value."""
    conversation: Dict[str, Any] = {}
    if kind in SESSION_KINDS:
        # The chat the news is about, found through the lineage the title already walks: the phone
        # keys its conversation entry and its shortcut by it, and can't find it from a session that
        # compression moved on.
        found = _chat_entry(path, session_id)
        if found:
            conversation["chat"] = found[0]
            if KINDS_BY_NAME[kind].read:
                # Mark as read covers the activity this notice reports, on the host's clock: the app
                # holds the chat read through it, since a later sync can write a newer clock of its own.
                conversation["read"] = True
                conversation["at"] = int(time.time() * 1000)
            reply = _reply(path, kind, session_id, *found)
            if reply:
                conversation["reply"] = reply
        if not title:
            title = session_title(path, session_id, found[1] if found else None)
    return Notice(
        title=_short(title),
        body=body,
        bot=bot(path),
        actions=_buttons(path, answer),
        conversation=conversation,
    )


def _reply(path: Path, kind: str, session_id: str, chat_id: str, chat: Dict[str, Any]) -> Optional[str]:
    """The reply link a chat's notice carries, where a kind takes one and someone could press it.

    Only the relay to Android draws a reply, so a profile not linked to the registry mints none —
    a credential no transport carries is one nobody can press — and a chat the user is done with
    takes none, since a turn queued there would reopen work they put away. The turn goes on the
    session the chat names, which is the one its record keeps however compression moved it on.
    """
    if not KINDS_BY_NAME[kind].reply or not _linked(path):
        return None
    from . import chats

    if chats.closed({"value": chat}):
        return None
    root = chat.get("hermesSessionId") if isinstance(chat.get("hermesSessionId"), str) else session_id
    return answers.reply_link(path, root, chat_id, base(path))


def _buttons(path: Path, answer: Optional[Dict[str, Any]]) -> Tuple[Action, ...]:
    """The buttons a notice carries: an approval's two, where this host knows how to be reached.

    The address is the one the phone dialled — a host behind a tunnel or on a LAN name doesn't know
    its own — so a profile no app has subscribed to from anywhere mints none: a button that can't be
    pressed is worse than no button.
    """
    if not answer:
        return ()
    return answers.mint(path, answer, base(path), TTL_SECONDS)


# Where the app dialled this bot, as `POST push` and `POST push/ntfy` keep it: the scheme and host,
# then every path segment up to the plugin's own routes (a bot at /p/<profile> carries that too).
# A button posts back to the same address, since the same phone reaches both.
BASE = re.compile(r"^https?://[^\s/?#]+(?:/[^\s?#]*)?$")
_FORWARDED = ("X-Forwarded-Proto", "X-Forwarded-Host")


def _header(request: Any, name: str) -> Optional[str]:
    """One request header by name, first value only.

    The server's own mapping already answers whatever case a client sent it in, so the name is asked
    for once. A proxy appends what it forwarded to a list, and the first is the client's own.
    """
    headers = getattr(request, "headers", None) or {}
    value = headers.get(name)
    if isinstance(value, str) and value.strip():
        return value.split(",")[0].strip()
    return None


def base_url(request: Any, tail: str) -> Optional[str]:
    """The address an app dialled this bot at, to the plugin's own prefix: for a button's link.

    Read off the request the app subscribed with — ``request.scheme`` and ``Host``, or what a proxy
    forwarded as ``X-Forwarded-Proto``/``X-Forwarded-Host``, since a host behind one is reached by the
    proxy's name and scheme, not its own. ``tail`` is this route's own path under the plugin, which is
    cut off; ``None`` where the request doesn't say (an app that reached a route some other way), which
    leaves no button rather than a guess at where one lives.
    """
    path = getattr(request, "path", "") or ""
    if not isinstance(path, str) or not path.endswith(tail):
        return None
    proto = _header(request, _FORWARDED[0]) or getattr(request, "scheme", None)
    host = _header(request, _FORWARDED[1]) or _header(request, "Host")
    if proto not in ("http", "https") or not isinstance(host, str) or not host:
        return None
    base = f"{proto}://{host}{path[: -len(tail)]}"
    return base if BASE.match(base) else None


def set_base(path: Path, base: Optional[str]) -> None:
    """Keeps the address the app dialled, so a notice built later can carry a button back to it.

    A request that names no address leaves the one already kept alone rather than forgetting it: the
    routes that record this include the poll every screen makes, and a poll that reached one some
    other way must not take away the address a button already posts to. An address this profile
    already holds is not written again — that poll comes every few seconds, and nothing changed.
    """
    if not base:
        return
    if _pref(path, "base", BASE) == base:
        return
    _set_pref(path, "base", base)


def base(path: Path) -> Optional[str]:
    """Where the app last dialled this bot, or None while no app has subscribed from anywhere."""
    return _pref(path, "base", BASE)


# The app's own origin, as a browser's `location.origin` spells it: scheme, host and port, no path,
# no search and no fragment. A notification's picture is the app's own file (`/bots/<id>/notify.png`),
# so it is named at this origin rather than at the host, which may be a tunnel or a LAN name.
WEB = re.compile(r"^https?://[^\s/?#]+$")


def set_web(path: Path, origin: Optional[str]) -> None:
    """Keeps where the app lives, so a notice published elsewhere can name the app's own picture.

    Read from the ``subject`` the app subscribed with — its ``location.origin``. A subscription that
    names a ``mailto:`` contact instead (an older app's) leaves none: there is no picture at a mailbox.
    """
    origin = origin.strip() if isinstance(origin, str) else None
    _set_pref(path, "web", origin if origin and WEB.match(origin) else None)


def web(path: Path) -> Optional[str]:
    """Where the app lives, or None while no app has subscribed from a page of its own."""
    return _pref(path, "web", WEB)
