"""The host's speech model: what hears a dictation, and the model a dictation's cleanup runs on.

A dictation is heard on the host's own faster-whisper, and Hermes names that model in
``config.yaml``'s ``stt.local.model`` — a file only Hermes writes. The Dictation tab picks it from
the models this module lists, so a pick is that one key, written through Hermes's own round-trip
YAML writer: every other speech setting, and the rest of the file with its comments, stays. The
model a pick leaves in place is read on the next clip, never mid-clip, as a bot's vocabulary is.

Two things are kept beside it in the host's settings store, per bot:

- the model a finished dictation's cleanup runs on, where the host grants the plugin its
  model-override permission (``llm.model_override`` and ``llm.provider_override``; ADR 0036). It is
  read per request, so it survives a plugin restart, and it is dropped where the permission is not
  granted: cleanup then runs on the bot's own model.
- the last model that actually loaded. A pick Hermes can't load — a download that failed, a file
  the host can't read — falls back to that model rather than costing the user their dictation, and
  the failure is kept, once, for the app to show. A model that failed is never remembered as the one
  in play, so the fallback can't poison itself.

The catalogue is Hermes's local faster-whisper family with the size and the speed a pick is weighed
on. Nothing here loads a model: ``dictation.warm`` does, and this module decides what a failure
means.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from .store import get_setting, put_setting

logger = logging.getLogger(__name__)

# Hermes's own default when ``stt.local.model`` is unset.
DEFAULT_MODEL = "base"
CLEANUP_KEY = "speech_cleanup_model"
STT_KEY = "stt"

# What a pick is weighed on. ``speed`` is roughly how many seconds of speech the model hears in a
# second on a modern laptop CPU, so a model under 2 can't keep up with someone talking; ``size_mb``
# is the download. ``repo`` is the faster-whisper repository the name resolves to, which is how a
# downloaded model is found in the Hugging Face cache.
MODELS: Sequence[Dict[str, Any]] = (
    {"name": "tiny", "size_mb": 75, "speed": 32.0, "slow_on_cpu": False, "repo": "Systran/faster-whisper-tiny"},
    {"name": "base", "size_mb": 145, "speed": 16.0, "slow_on_cpu": False, "repo": "Systran/faster-whisper-base"},
    {"name": "small", "size_mb": 484, "speed": 6.0, "slow_on_cpu": False, "repo": "Systran/faster-whisper-small"},
    {"name": "distil-small.en", "size_mb": 332, "speed": 20.0, "slow_on_cpu": False, "repo": "Systran/faster-distil-whisper-small.en"},
    {"name": "distil-medium.en", "size_mb": 789, "speed": 8.0, "slow_on_cpu": False, "repo": "Systran/faster-distil-whisper-medium.en"},
    {"name": "distil-large-v3", "size_mb": 1510, "speed": 3.0, "slow_on_cpu": False, "repo": "Systran/faster-distil-whisper-large-v3"},
    {"name": "large-v3-turbo", "size_mb": 1620, "speed": 2.0, "slow_on_cpu": False, "repo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo"},
    {"name": "medium", "size_mb": 1530, "speed": 1.4, "slow_on_cpu": True, "repo": "Systran/faster-whisper-medium"},
    {"name": "large-v3", "size_mb": 3090, "speed": 0.6, "slow_on_cpu": True, "repo": "Systran/faster-whisper-large-v3"},
)

# Hermes resolves these two spellings of a model it knows.
ALIASES = {"large": "large-v3", "turbo": "large-v3-turbo"}

DENIED = "This host doesn't let Gots pick the model. Allow it with `hermes plugins enable memento`."


class Withheld(Exception):
    """The host doesn't grant the plugin the model-override permission (``research.llm_gate``)."""


def catalogue() -> List[Dict[str, Any]]:
    """The models a pick can be made from, without the download's own repository name."""
    return [{key: value for key, value in entry.items() if key != "repo"} for entry in MODELS]


