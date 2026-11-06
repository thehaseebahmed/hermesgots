"""One dotted key of a profile's ``config.yaml``: read the way Hermes reads it, written the way it writes.

Two pages edit keys of the bot's own Hermes — Speech-to-text its ``stt`` section, General the keys the
Dashboard's General tab holds — and they ask the same four questions: what does Hermes default this key
to, how is a nested section flattened into dot paths, how is the file read, and what shape does a value
have to be before it is written. The answers live here once, so a change to how a value is checked is one
edit rather than two that drift apart.

The imports of Hermes's own modules stay inside the functions that use them, as everywhere in this
plugin: a host without them answers 501 instead of failing to import the plugin.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Iterator, Optional, Tuple

logger = logging.getLogger(__name__)


def defaults() -> Dict[str, Any]:
    """Hermes's own default for every key, as the flat ``DEFAULT_CONFIG`` Hermes ships.

    Read per call, never cached: a test, or a second host in the same process, installs its own.
    """
    from hermes_cli.config_defaults import DEFAULT_CONFIG

    return DEFAULT_CONFIG if isinstance(DEFAULT_CONFIG, dict) else {}


def walk(node: Any, prefix: str = "") -> Iterator[Tuple[str, Any]]:
    """Every leaf of a nested mapping, as ``(dot.path, value)``, in the file's own order."""
    if not isinstance(node, dict):
        return
    for key, value in node.items():
        path = f"{prefix}.{key}" if prefix else str(key)
        if path == "_config_version":
            continue
        if isinstance(value, dict):
            yield from walk(value, path)
            continue
        yield path, value


def load(config_path: Path, *, strict: bool = False) -> Dict[str, Any]:
    """The profile's ``config.yaml`` as Hermes reads it — managed overlay, env, model canon.

    ``strict`` raises where the file can't be read, which is what a page that must not draw Hermes's
    defaults over a file it never saw asks for; otherwise a failed read is an empty mapping.
    """
    try:
        from gateway.run import _load_gateway_config

        cfg = _load_gateway_config(config_path=config_path)
    except Exception:
        if strict:
            raise
        logger.debug("gots: couldn't read the host's config", exc_info=True)
        return {}
    return cfg if isinstance(cfg, dict) else {}


def is_scalar(value: Any) -> bool:
    """A value that is one value: what a single row can show and write back."""
    return isinstance(value, (bool, int, float, str)) or value is None


def is_scalar_list(value: Any) -> bool:
    """A list of scalars — a comma list on a row — rather than a list of objects another page owns."""
    return isinstance(value, list) and all(
        isinstance(one, (str, int, float)) and not isinstance(one, bool) for one in value
    )


def kind_of(sample: Any) -> Optional[str]:
    """The kind a value's own Python type draws as: a switch, a number or text."""
    if isinstance(sample, bool):
        return "boolean"
    if isinstance(sample, (int, float)):
        return "number"
    if isinstance(sample, str):
        return "string"
    return None


def coerce(key: str, kind: Optional[str], value: Any, options: Optional[list] = None) -> Any:
    """``value`` as the key's own kind takes it, or ValueError naming what went wrong.

    Every refusal is a sentence the page shows as it stands, so it names the key by the name the reader
    saw on the row and says what that key takes.
    """
    if kind == "boolean":
        if not isinstance(value, bool):
            raise ValueError(f"{key} is a switch, so its value is true or false.")
        return value
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{key} takes a number.")
        return value
    if kind == "select":
        choices = [str(one) for one in (options or [""])]
        if not isinstance(value, str) or value not in choices:
            raise ValueError(f"{key} takes one of {', '.join(choices)}.")
        return value
    if kind == "list":
        if not isinstance(value, list) or not all(isinstance(one, str) for one in value):
            raise ValueError(f"{key} takes a list of values.")
        return [one.strip() for one in value if one.strip()]
    if kind in (None, "string"):
        if not isinstance(value, str):
            raise ValueError(f"{key} takes text.")
        return value
    raise ValueError(f"{key} isn't a setting this page can write.")


def write(config_path: Path, path: str, value: Any) -> None:
    """Writes one dotted path through Hermes's round-trip writer; ``None`` removes the key.

    Comments, the file's order and every key the page doesn't model survive, which is why this is the
    one writer both pages use rather than a YAML load and dump.
    """
    from utils import atomic_roundtrip_yaml_update

    atomic_roundtrip_yaml_update(config_path, path, value)
