"""The charm's firmware as GitHub Packages publishes it: which version ``latest`` holds, and its bytes.

ghcr.io is a registry rather than an API, and it answers 401 to a plain GET: a reader asks its token
service for a pull token first (``/token?scope=repository:<path>:pull&service=ghcr.io``), sends that
as a bearer, then reads the tag's OCI manifest and the blob its layer names. The token service takes
the GitHub token this host already holds as the *password* of a Basic login — a bearer there is
refused — so a server whose token lacks ``read:packages`` is refused at the first request, and the
sentence says which scope to add rather than failing as a bare 502.

The image itself carries its version, byte count and SHA-256 as manifest annotations, written by the
firmware's release; a manifest without them is a package nobody's build wrote the way this reader was
told to expect, so that too is said in words the row can draw.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from . import github

logger = logging.getLogger(__name__)

REGISTRY = "https://ghcr.io"
# The package holding the firmware image (``owner/repo/firmware``): a fork or a second deployment
# names its own rather than reading the one this repository publishes.
DEFAULT_IMAGE = "thehaseebahmed/hermesgots-charm/firmware"
IMAGE_ENV = "GOTS_CHARM_FIRMWARE_IMAGE"
TAG = "latest"
MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json"

# The annotations the release writes onto the tag's manifest, and the name each is said by here.
VERSION_ANNOTATION = "org.opencontainers.image.version"
SHA256_ANNOTATION = "dev.gots.charm.sha256"
SIZE_ANNOTATION = "dev.gots.charm.size"
ANNOTATIONS = (
    ("version", VERSION_ANNOTATION, "version"),
    ("sha256", SHA256_ANNOTATION, "SHA-256"),
    ("size", SIZE_ANNOTATION, "size"),
)
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")

# A manifest is a few hundred bytes; an image is a megabyte and a half, and a slow server may take
# its time over the blob without the small reads ever waiting that long.
READ_TIMEOUT_S = 15.0
IMAGE_TIMEOUT_S = 120.0


class FirmwareError(Exception):
    """The package couldn't be read, or what it holds isn't something the app can be handed.

    ``status`` is what this plugin answers for it. A missing package is deliberately not a 404: the
    app reads that as a plugin that isn't installed, so GitHub's own 404 is answered here as a 409 in
    words the row draws. ``code`` keeps the status ghcr.io answered where there was one.
    """

    def __init__(self, message: str, status: int = 502, code: Optional[int] = None):
        super().__init__(message)
        self.status = status
        self.code = code


def image_path() -> str:
    """The registry path this host reads firmware from: its own, or the one this repo publishes."""
    named = os.environ.get(IMAGE_ENV, "").strip() or DEFAULT_IMAGE
    return named.removeprefix("ghcr.io/").strip("/")


def token_url() -> str:
    """The token service's ask for a pull token over this one package."""
    query = urllib.parse.urlencode({"scope": f"repository:{image_path()}:pull", "service": "ghcr.io"})
    return f"{REGISTRY}/token?{query}"


def manifest_url(tag: str = TAG) -> str:
    return f"{REGISTRY}/v2/{image_path()}/manifests/{tag}"


def blob_url(digest: str) -> str:
    return f"{REGISTRY}/v2/{image_path()}/blobs/{digest}"


def refusal(code: int) -> str:
    """What a registry status means to a person, in the row's own words.

    401 and 403 are the same thing here — GitHub Packages answers DENIED to a token that can't read
    packages, and to one it doesn't recognise — so both name the scope that fixes it.
    """
    if code in (401, 403):
        return (
            "GitHub refused this server's token for the charm firmware. The token needs the "
            "read:packages scope."
        )
    if code == 404:
        return "No charm firmware has been published yet."
    return f"GitHub Packages answered {code}."


def status_for(code: int) -> int:
    """The status this plugin answers a registry status with."""
    if code in (401, 403):
        return 403
    if code == 404:
        return 409
    return 502