def names() -> List[str]:
    return [str(entry["name"]) for entry in MODELS]


def _entry(name: str) -> Optional[Dict[str, Any]]:
    for entry in MODELS:
        if entry["name"] == name:
            return entry
    return None


def clean_model(value: Any) -> str:
    """A model name as this host spells it, or ValueError saying which one it can't hear.

    A name Hermes resolves from a spelling it knows (``large``) is kept as the model it means, so
    the file never holds two names for one download.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Name a speech model.")
    name = ALIASES.get(value.strip().lower(), value.strip().lower())
    if _entry(name) is None:
        raise ValueError(f"{value.strip()} isn't a speech model this host can use.")
    return name


def _stt(config_path: Path, strict: bool = False) -> Dict[str, Any]:
    """The ``stt`` section of the profile's ``config.yaml``, as Hermes reads it."""
    try:
        from gateway.run import _load_gateway_config

        cfg = _load_gateway_config(config_path=config_path) or {}
    except Exception:
        if strict:
            raise
        logger.debug("memento: couldn't read the host's speech settings", exc_info=True)
        return {}
    section = cfg.get(STT_KEY) if isinstance(cfg, dict) else None
    return section if isinstance(section, dict) else {}


def _write_stt(config_path: Path, section: Dict[str, Any]) -> None:
    """Writes the whole ``stt`` section back, as ``hermes`` would: one pass, comments kept."""
    from utils import atomic_roundtrip_yaml_update

    atomic_roundtrip_yaml_update(config_path, STT_KEY, section)


def _model_of(stt: Dict[str, Any]) -> str:
    local = stt.get("local") if isinstance(stt.get("local"), dict) else {}
    name = local.get("model") if isinstance(local, dict) else None
    return name.strip() if isinstance(name, str) and name.strip() else DEFAULT_MODEL


def cache_roots(stt: Dict[str, Any]) -> List[Path]:
    """Where a speech model would be on disk: Hermes's ``download_root`` first, then the HF cache."""
    roots: List[Path] = []
    local = stt.get("local") if isinstance(stt.get("local"), dict) else {}
    configured = local.get("download_root") if isinstance(local, dict) else None
    if isinstance(configured, str) and configured.strip():
        roots.append(Path(configured).expanduser())
    try:
        from huggingface_hub.constants import HF_HUB_CACHE

        roots.append(Path(HF_HUB_CACHE))
    except Exception:
        home = os.environ.get("HF_HOME")
        roots.append(
            Path(home).expanduser() / "hub" if home else Path.home() / ".cache/huggingface/hub"
        )
    return roots


def downloaded(entry: Dict[str, Any], roots: Sequence[Path]) -> bool:
    """Whether this model is already on the host, so a take on it doesn't wait for a download."""
    repo = str(entry.get("repo") or "")
    folders = [f"models--{repo.replace('/', '--')}", str(entry["name"])]
    for root in roots:
        for folder in folders:
            if (root / folder).exists():
                return True
    return False


def read(config_path: Path, path: Path, gate: Dict[str, bool]) -> Dict[str, Any]:
    """The host's speech settings as the Dictation tab draws them: the pick, the list."""
    stt = _stt(config_path)
    model = _model_of(stt)
    roots = cache_roots(stt)
    rows: List[Dict[str, Any]] = []
    seen = False
    for entry in MODELS:
        here = entry["name"] == model
        seen = seen or here
        have = downloaded(entry, roots)
        rows.append(
            {
                "name": entry["name"],
                "size_mb": entry["size_mb"],
                "speed": entry["speed"],
                "slow_on_cpu": entry["slow_on_cpu"],
                "downloaded": have,
                "in_use": here,
                "downloading": here and not have,
            }
        )
    if not seen:
        rows.insert(
            0,
            {
                "name": model,
                "size_mb": None,
                "speed": None,
                "slow_on_cpu": False,
                "downloaded": False,
                "in_use": True,
                "downloading": False,
            },
        )
    return {
        "model": model,
        "models": rows,
        "cleanup": cleanup_state(path, gate),
    }


