"""Links a Hermes profile to a Memento account, so it shows up in the app as a bot by itself.

``hermes memento link <code> --site <app URL>`` claims a link code the app minted, which gives this
profile a host token. The profile's bot record (name, URL, API key) is sealed to the account's inbox
key before it leaves (ECIES on P-256, the same scheme as ``openFromInbox`` in the app's ``vault.ts``),
so the registry passes it along without being able to read it. The gateway then re-publishes the
record when it changes and checks in every 10 minutes (``run``). Everything is best effort: a
registry that can't be reached only means the app's copy is a little stale.

State lives in ``$HERMES_HOME/memento/link.json`` (0600), per profile.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import socket
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

HEARTBEAT_SECONDS = 600
TIMEOUT_SECONDS = 15
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE = re.compile(r"^MK_([0-9A-Z]{8})-([0-9A-Z]{16})-([0-9A-Z]{13})$")
INFO = b"memento-inbox-v1"
DEFAULT_PORT = 8642


class LinkError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


# Codes and keys


def to_base32(data: bytes, length: int | None = None) -> str:
    """Crockford base32, most significant bit first, like ``toBase32`` in the app."""
    length = length if length is not None else -(-len(data) * 8 // 5)
    bits = value = 0
    out = ""
    for byte in data:
        value = ((value << 8) | byte) & 0xFFFF
        bits += 8
        while bits >= 5 and len(out) < length:
            out += CROCKFORD[(value >> (bits - 5)) & 31]
            bits -= 5
    if bits > 0 and len(out) < length:
        out += CROCKFORD[(value << (5 - bits)) & 31]
    return out


def parse_code(code: str) -> Tuple[str, str, str]:
    """``(code_id, secret, fingerprint)`` from a link code, however it was copied."""
    normalized = code.strip().upper().replace("O", "0").replace("I", "1").replace("L", "1")
    match = CODE.match(normalized)
    if not match:
        raise LinkError("That isn't a Memento link code. Copy the command from the app again.")
    return match.group(1), match.group(2), match.group(3)


def fingerprint(public_key: str) -> bytes:
    return hashlib.sha256(base64.b64decode(public_key)).digest()[:8]


def seal(public_key: str, value: Any, aad: str) -> Dict[str, Any]:
    """Seals ``value`` so only the holder of the inbox's private key can open it."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    recipient = serialization.load_der_public_key(base64.b64decode(public_key))
    if not isinstance(recipient, ec.EllipticCurvePublicKey) or recipient.curve.name != "secp256r1":
        raise LinkError("The account's inbox key isn't a P-256 key.")
    ephemeral = ec.generate_private_key(ec.SECP256R1())
    shared = ephemeral.exchange(ec.ECDH(), recipient)
    epk = ephemeral.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=epk, info=INFO).derive(shared)
    iv = os.urandom(12)
    plain = json.dumps(value, separators=(",", ":")).encode()
    ct = AESGCM(key).encrypt(iv, plain, aad.encode())
    b64 = lambda raw: base64.b64encode(raw).decode()  # noqa: E731
    return {"v": 1, "epk": b64(epk), "iv": b64(iv), "ct": b64(ct)}


# The registry


