"""The phones this bot knows, by a key each one holds and cannot give away.

A link the relay carries — a tray Reply, an approval's buttons drawn on Android — travels through the
Gots registry and Firebase Cloud Messaging as a data message, and FCM encrypts each hop with TLS and
nothing more, so whoever relays the push can read the link. A bearer link alone would let them press
it. So a link minted for the relay is ``signed`` (``answers.issue``): a press redeems it only with a
signature from a key this file holds (ADR 0167).

Each phone makes its key pair in its Android Keystore (``NoticeKey.kt``), where the private half
can't be read out, and hands the public half here itself, over the bot's own key (``POST push/key``)
— never through the registry, which could otherwise swap in its own. A press names the key by its id
(the SHA-256 of its DER) and signs ``message()``: the purpose, the token and the text, so a signature
made for one press answers no other. The token is one-shot, which is what keeps a signature from being
replayed.

Only P-256 keys are taken, which is what the Keystore makes and what the signature is checked under.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import re
from pathlib import Path
from typing import Any, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .store import connect, now_ms

# What a press's signature covers is opened by this, so a signature made for anything else the phone
# might ever sign can't stand for a press. Held equal to `NoticeKey.kt`'s by a test.
CONTEXT = "gots-notice-v1"
# The two purposes a signed link has: a tray Reply, and an approval's button.
REPLY = "reply"
ANSWER = "answer"
PURPOSES = (REPLY, ANSWER)
# The device id the app names its phone by (`Settings.fcm.device`).
DEVICE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
KEY_ID = re.compile(r"^[0-9a-f]{64}$")
# A profile's phones: more than any one person holds, few enough that a store can't be filled.
MAX_KEYS = 20
# A DER P-256 public key is 91 bytes; a DER P-256 signature is at most 72.
MAX_KEY_BYTES = 256
MAX_SIGNATURE_BYTES = 128


class DeviceKeyError(Exception):
    """A key this bot won't hold, in words the route can answer with."""


def _decode(value: Any, limit: int) -> Optional[bytes]:
    if not isinstance(value, str) or not value or len(value) > limit * 2:
        return None
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (binascii.Error, ValueError):
        return None


def key_id(der: bytes) -> str:
    """What a press names a key by: the SHA-256 of its DER, in hex."""
    return hashlib.sha256(der).hexdigest()


def message(purpose: str, token: str, text: str = "") -> bytes:
    """What a press signs: the context, the purpose, the token and the reply's text, one per line."""
    return f"{CONTEXT}\n{purpose}\n{token}\n{text}".encode("utf-8")


def register(path: Path, device: Any, key: Any) -> str:
    """Keeps one phone's public key, answering its id. A device's new key replaces its old one."""
    if not isinstance(device, str) or not DEVICE.match(device):
        raise DeviceKeyError("Not a device")
    der = _decode(key, MAX_KEY_BYTES)
    if der is None or len(der) > MAX_KEY_BYTES:
        raise DeviceKeyError("Not a key")
    try:
        public = serialization.load_der_public_key(der)
    except (ValueError, TypeError):
        raise DeviceKeyError("Not a key") from None
    if not isinstance(public, ec.EllipticCurvePublicKey) or not isinstance(public.curve, ec.SECP256R1):
        raise DeviceKeyError("Only a P-256 key is taken")
    found = key_id(der)
    conn = connect(path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        # A key moving to another device id (a reinstall that kept its Keystore) leaves its old row.
        conn.execute("DELETE FROM device_keys WHERE key_id = ? AND device != ?", (found, device))
        conn.execute(
            "INSERT INTO device_keys (device, key_id, key, at) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(device) DO UPDATE SET key_id = excluded.key_id, key = excluded.key,"
            " at = excluded.at",
            (device, found, der, now_ms()),
        )
        # The oldest phones go first once a profile holds more than any person has.
        conn.execute(
            "DELETE FROM device_keys WHERE device NOT IN"
            " (SELECT device FROM device_keys ORDER BY at DESC LIMIT ?)",
            (MAX_KEYS,),
        )
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()
    return found


def remove(path: Path, device: Any) -> None:
    """Forgets one phone: its presses are refused from now on."""
    if not isinstance(device, str) or not path.exists():
        return
    conn = connect(path)
    try:
        conn.execute("DELETE FROM device_keys WHERE device = ?", (device,))
    finally:
        conn.close()


def held(path: Path) -> bool:
    """Whether any phone could sign a press: without one, the relay is minted no link at all."""
    if not path.exists():
        return False
    conn = connect(path)
    try:
        return conn.execute("SELECT 1 FROM device_keys LIMIT 1").fetchone() is not None
    finally:
        conn.close()


def verify(path: Path, named: Any, signature: Any, purpose: str, token: str, text: str = "") -> bool:
    """Whether a press carries a signature over ``message()`` from the key it names.

    False for anything short of that — no key named, a key this profile doesn't hold, a signature
    that doesn't decode or doesn't check — so a caller has one answer to refuse on.
    """
    if purpose not in PURPOSES or not isinstance(named, str) or not KEY_ID.match(named):
        return False
    raw = _decode(signature, MAX_SIGNATURE_BYTES)
    if raw is None or not path.exists():
        return False
    conn = connect(path)
    try:
        row = conn.execute("SELECT key FROM device_keys WHERE key_id = ?", (named,)).fetchone()
    finally:
        conn.close()
    if row is None:
        return False
    try:
        public = serialization.load_der_public_key(bytes(row[0]))
        if not isinstance(public, ec.EllipticCurvePublicKey):
            return False
        public.verify(raw, message(purpose, token, text), ec.ECDSA(hashes.SHA256()))
    except (InvalidSignature, ValueError, TypeError):
        return False
    return True