def set_model(config_path: Path, value: Any) -> str:
    """Makes ``value`` the host's speech model in ``config_path``, and answers the name it saved.

    ValueError names a model this host can't hear, before anything is written; a write Hermes
    refuses raises as it is, with the file untouched, so the model in place is still the old one.
    """
    name = clean_model(value)
    stt = _stt(config_path, strict=True)
    if _model_of(stt) == name:
        return name
    local = stt.get("local") if isinstance(stt.get("local"), dict) else {}
    section = {**stt, "local": {**local, "model": name}}
    _write_stt(config_path, section)
    return name


def read_cleanup(path: Path) -> Optional[Dict[str, str]]:
    """What a dictation's cleanup runs on, or None when it runs on the bot's own model."""
    held = get_setting(path, CLEANUP_KEY)
    if not isinstance(held, dict):
        return None
    provider, model = held.get("provider"), held.get("model")
    if isinstance(provider, str) and provider and isinstance(model, str) and model:
        return {"provider": provider, "model": model}
    return None


def cleanup_state(path: Path, gate: Dict[str, bool]) -> Dict[str, Any]:
    """The cleanup model as the tab draws it: the pick, whether the host allows one, and why not."""
    allowed = bool(gate.get("model") and gate.get("provider"))
    return {"model": read_cleanup(path), "allowed": allowed, "reason": None if allowed else DENIED}


def set_cleanup(
    path: Path,
    pick: Any,
    gate: Dict[str, bool],
    config_path: Optional[Path] = None,
) -> Optional[Dict[str, str]]:
    """Keeps ``pick`` as the model a dictation's cleanup runs on; None clears it.

    A pick overrides the model of a model call, which the host's config has to allow (``gate``,
    from ``research.llm_gate``): ``Withheld`` otherwise, and nothing is stored. Hermes checks a pick
    the bot doesn't already hold the way it checks its main model, and a refusal is a ValueError
    with its reason. A refused or withheld pick leaves whatever the bot had.
    """
    if pick is None:
        put_setting(path, CLEANUP_KEY, None)
        return None
    if not isinstance(pick, dict):
        raise ValueError("cleanup_model must be an object, or null to use the bot's own model")
    provider, model = pick.get("provider"), pick.get("model")
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError("The cleanup model needs a provider")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("The cleanup model needs a model")
    wanted = {"provider": provider.strip(), "model": model.strip()}
    held = get_setting(path, CLEANUP_KEY)
    if isinstance(held, dict) and wanted in (read_cleanup(path), held.get("asked")):
        return read_cleanup(path)
    if not (gate.get("model") and gate.get("provider")):
        raise Withheld(DENIED)
    resolved = wanted
    if config_path is not None:
        from . import host_model

        cfg = _main_config(config_path)
        routed = host_model.check_pick(cfg, wanted["provider"], wanted["model"])
        resolved = {"provider": routed.target_provider, "model": routed.new_model}
    put_setting(path, CLEANUP_KEY, {**resolved, "asked": wanted})
    return resolved


def applied_cleanup(path: Path, gate: Dict[str, bool]) -> Optional[Dict[str, str]]:
    """What a dictation's cleanup runs on: the pick where the host allows one, else None.

    Read per request, so a pick made while a dictation is running lands on the next one, and a
    permission taken back is honoured at once even though the pick is still stored.
    """
    if not (gate.get("model") and gate.get("provider")):
        return None
    return read_cleanup(path)


def _main_config(config_path: Path) -> Dict[str, Any]:
    from gateway.run import _load_gateway_config

    cfg = _load_gateway_config(config_path=config_path)
    return cfg if isinstance(cfg, dict) else {}