def call(
    site: str,
    method: str,
    route: str,
    *,
    token: str | None = None,
    body: Any = None,
    bot_id: str | None = None,
) -> Any:
    query = f"route={route}" + (f"&id={bot_id}" if bot_id else "")
    request = urllib.request.Request(
        f"{site.rstrip('/')}/.netlify/functions/registry?{query}",
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "memento-plugin",
            **({"Authorization": f"Bearer {token}"} if token else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            raw = response.read()
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read() or b"{}").get("error")
        except ValueError:
            message = None
        raise LinkError(message or f"Memento answered {error.code}", error.code) from None
    except (urllib.error.URLError, OSError) as error:
        raise LinkError(f"Couldn't reach Memento at {site}: {error}") from None
    return json.loads(raw) if raw else None


# State and the profile


def state_path(home: Path) -> Path:
    return home / "memento" / "link.json"


def load_state(home: Path) -> Dict[str, Any]:
    try:
        value = json.loads(state_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def save_state(home: Path, state: Dict[str, Any]) -> None:
    path = state_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    # The host token is a credential: owner-only from the first byte.
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2)
    os.replace(temp, path)


def profile_name(home: Path) -> str:
    return home.name if home.parent.name == "profiles" else "default"


def root_home(home: Path) -> Path:
    return home.parent.parent if home.parent.name == "profiles" else home


def read_env(home: Path) -> Dict[str, str]:
    """The profile's ``.env``, read directly so it works for any home, not just the active one."""
    values: Dict[str, str] = {}
    try:
        lines = (home / ".env").read_text(encoding="utf-8").splitlines()
    except OSError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.removeprefix("export ").partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def env_value(home: Path, key: str, *, process: bool = False) -> str:
    value = read_env(home).get(key, "")
    if not value and process:
        value = os.environ.get(key, "")
    return value


def bot_id(state: Dict[str, Any], profile: str) -> str:
    return hashlib.sha256(f"{state['hostId']}:{profile}".encode()).hexdigest()[:16]


def record(home: Path, state: Dict[str, Any], *, process_env: bool) -> Dict[str, Any] | None:
    """What the app needs to talk to this profile, or None when it has no URL or key yet."""
    from . import VERSION

    profile = profile_name(home)
    api_key = env_value(home, "API_SERVER_KEY", process=process_env)
    url = state.get("url")
    if not api_key or not url:
        return None
    return {
        "name": "Hermes" if profile == "default" else profile,
        "profile": profile,
        "baseUrl": url,
        "apiKey": api_key,
        "pluginVersion": VERSION,
    }


def digest(value: Any, key_id: str) -> str:
    return hashlib.sha256(json.dumps([value, key_id], sort_keys=True).encode()).hexdigest()


def publish(home: Path, state: Dict[str, Any], *, process_env: bool, force: bool = False) -> bool:
    """Seals and uploads the bot record when it changed since the last upload. True when sent."""
    value = record(home, state, process_env=process_env)
    if value is None:
        return False
    inbox = state["inbox"]
    current = digest(value, inbox["keyId"])
    if not force and state.get("published") == current:
        return False
    bot = bot_id(state, value["profile"])
    sealed = seal(inbox["publicKey"], value, f"memento:{state['userId']}:bot:{bot}")
    call(
        state["site"],
        "PUT",
        "bots",
        token=state["token"],
        bot_id=bot,
        body={"keyId": inbox["keyId"], "sealed": sealed},
    )
    state["published"] = current
    state["botId"] = bot
    save_state(home, state)
    return True


def check_in(home: Path, *, process_env: bool) -> Optional[str]:
    """One heartbeat for a linked profile: re-seal after an inbox change, re-publish what changed or
    went missing. Returns a short status, or None when the profile isn't linked."""
    state = load_state(home)
    if not state.get("token") or state.get("revoked"):
        return None
    try:
        publish(home, state, process_env=process_env)
        bot = state.get("botId")
        if not bot:
            return "no URL or API key yet"
        from . import VERSION

        answer = call(
            state["site"],
            "POST",
            "seen",
            token=state["token"],
            body={"bots": [bot], "pluginVersion": VERSION},
        )
        key_id = answer.get("keyId")
        if key_id and key_id != state["inbox"]["keyId"]:
            # The account reset its vault; its devices can only open records sealed to the new key.
            fresh = call(state["site"], "GET", "inbox", token=state["token"])
            state["inbox"] = fresh["inbox"]
            save_state(home, state)
            publish(home, state, process_env=process_env, force=True)
        elif (answer.get("bots") or {}).get(bot) is None:
            publish(home, state, process_env=process_env, force=True)
        return "linked"
    except LinkError as error:
        if error.status == 401:
            # Removed from the account in the app: stop until linked again.
            state["revoked"] = True
            save_state(home, state)
            return "removed in Memento"
        logger.debug("memento: check-in failed for %s: %s", home, error)
        return str(error)


def served_homes(adapter: Any) -> List[Path]:
    from hermes_constants import get_hermes_home

    homes = [Path(get_hermes_home())]
    config = getattr(getattr(adapter, "gateway_runner", None), "config", None)
    if getattr(config, "multiplex_profiles", False):
        try:
            from hermes_cli.profiles import profiles_to_serve

            homes += [Path(home) for _, home in profiles_to_serve(multiplex=True)]
        except Exception:
            logger.debug("memento: couldn't list served profiles", exc_info=True)
    seen: set[Path] = set()
    return [home for home in homes if not (home.resolve() in seen or seen.add(home.resolve()))]


async def run(adapter: Any) -> None:
    """The gateway's check-in loop: at start, then every 10 minutes."""
    while True:
        homes = served_homes(adapter)
        first = homes[0] if homes else None
        for home in homes:
            try:
                # Only the process's own profile may fall back to the process environment.
                await asyncio.to_thread(check_in, home, process_env=home == first)
            except Exception:
                logger.debug("memento: check-in crashed for %s", home, exc_info=True)
        await asyncio.sleep(HEARTBEAT_SECONDS)


# The CLI


def _ask(question: str, default: str, assume: bool) -> str:
    if assume:
        return default
    try:
        answer = input(f"{question} [{default}]: ").strip()
    except EOFError:
        return default
    return answer or default


def _confirm(question: str, assume: bool) -> bool:
    if assume:
        return True
    try:
        return input(f"{question} [Y/n]: ").strip().lower() in ("", "y", "yes")
    except EOFError:
        return False


def default_url(home: Path, state: Dict[str, Any]) -> str:
    """Saved URL, else the dashboard's public URL (Hermes has none for the API server), else the
    host and port. A profile served by the main gateway sits under ``/p/<name>`` of its URL."""
    if state.get("url"):
        return state["url"]
    profile = profile_name(home)
    root = root_home(home)
    if profile != "default":
        main = load_state(root).get("url") or ""
        if main:
            return f"{main.rstrip('/')}/p/{profile}"
    public = ""
    try:
        from hermes_cli.dashboard_auth.prefix import resolve_public_url

        public = resolve_public_url()
    except Exception:
        public = env_value(home, "HERMES_DASHBOARD_PUBLIC_URL", process=True)
    if public:
        return public.rstrip("/")
    port = env_value(home, "API_SERVER_PORT", process=True) or str(DEFAULT_PORT)
    return f"http://{socket.gethostname()}:{port}"


def _set_env(home: Path, key: str, value: str) -> None:
    try:
        from hermes_cli.config import get_env_path, save_env_value

        if Path(get_env_path()).resolve() == (home / ".env").resolve():
            save_env_value(key, value)
            return
    except Exception:
        pass
    path = home / ".env"
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    pattern = re.compile(rf"^\s*(export\s+)?{re.escape(key)}=")
    lines = [line for line in lines if not pattern.match(line)] + [f"{key}={value}"]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def env_changes(home: Path, url: str, origins: List[str]) -> Dict[str, str]:
    """Lines the profile's ``.env`` still needs for Memento to reach it at ``url``."""
    env = read_env(home)
    changes: Dict[str, str] = {}
    if not env.get("API_SERVER_KEY") and not os.environ.get("API_SERVER_KEY"):
        changes["API_SERVER_KEY"] = os.urandom(32).hex()
    # A profile behind the main gateway's /p/<name> rides that gateway's server and CORS.
    if f"/p/{profile_name(home)}" in url:
        return changes
    if env.get("API_SERVER_ENABLED", "").lower() not in ("true", "1", "yes"):
        changes["API_SERVER_ENABLED"] = "true"
    current = [o.strip() for o in env.get("API_SERVER_CORS_ORIGINS", "").split(",") if o.strip()]
    if "*" not in current:
        missing = [origin for origin in origins if origin not in current]
        if missing:
            changes["API_SERVER_CORS_ORIGINS"] = ",".join(current + missing)
    return changes


def is_linked(state: Dict[str, Any]) -> bool:
    """Linked, and the registry still knows this host's token."""
    if not state.get("token") or state.get("revoked"):
        return False
    try:
        call(state["site"], "GET", "inbox", token=state["token"])
    except LinkError as error:
        if error.status != 401:
            raise
        return False
    return True


def claim(home: Path, state: Dict[str, Any], code: str, site: str) -> Dict[str, Any]:
    """Claims a link code, checks the account's key against it and saves the host token."""
    code_id, secret, expected = parse_code(code)
    answer = call(site, "POST", "claim", body={"codeId": code_id, "secret": secret})
    inbox = answer["inbox"]
    # The code came from the app, not the registry: a registry that swapped in its own key would
    # get every API key sealed to it.
    if to_base32(fingerprint(inbox["publicKey"]), 13) != expected:
        try:
            call(site, "DELETE", "host", token=answer["token"])
        except LinkError:
            pass
        raise LinkError(
            "The account's key doesn't match the link code, so nothing was sent. "
            "Copy a new command from the app."
        )
    state = {
        "site": site,
        "userId": answer["userId"],
        "hostId": answer["hostId"],
        "token": answer["token"],
        "inbox": inbox,
        "origins": answer.get("origins") or [],
        **({"url": state["url"]} if state.get("url") else {}),
    }
    save_state(home, state)
    return state


def set_url(home: Path, state: Dict[str, Any], url: str) -> str:
    url = url.strip().rstrip("/")
    if not re.match(r"^https?://[^\s/]+", url):
        raise LinkError(f"{url} isn't an http(s) URL.")
    state["url"] = url
    save_state(home, state)
    return url


def apply_env(home: Path, changes: Dict[str, str]) -> None:
    for key, value in changes.items():
        _set_env(home, key, value)


def http_warning(url: str) -> Optional[str]:
    if url.startswith("http://") and not re.match(r"^http://(localhost|127\.|\[::1\])", url):
        return "A browser on https won't call an http:// URL. Use https (Tailscale, a tunnel or a proxy)."
    return None


def cmd_link(args: Any) -> int:
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home())
    state = load_state(home)
    site = (args.site or state.get("site") or "").rstrip("/")
    if not site:
        print("Add --site with the address you open Memento at, as the app's command does.")
        return 2
    assume = bool(args.yes)

    try:
        if is_linked(state):
            print("This profile is already linked. To link it to another account, run "
                  "`hermes memento unlink` first.")
        else:
            if not args.code:
                print("Paste the link code from Memento: hermes memento link <code> --site <url>")
                return 2
            state = claim(home, state, args.code, site)

        url = set_url(home, state, args.url or _ask(
            "The URL your phone reaches this profile's API server at", default_url(home, state), assume
        ))

        changes = env_changes(home, url, state.get("origins") or [])
        restart = False
        if changes:
            print(f"Memento needs these lines in {home / '.env'}:")
            for key, value in changes.items():
                print(f"  {key}={shown_env(key, value)}")
            if _confirm("Add them?", assume):
                apply_env(home, changes)
                restart = True
            else:
                print("Skipped. The app can't reach this profile until they're set.")

        if publish(home, state, process_env=True, force=True):
            # Checks in at once, so the app shows it online without waiting for the gateway.
            check_in(home, process_env=True)
            print(f"Linked {record(home, state, process_env=True)['name']}. It shows up in Memento now.")
        else:
            print("Linked, but this profile has no API_SERVER_KEY yet, so the app can't use it.")
        if restart:
            print("Restart the gateway to apply the .env changes: hermes gateway restart")
        warning = http_warning(url)
        if warning:
            print(f"Note: {warning}")
        return 0
    except LinkError as error:
        print(str(error))
        return 1


