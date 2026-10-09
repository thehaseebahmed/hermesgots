"""Web Push: tells a device that a session is waiting on the user, or has news, while the app is closed.

The app hands each device's push subscription to the plugin, together with a VAPID key it made for
that device (one browser subscription is tied to one key, so a device can't have a key per bot).
When a run starts waiting (an approval, a question) or a plan is ready, ``notify`` sends every
subscription of the profile a small message, encrypted to that device (RFC 8291) and signed with its
VAPID key (RFC 8292), through the push service the browser named. The message says what kind of
wait and which session, never what was asked; the push service can't read it either.

The Android app has no Push API, so for it the plugin asks the Memento registry (``link.py``) to send
through Firebase, since the service account key can't live on every host: the message is the same, and
the registry only sees that a session waits.

A device that has the app open (it holds an ``events`` stream) is skipped: it already knows.
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

from . import link
from .store import connect, db_path

logger = logging.getLogger(__name__)

# A message waits this long at the push service for an offline device.
TTL_SECONDS = 600
SEND_TIMEOUT = 10
RELAY_TRIES = 4
RELAY_RETRY_SECONDS = 1.1
# One notification per kind and session in this window.
THROTTLE_SECONDS = 5
# The push services accept 4096 bytes; ours are far smaller.
RECORD_SIZE = 4096
MAX_SUBSCRIPTIONS = 20
# What a push is about. The first three wait on the user; the rest are news. The registry
# (`app/netlify/lib/fcm.ts`) and the app (`app/src/lib/push-kinds.ts`) keep the same list.
LEGACY_KINDS = ("approval", "question", "plan")
KINDS = LEGACY_KINDS + (
    "theseus",
    "run_done",
    "run_failed",
    "pr_checks",
    "pr_merged",
    "clone_failed",
    "routine_failed",
)

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


def clean_kinds(value: Any) -> Optional[List[str]]:
    """The kinds a device asked for, without any this plugin doesn't know. None means it didn't say,
    which an older app doesn't."""
    if not isinstance(value, list):
        return None
    return [kind for kind in KINDS if kind in value]


def wants(row: Dict[str, Any], kind: str) -> bool:
    """Whether a subscription asked for this kind of push."""
    try:
        kinds = json.loads(row["kinds"]) if row.get("kinds") else None
    except ValueError:
        kinds = None
    return kind in (kinds if isinstance(kinds, list) else LEGACY_KINDS)


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
    kinds = clean_kinds(body.get("kinds"))
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        # A device has one subscription: a new one replaces the old.
        conn.execute("DELETE FROM push_subscriptions WHERE device = ? AND endpoint != ?", (device, endpoint))
        conn.execute(
            """INSERT INTO push_subscriptions (endpoint, device, p256dh, auth, vapid_key, subject, created_at, kinds)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(endpoint) DO UPDATE SET device = excluded.device, p256dh = excluded.p256dh,
                 auth = excluded.auth, vapid_key = excluded.vapid_key, subject = excluded.subject,
                 kinds = excluded.kinds""",
            (
                endpoint,
                device,
                p256dh,
                auth,
                vapid_key,
                subject,
                int(time.time() * 1000),
                json.dumps(kinds) if kinds is not None else None,
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
            "SELECT endpoint, device, p256dh, auth, vapid_key, subject, kinds FROM push_subscriptions"
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


def _relay(path: Path, kind: str, session_id: str) -> None:
    """Asks the registry to push to the account's Android installs, if this profile is linked."""
    home = path.parent.parent
    state = link.load_state(home)
    if not state.get("token") or state.get("revoked") or not state.get("site"):
        return
    answer = None
    for attempt in range(RELAY_TRIES):
        try:
            answer = link.call(
                state["site"],
                "POST",
                "push",
                token=state["token"],
                body={"kind": kind, "session_id": session_id, "skip": _on_screen_devices(path)[:50]},
            )
            break
        except link.LinkError as error:
            if error.status == 429 and attempt + 1 < RELAY_TRIES:
                # The registry takes one push a second from a host, and news can come in bunches.
                time.sleep(RELAY_RETRY_SECONDS)
                continue
            # 503: the site has no Firebase key. Not worth a retry.
            logger.warning("memento: the registry wouldn't push (%s)", error)
            return
    if isinstance(answer, dict) and not answer.get("sent") and answer.get("failed"):
        logger.warning("memento: the registry couldn't deliver the push (%s)", answer)


def reachable(path: Path) -> bool:
    """Whether any device could be told: a browser subscription, or a link to the registry."""
    return bool(_rows(path)) or _linked(path)


def _linked(path: Path) -> bool:
    state = link.load_state(path.parent.parent)
    return bool(state.get("token") and not state.get("revoked") and state.get("site"))


def _deliver(path: Path, kind: str, session_id: str) -> None:
    # At most 32 characters of base64url, and distinct per session however long its id is.
    topic = _b64(hashlib.sha256(f"{kind}:{session_id}".encode()).digest()[:18])
    payload = {"kind": kind, "session_id": session_id}
    for row in _rows(path):
        if _on_screen(path, row["device"]) or not wants(row, kind):
            continue
        status = send(row, payload, topic)
        if status in (404, 410):
            # The browser dropped the subscription (or the user revoked it).
            unsubscribe(path, row["endpoint"])
        elif status is None or status >= 300:
            logger.debug("memento: push to %s answered %s", urllib.parse.urlsplit(row["endpoint"]).netloc, status)
    _relay(path, kind, session_id)


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


def notify(kind: str, session_id: Optional[str], path: Optional[Path] = None) -> None:
    """Something a device should hear about. ``session_id`` is the session it is about, or for the
    kinds that aren't about one the routine's job id (``routine_failed``) or the project's id
    (``clone_failed``); it only picks what a tap opens. Never raises: it runs inside Hermes's hooks."""
    try:
        if kind not in KINDS or not session_id:
            return
        if path is None:
            # Hooks run inside the turn's profile scope, so this is that profile's home.
            from hermes_constants import get_hermes_home

            path = db_path(Path(get_hermes_home()))
        now = time.monotonic()
        key = (str(path), kind, session_id)
        with _lock:
            if now - _last.get(key, -THROTTLE_SECONDS) < THROTTLE_SECONDS:
                return
            _last[key] = now
            if len(_last) > 512:
                _last.clear()
        if not reachable(path):
            return
        threading.Thread(
            target=_run, args=(path, kind, session_id), name="memento-push", daemon=True
        ).start()
    except Exception:
        logger.debug("memento: couldn't send a push", exc_info=True)


def _run(path: Path, kind: str, session_id: str) -> None:
    try:
        _deliver(path, kind, session_id)
    except Exception:
        logger.debug("memento: a push failed", exc_info=True)
