"""The profile's main model, set from the Gots app.

Hermes's only route for it is the dashboard's ``POST /api/model/set``, which the app can't reach
(localhost only, a token that changes on every start). So the bot editor's Default model comes here,
and it goes through the same two calls as a messaging ``/model --global``: ``switch_model`` checks
the provider and model and resolves the route, and ``persist_model_selection`` writes only the
``model.*`` keys it changed, keeping the rest of ``config.yaml`` and its comments. The API server
reads ``config.yaml`` each time it builds an agent, so the next turn on every surface of the profile
runs it without a restart.

A bot's fallback models live here too — the up-to-two picks Gots records after its main model, under
``model.fallbacks`` in the same file, written one key at a time by Hermes's own writer. That key is
Gots's own record: Hermes's failover chain is the top-level ``fallback_providers`` and is left
untouched, so recording a fallback does not change what a turn does when a model request fails.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List

# Gots gives a bot a main model and up to two fallbacks after it.
MAX_FALLBACKS = 2
# Where a bot's fallback models are recorded, inside the profile's ``model:`` block. A single-key
# write, so the sibling keys a user keeps there (``model_slots``, ...) survive.
FALLBACK_KEY = "model.fallbacks"


def clean(body: Any) -> tuple[str, str]:
    """``(provider, model)`` from a request body, or ValueError."""
    if not isinstance(body, dict):
        raise ValueError("Body must be a JSON object")
    return _pair(body, "provider is required", "model is required")


def clean_fallbacks(body: Any) -> List[Dict[str, str]]:
    """``[{"provider", "model"}]`` from a ``{"fallbacks": [...]}`` body: in order, at most
    ``MAX_FALLBACKS`` long, and `[]` when the key is missing or null (which clears them). ValueError
    names the entry the body got wrong."""
    if not isinstance(body, dict):
        raise ValueError("Body must be a JSON object")
    entries = body.get("fallbacks")
    if entries is None:
        return []
    if not isinstance(entries, list):
        raise ValueError("fallbacks must be a list")
    if len(entries) > MAX_FALLBACKS:
        raise ValueError(f"A bot takes at most {MAX_FALLBACKS} fallback models")
    return [_entry(entry, number) for number, entry in enumerate(entries, start=1)]


def _entry(value: Any, number: int) -> Dict[str, str]:
    """One fallback off the wire, named by its place in the list so a refusal says which."""
    if not isinstance(value, dict):
        raise ValueError(f"Fallback {number} must be an object")
    provider, model = _pair(
        value, f"Fallback {number} needs a provider", f"Fallback {number} needs a model"
    )
    return {"provider": provider, "model": model}


def _pair(body: Any, needs_provider: str, needs_model: str) -> tuple[str, str]:
    """``(provider, model)``, trimmed; ValueError with the matching message when one is missing."""
    provider = body.get("provider") if isinstance(body, dict) else None
    model = body.get("model") if isinstance(body, dict) else None
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError(needs_provider)
    if not isinstance(model, str) or not model.strip():
        raise ValueError(needs_model)
    return provider.strip(), model.strip()


def _custom_providers(cfg: Dict[str, Any]) -> Any:
    try:
        from hermes_cli.config import get_compatible_custom_providers

        return get_compatible_custom_providers(cfg)
    except Exception:
        return cfg.get("custom_providers")


def _switch(cfg: Dict[str, Any], provider: str, model: str) -> Any:
    """Hermes's own check of a pick, as a messaging ``/model`` runs it: its route resolution, then
    its validation. ValueError carrying Hermes's reason when it refuses."""
    from hermes_cli.model_switch import switch_model

    current = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    result = switch_model(
        raw_input=model,
        current_provider=current.get("provider") or "openrouter",
        current_model=current.get("default") or "",
        current_base_url=current.get("base_url") or "",
        is_global=True,
        explicit_provider=provider,
        user_providers=cfg.get("providers"),
        custom_providers=_custom_providers(cfg),
    )
    if not result.success:
        raise ValueError(result.error_message or f"Hermes can't run {model} on {provider}")
    return result


def set_main(config_path: Path, provider: str, model: str) -> Dict[str, str]:
    """Make ``provider``/``model`` the main model in ``config_path``. ValueError when Hermes refuses
    the pick, with its own reason."""
    from gateway.run import _load_gateway_config
    from hermes_cli.model_switch import persist_model_selection

    cfg = _load_gateway_config(config_path=config_path) or {}
    result = _switch(cfg, provider, model)
    persist_model_selection(result, config_path)
    return {"provider": result.target_provider, "model": result.new_model}


def set_fallbacks(config_path: Path, entries: List[Dict[str, str]]) -> List[Dict[str, str]]:
    """Record ``entries`` as the bot's fallback models in ``config_path``, in order; an empty list
    clears them. Every pick is checked by Hermes the way the main model is, and a refusal is a
    ValueError carrying its reason. One key is written, so the rest of the file and its comments
    survive."""
    from gateway.run import _load_gateway_config
    from utils import atomic_roundtrip_yaml_update

    cfg = _load_gateway_config(config_path=config_path) or {}
    resolved = []
    for entry in entries:
        result = _switch(cfg, entry["provider"], entry["model"])
        resolved.append({"provider": result.target_provider, "model": result.new_model})
    # ``None`` removes the key: a cleared bot keeps no empty list behind it.
    atomic_roundtrip_yaml_update(config_path, FALLBACK_KEY, resolved or None)
    return resolved


def read_fallbacks(config_path: Path) -> List[Dict[str, str]]:
    """The fallback models recorded in ``config_path``, in order, as the bot's settings read them
    back; `[]` when it has none."""
    from gateway.run import _load_gateway_config

    cfg = _load_gateway_config(config_path=config_path) or {}
    model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
    return _stored(model.get("fallbacks"))


def _stored(value: Any) -> List[Dict[str, str]]:
    """The entries in a ``model.fallbacks`` value: anything malformed (a hand-edited file) drops
    out, and nothing past the cap is kept."""
    if not isinstance(value, list):
        return []
    entries: List[Dict[str, str]] = []
    for entry in value:
        if len(entries) == MAX_FALLBACKS:
            break
        if not isinstance(entry, dict):
            continue
        try:
            entries.append(_entry(entry, len(entries) + 1))
        except ValueError:
            continue
    return entries