def shown_env(key: str, value: str) -> str:
    return value if key != "API_SERVER_KEY" else value[:6] + "…"


def unlink(home: Path) -> Optional[str]:
    """Drops the link, here and at the registry. Returns a problem worth showing, if any."""
    state = load_state(home)
    problem = None
    try:
        call(state["site"], "DELETE", "host", token=state["token"])
    except LinkError as error:
        if error.status != 401:
            problem = f"{error} The link is forgotten here anyway; remove the bot in Memento too."
    # The next link to another account reuses them as its defaults.
    save_state(home, {key: state[key] for key in ("site", "url") if state.get(key)})
    return problem


def cmd_unlink(args: Any) -> int:
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home())
    if not load_state(home).get("token"):
        print("This profile isn't linked.")
        return 0
    problem = unlink(home)
    if problem:
        print(problem)
    print("Unlinked. The bot is gone from Memento.")
    return 0


def cmd_status(args: Any) -> int:
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home())
    state = load_state(home)
    if not state.get("token"):
        print("Not linked. Copy the command from Memento's Link your bots screen.")
        return 1
    if state.get("revoked"):
        print("Removed in Memento. Link again with a new code.")
        return 1
    print(f"Profile {profile_name(home)} is linked to {state['site']}")
    print(f"URL: {state.get('url') or 'not set'}")
    result = check_in(home, process_env=True)
    print(f"Check-in: {result}")
    return 0 if result == "linked" else 1


def setup_cli(parser: Any) -> None:
    commands = parser.add_subparsers(dest="memento_command")
    link = commands.add_parser("link", help="Link this profile to your Memento account")
    link.add_argument("code", nargs="?", help="The link code from the app")
    link.add_argument("--site", help="The address you open Memento at")
    link.add_argument("--url", help="The URL the app reaches this profile's API server at")
    link.add_argument("--yes", "-y", action="store_true", help="Accept the defaults")
    link.set_defaults(func=cmd_link)
    unlink = commands.add_parser("unlink", help="Remove this profile from your Memento account")
    unlink.set_defaults(func=cmd_unlink)
    status = commands.add_parser("status", help="Show whether this profile is linked")
    status.set_defaults(func=cmd_status)
    parser.set_defaults(func=lambda args: (parser.print_help(), 2)[1])
