"""The profile's main model, set from the Gots app.

Hermes's only route for it is the dashboard's ``POST /api/model/set``, which the app can't reach
(localhost only, a token that changes on every start). So the bot editor's Default model comes here,
and it goes through the same two calls as a messaging ``/model --global``: ``switch_model`` checks
the provider and model and resolves the route, and ``persist_model_selection`` writes only the
``model.*`` keys it changed, keeping the rest of ``config.yaml`` and its comments. The API server
reads ``config.yaml`` each time it builds an agent, so the next turn on every surface of the profile
runs it without a restart.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict


def clean(body: Any) -> tuple[str, str]:
    """``(provider, model)`` from a request body, or ValueError."""
    if not isinstance(body, dict):
        raise ValueError("Body must be a JSON object")
    provider = body.get("provider")
    model = body.get("model")
    if not isinstance(provider, str) or not provider.strip():
        raise ValueError("provider is required")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("model is required")
    return provider.strip(), model.strip()


def _custom_providers(cfg: Dict[str, Any]) -> Any:
    try:
        from hermes_cli.config import get_compatible_custom_providers

        return get_compatible_custom_providers(cfg)
    except Exception:
        return cfg.get("custom_providers")


def set_main(config_path: Path, provider: str, model: str) -> Dict[str, str]:
    """Make ``provider``/``model`` the main model in ``config_path``. ValueError when Hermes refuses
    the pick, with its own reason."""
    from gateway.run import _load_gateway_config
    from hermes_cli.model_switch import persist_model_selection, switch_model

    cfg = _load_gateway_config(config_path=config_path) or {}
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
    persist_model_selection(result, config_path)
    return {"provider": result.target_provider, "model": result.new_model}