def describe(manifest: Any) -> Dict[str, Any]:
    """The version, byte count and SHA-256 a tag's manifest carries, or the refusal saying which is
    missing. They are annotations rather than fields, so a manifest that has none is answered in
    words — never as a zero size or an empty version the app would compare against."""
    found = manifest.get("annotations") if isinstance(manifest, dict) else None
    found = found if isinstance(found, dict) else {}
    said: Dict[str, str] = {}
    for key, annotation, name in ANNOTATIONS:
        value = found.get(annotation)
        if not isinstance(value, str) or not value.strip():
            raise FirmwareError(f"The published charm firmware doesn't say its {name}.")
        said[key] = value.strip()
    if not VERSION_RE.match(said["version"]):
        raise FirmwareError(
            "The published charm firmware's version isn't three numbers separated by dots."
        )
    if not DIGEST_RE.match(said["sha256"]):
        raise FirmwareError("The published charm firmware's SHA-256 isn't a lowercase hex digest.")
    try:
        size = int(said["size"])
    except ValueError:
        raise FirmwareError("The published charm firmware's size isn't a byte count.") from None
    if size <= 0:
        raise FirmwareError("The published charm firmware's size isn't a byte count.")
    return {"version": said["version"], "size": size, "sha256": said["sha256"]}


def image_layer(manifest: Any) -> str:
    """The digest of the one layer holding the image."""
    layers = manifest.get("layers") if isinstance(manifest, dict) else None
    first = layers[0] if isinstance(layers, list) and layers else None
    digest = first.get("digest") if isinstance(first, dict) else None
    if not isinstance(digest, str) or not digest:
        raise FirmwareError("The published charm firmware names no image to send.")
    return digest


class RegistryRedirect(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only within the registry: a pull token is ghcr.io's and goes nowhere else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(newurl).hostname != urllib.parse.urlsplit(REGISTRY).hostname:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(RegistryRedirect())


def _open(request: urllib.request.Request, timeout: float):
    """One GET through the registry's one door, so a redirect cannot carry the bearer elsewhere."""
    return _OPENER.open(request, timeout=timeout)


def _fetch(url: str, headers: Dict[str, str], timeout: float = READ_TIMEOUT_S) -> Tuple[bytes, Dict[str, str]]:
    """One GET against ghcr.io: its bytes and its headers, or the sentence its status is said in."""
    request = urllib.request.Request(
        url, headers={"User-Agent": "gots-hermes-plugin", **headers}, method="GET"
    )
    try:
        with _open(request, timeout) as response:
            return response.read(), dict(response.headers)
    except urllib.error.HTTPError as error:
        raise FirmwareError(refusal(error.code), status_for(error.code), error.code) from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        logger.warning("gots: couldn't reach GitHub Packages", exc_info=True)
        raise FirmwareError("Couldn't reach GitHub Packages from the server.") from None


def _pull_token(hermes_home: Path) -> str:
    """A pull token for this package, asked for with the GitHub token this host holds.

    The username is the constant ``x-access-token`` because the token service checks the password
    alone; asking GitHub who the token belongs to first would be a request the answer never needs.
    """
    value, _ = github.token(hermes_home)
    if not value:
        raise FirmwareError("No GitHub account on the server.", 409)
    login = base64.b64encode(f"x-access-token:{value}".encode()).decode()
    raw, _ = _fetch(token_url(), {"Authorization": f"Basic {login}"})
    try:
        answer = json.loads(raw)
    except ValueError:
        answer = None
    for key in ("token", "access_token"):
        held = answer.get(key) if isinstance(answer, dict) else None
        if isinstance(held, str) and held:
            return held
    raise FirmwareError("GitHub Packages didn't answer with a token.")


def _manifest(token: str, tag: str = TAG) -> Dict[str, Any]:
    raw, _ = _fetch(manifest_url(tag), {"Authorization": f"Bearer {token}", "Accept": MANIFEST_MEDIA_TYPE})
    try:
        found = json.loads(raw)
    except ValueError:
        found = None
    if not isinstance(found, dict):
        raise FirmwareError("GitHub Packages didn't answer with a manifest.")
    return found


def latest(hermes_home: Path) -> Dict[str, Any]:
    """``{version, size, sha256}`` of the firmware ``latest`` holds — what the app's row draws."""
    return describe(_manifest(_pull_token(hermes_home)))


def image(hermes_home: Path) -> Dict[str, Any]:
    """The image's bytes and what the manifest says about them, for the phone to send to the charm.

    The tag is resolved again here rather than remembered, so the bytes a device downloads are
    always the ones the version it just read names, even when a merge published in between.
    """
    token = _pull_token(hermes_home)
    manifest = _manifest(token)
    described = describe(manifest)
    data, headers = _fetch(
        blob_url(image_layer(manifest)), {"Authorization": f"Bearer {token}"}, timeout=IMAGE_TIMEOUT_S
    )
    return {
        "data": data,
        "type": headers.get("Content-Type") or "application/octet-stream",
        **described,
    }
