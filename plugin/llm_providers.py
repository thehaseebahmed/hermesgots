"""A bot's LLM providers: the API-key providers this Hermes knows, each key as its mask.

The list is not written here. It is the host's own catalog — the same one ``hermes model`` and the
desktop's Settings → Providers tabs read — filtered to the providers that take a pasted API key. So a
provider Hermes adds later is a row without a plugin release, and one this file spelled differently
can never be a row that writes nothing.

The one rule the page rests on is that a key never leaves the host:

- A row's value is ``mask_secret``'s own output — the first four and last four characters, and
  ``***`` for anything under that function's floor — or ``None`` where no key is set. There is no
  ``key_set`` boolean beside it: two facts about one credential can disagree, and one cannot.
- A catalog entry with no key env var is no row at all. A slot that could never leave *Not set* is a
  control that writes nothing.
- A provider's slot is the first of its key env vars, the one the host writes a key to.
- The provider's own ``config.yaml`` is not read: a key's presence is the host's dotenv-aware env
  read (``credentials``), the same one Speech-to-text makes of its providers. A key that lives only
  in a ``config.yaml`` mirror therefore reads *Not set* — the risk the plan names, which replacing
  the key heals.

``endpoints`` is the host's own ``list_custom_endpoints()``, the same list the desktop's Settings →
Providers draws: a ``providers.<id>`` entry, a legacy ``custom_providers`` row the migration left
behind, and a bare ``provider: custom`` slot. Each row's mask is **not** the list's
``api_key_preview``: that is ``"${KEY_ENV}"`` for a key-env entry — the host's display for the
indirection — so the entry's own ``key_env`` is read from the profile's ``config.yaml`` and *that*
masked, and a plaintext ``api_key`` an older release left in the entry is masked the same way. A
legacy row's entry is the ``custom_providers`` one its name slugs to, so a row the migration never
converted reads the key it really authenticates with rather than *Not set*. An entry with neither
reads *Not set*.

A key is written through Hermes's credential lifecycle (``save_provider_env_credential``), never its
``config.yaml`` writer: the lifecycle also reconciles the config mirrors, the env-seeded
credential-pool entries and the provider's model-cache rows, which would otherwise keep
authenticating with the key that was just replaced. An endpoint's key goes the same way through the
host's own ``upsert_custom_endpoint`` — the plugin composes no ``providers`` entry and writes no
``config.yaml`` — and its target is spelled ``custom:<id>`` so one address names one key whatever
kind of row owns it. A body whose key *is* a mask — the shape the page was handed — is refused on
the host's own rule before any of that is asked.

An endpoint is added through that same writer, with the four fields a form holds — so the plugin
slugs no id and composes no ``providers`` entry there either — and a name an endpoint already carries
is refused before it, because the writer would merge onto that entry rather than add a second one.

It is removed through the host's own ``delete_custom_endpoint``, which drops the ``providers`` entry,
detaches any main-model mirror from it and takes its key out of ``.env`` — the same entry, in one
writer, so the plugin composes no removal of its own. Not while the bot's model runs on it, though:
the list's ``is_current`` row is refused before that writer is asked, because deleting it would
silently unpick a model the reader chose somewhere this page can't. Switching one is a model-picking
decision, so the refusal says to make it there first.

A key is removed through the same lifecycle (``remove_provider_env_credential``), never its
``remove_env_value``: dropping the value from ``.env`` alone leaves the value-matched ``config.yaml``
mirror and the pool entry behind, still authenticating with a key the page says is gone. A removal of
a key that is already absent is not an error — the lifecycle's own removal is idempotent, so a stale
screen and a ``curl`` both get the fresh block, in which the row simply reads *Not set*.

Every Hermes import stays inside the function that uses it, as everywhere in this plugin, and none
is softened into a default: a host without the catalog raises ImportError, which the route answers
with a 501 and which ``available`` turns into a withheld page (a bot with no page, rather than a page
of blanks that reads as "no keys").
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import credentials

logger = logging.getLogger(__name__)

# The catalog tab whose providers take a pasted key. The other one — ``accounts`` — signs in, and is
# a non-goal of this page.
KEYS = "keys"


def _catalog() -> List[Any]:
    """The host's provider catalog, as ``hermes_cli.provider_catalog.provider_catalog()`` answers it."""
    from hermes_cli.provider_catalog import provider_catalog

    return list(provider_catalog())


# The prefix one address spells an endpoint's key with: `custom:<id>`, so a provider's slug and an
# endpoint's id can never be mistaken for each other.
ENDPOINT_PREFIX = "custom:"


def _endpoint_list() -> List[Dict[str, Any]]:
    """The host's own custom endpoints, as ``list_custom_endpoints()`` answers its rows."""
    from hermes_cli.web_routers.config_env import list_custom_endpoints

    answer = list_custom_endpoints()
    rows = answer.get("endpoints") if isinstance(answer, dict) else None
    return [row for row in (rows or ()) if isinstance(row, dict)]


def _slug(name: str) -> str:
    """The id the host slugs from an endpoint's name, imported where it is used.

    ``upsert_custom_endpoint`` writes ``providers.<id>`` under this function's own answer, and the
    list reports each row by that id — so the plugin asks it rather than restating the rule: the id
    a legacy entry is filed under and the id a new name would collide with are then one spelling by
    construction, and ``Home box!`` cannot land on a ``Home box`` that is already there.
    """
    from hermes_cli.web_routers.config_env import _custom_endpoint_id

    return _custom_endpoint_id(name)


def _entry_mask(entry: Any) -> Optional[str]:
    """One entry's key as its mask, or ``None`` where it names none.

    The entry's ``key_env`` first — the variable Hermes writes a key to, read through the host's own
    dotenv-aware env read — and else a plaintext ``api_key`` an older release left in the entry.
    Either way what leaves here is ``mask_secret``'s output and never the value.
    """
    if not isinstance(entry, dict):
        return None
    key_env = str(entry.get("key_env") or "").strip()
    if key_env:
        return credentials.masked(key_env)
    plaintext = str(entry.get("api_key") or "").strip()
    if plaintext:
        return credentials.mask(plaintext)
    return None


def _endpoints(
    config_path: Path, listed: Optional[List[Dict[str, Any]]] = None
) -> List[Dict[str, Any]]:
    """The page's endpoint rows: what the host lists, each key as the mask its own entry names.

    ``listed`` is the list a write already fetched and left as it was (a key write changes no row),
    so that write reads the host's list once rather than twice; an add or a removal passes none,
    since only the host's fresh list holds the row the answer must show.

    The profile's ``config.yaml`` is opened once, and only where the host listed something: it is
    the one place an endpoint's ``key_env`` can be read — the list says a key exists but never which
    value it is, and its ``api_key_preview`` is the host's ``"${KEY_ENV}"`` display, not a mask.

    An entry lives under ``providers.<id>`` — for a row in either kind of endpoint, since a
    ``providers`` entry is what the host's writer makes of one. A legacy ``custom_providers`` row —
    one the host still routes but the migration never converted — has no such entry, so its key is
    the one *that* list's entry names: the two are read where the host lists them, so a legacy row
    reads its mask rather than *Not set* until a key write converts it (the host's own writer pops
    the legacy row and writes a ``providers`` one).
    """
    rows_listed = _endpoint_list() if listed is None else listed
    if not rows_listed:
        return []
    from . import config_keys

    config = config_keys.load(config_path, strict=True)
    providers = config.get("providers")
    entries = providers if isinstance(providers, dict) else {}
    legacy = config.get("custom_providers")
    legacy = [one for one in legacy if isinstance(one, dict)] if isinstance(legacy, list) else []
    rows: List[Dict[str, Any]] = []
    for raw in rows_listed:
        endpoint_id = str(raw.get("id") or "").strip()
        if not endpoint_id:
            # A row with no id has no address to write to and no entry to read: it is no row.
            continue
        rows.append(
            {
                "id": endpoint_id,
                "name": str(raw.get("name") or endpoint_id),
                "base_url": str(raw.get("base_url") or ""),
                "model": str(raw.get("model") or ""),
                "masked": _entry_mask(_entry_of(endpoint_id, entries, legacy)),
            }
        )
    return rows


def _entry_of(
    endpoint_id: str, entries: Dict[str, Any], legacy: List[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    """The config entry behind one listed row: its ``providers`` one, else the legacy it came from.

    The legacy list is keyed by the name the host slugs an endpoint's id from, so the row's own id
    is the way back to it — and a row the host lists from nowhere else finds nothing, which is the
    *Not set* a bare endpoint reads.
    """
    entry = entries.get(endpoint_id)
    if isinstance(entry, dict):
        return entry
    for one in legacy:
        named = str(one.get("name") or "").strip()
        if named and _slug(named) == endpoint_id:
            return one
    return None


def _endpoint_of(endpoint_id: str) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """One endpoint's row and the list it was read from, or a ``ValueError`` naming the id.

    The list is asked every time, never restated: an id this host doesn't hold is a refusal, in a
    sentence that says which id it was. It comes back with the row because the list is the one a
    write already paid for — a key write leaves it unchanged, and its answer is drawn from it.
    """
    if not endpoint_id:
        raise ValueError("No custom endpoint was named.")
    listed = _endpoint_list()
    for raw in listed:
        if str(raw.get("id") or "") == endpoint_id:
            return raw, listed
    raise ValueError(f"{endpoint_id} isn't a custom endpoint this Hermes knows.")


def _host_refusal(error: BaseException) -> Optional[str]:
    """The sentence a host's own HTTP refusal carries, or ``None`` for any other exception.

    ``upsert_custom_endpoint`` raises FastAPI's ``HTTPException`` for a body it won't take (``model
    required``, a base URL with no host). The plugin reads it by its two attributes rather than
    importing FastAPI for it: the host that raises one is the host that imported it.
    """
    status = getattr(error, "status_code", None)
    detail = getattr(error, "detail", None)
    if not isinstance(status, int) or not isinstance(detail, str):
        return None
    return detail.strip() or None


def _ask_host(call: Callable[..., Any], *args: Any) -> None:
    """Ask one of the host's own custom-endpoint verbs, its refusal read as the sentence it carries.

    A body or an id the host won't take arrives as FastAPI's ``HTTPException``, and every caller here
    wants the same thing of that: the sentence as a ``ValueError``, which the route answers as the
    400 the user reads. Anything else is left to raise as it came — a host that is simply broken is
    the route's 502, not a refusal the reader could act on.
    """
    try:
        call(*args)
    except Exception as error:
        detail = _host_refusal(error)
        if detail is None:
            raise
        raise ValueError(detail) from error


class EndpointInUse(ValueError):
    """A removal the bot's own model runs on: the plan's 409, not the page's ordinary 400.

    Every other refusal this page makes is a 400 in a sentence the reader can act on in place. This
    one is different — the endpoint can only be let go once the model runs somewhere else, which is
    Hermes's own model picker's decision — so it carries a code a client can read, under the status
    the plan's route table names.
    """


def available() -> Optional[str]:
    """``None`` where this page can list the host's providers and endpoints, else why it can't.

    Every read the page rests on is asked, not just the catalog: a host that can list its providers
    but can't mask a key, can't read one, or has no custom-endpoint list must withhold the page
    rather than draw rows it can't answer for — one page, one feature, all or nothing, so a host
    without the endpoints withholds the page instead of failing every read of it.
    """
    try:
        _catalog()
        # The rows read a key through ``credentials.masked``; asking it here is what makes this gate
        # the same read rather than a second one that could drift — the empty name answers no mask,
        # and the import of the host's own mask behind it is the whole of what is being proved.
        credentials.masked("")
        _endpoint_list()
    except Exception:
        logger.debug("gots: this Hermes can't list its API-key providers", exc_info=True)
        return "This Hermes version can't show its API-key providers."
    return None


FEATURES: Tuple[Tuple[str, Callable[[], Optional[str]]], ...] = (("llm_providers", available),)


def _row(entry: Any) -> Optional[Dict[str, Any]]:
    """One catalog entry as the page's row, or ``None`` where the entry is no row at all."""
    slug = str(getattr(entry, "slug", "") or "")
    if not slug:
        return None
    # One slot per provider: the first key variable, which is the one a key is written to. An entry
    # with none is no row — there is nothing that row could ever say but *Not set*.
    slot = _slot(entry)
    if not slot:
        return None
    label = str(getattr(entry, "label", "") or "")
    return {
        "slug": slug,
        "label": label or slug,
        "description": str(getattr(entry, "description", "") or ""),
        "masked": credentials.masked(slot),
    }


def _slot(entry: Any) -> str:
    """The env variable a catalog entry's key is written to, or ``""`` where the entry is no row.

    The keys tab's first key variable: the one the host writes a key to. A provider that signs in —
    the ``accounts`` tab — has no slot of its own, so it is neither a row nor a write's target.
    """
    if getattr(entry, "tab", "") != KEYS:
        return ""
    env_vars = getattr(entry, "api_key_env_vars", ()) or ()
    return str(env_vars[0]).strip() if env_vars else ""


def _slot_of(target: str) -> Tuple[str, List[Any]]:
    """The env variable a slug's key is written to and the catalog read, or a ``ValueError``.

    The catalog is asked every time, never restated: a slug this Hermes doesn't list — and one it
    lists with no slot — is a refusal, in a sentence that says which slug it was. It comes back with
    the slot because the catalog is the one a write already paid for, and the answer's rows are
    drawn from it rather than read again.
    """
    if not target:
        raise ValueError("No provider was named.")
    entries = _catalog()
    for entry in entries:
        if str(getattr(entry, "slug", "") or "") != target:
            continue
        slot = _slot(entry)
        if slot:
            return slot, entries
        raise ValueError(f"{target} takes no API key, so there is nothing this page could write.")
    raise ValueError(f"{target} isn't an API-key provider this Hermes knows.")


def _typed_key(value: Any) -> str:
    """The key a body carries, as the one string both writes store.

    ``write_key`` and ``add_endpoint`` both go through here rather than each stripping its own way,
    so the two can't disagree about what the string is: the mask rule is asked of what would be
    stored, never of the body as it arrived — a mask pasted back as ``" ***"`` or ``"***\\n"`` is
    refused like the bare one — and a typed key is stored trimmed rather than with a clipboard's
    whitespace in it.
    """
    return value.strip() if isinstance(value, str) else ""


def _refuse_preview(key: str) -> None:
    """Refuse a submitted mask on the host's own rule, before anything else looks at it.

    A mask is what the page was handed, so a body that sends one back is a stale screen or a curl,
    never a key. The rule is Hermes's own — ``***``, the legacy ``xxxx...xxxx`` shape and a
    ``«redacted…»`` sentinel — so the plugin can't drift from what the Dashboard refuses. Neither
    the value nor any of it appears in the sentence.
    """
    from hermes_cli.web_routers._common import is_redacted_credential_preview

    if is_redacted_credential_preview(key):
        raise ValueError("That is a masked key, not a key. Type the key itself.")


def write_key(config_path: Path, target: str, key: str) -> Dict[str, Any]:
    """Write one key — a provider's or an endpoint's — and answer the page as it now reads.

    A target spelled ``custom:<id>`` is a custom endpoint's key and goes through the host's own
    ``upsert_custom_endpoint``; anything else is a catalog slug, whose write is Hermes's credential
    lifecycle rather than its ``config.yaml`` writer (the lifecycle also reconciles the config
    mirrors, the env-seeded credential-pool entries and the provider's model-cache rows, which would
    otherwise keep authenticating with the key that was just replaced). The key is stripped once, at
    the top, and that one string is what the mask rule reads and what would be stored — the same
    helper an added endpoint's key goes through, so the two writes can't disagree about it. A mask is
    refused before either is asked, and the key is never logged, echoed back or named in a refusal:
    what a caller gets is the fresh block, in which the key is only ever its mask.

    Raises ``ValueError`` for a mask, an empty key or a target this host can't write, and
    ``ImportError`` where this host has no rule, lifecycle or endpoint list, which the route answers
    with a 501.
    """
    key = _typed_key(key)
    _refuse_preview(key)
    if not key:
        # A blank is a removal, and a removal is its own step with its own confirmation.
        raise ValueError("A key can't be empty.")
    spelled = str(target or "").strip()
    if spelled.startswith(ENDPOINT_PREFIX):
        return _write_endpoint_key(config_path, spelled[len(ENDPOINT_PREFIX) :].strip(), key)
    slot, entries = _slot_of(spelled)
    from hermes_cli.credential_lifecycle import save_provider_env_credential

    save_provider_env_credential(slot, key)
    # The catalog the slot was read from is the catalog the answer's rows are drawn from: a key write
    # changes no provider and no endpoint, so only the config its masks come from is read again.
    return read(config_path, catalog=entries)


def _write_endpoint_key(config_path: Path, endpoint_id: str, key: str) -> Dict[str, Any]:
    """Replace one endpoint's key through the host's own writer, and answer the fresh block.

    The body is the host's ``CustomEndpointUpdate``, and the fields are the host's own: ``id``, the
    stored ``name``, ``base_url`` and ``model`` come from the row its list answered, so the app can
    never rewrite a field it does not own, and only the key is the caller's. The host writes the key
    to ``.env`` behind the entry's ``key_env``, keeps the entry's other fields, and clears or
    migrates a legacy plaintext ``api_key`` itself — which is why nothing is composed here and
    ``config.yaml`` is never written.

    ``discover_models`` is carried on the body with the row's own answer: the model's default is
    ``True``, and the host writes whatever the body says over the entry's stored value, so a body
    that named none would quietly switch discovery back on for an endpoint that had turned it off.

    A host refusal (a base URL with no host, a model it won't take) arrives as FastAPI's
    ``HTTPException`` and leaves here as a ``ValueError`` carrying its sentence, which the route
    answers as a 400 the user can read.
    """
    row, listed = _endpoint_of(endpoint_id)
    from hermes_cli.web_models import CustomEndpointUpdate
    from hermes_cli.web_routers.config_env import upsert_custom_endpoint

    body = CustomEndpointUpdate(
        id=str(row.get("id") or endpoint_id),
        name=str(row.get("name") or endpoint_id),
        base_url=str(row.get("base_url") or ""),
        model=str(row.get("model") or ""),
        api_key=key,
        discover_models=bool(row.get("discover_models", True)),
    )
    _ask_host(upsert_custom_endpoint, body)
    # The list the row came from is unchanged by a key: the answer is drawn from it, and only the
    # config its masks are read from is opened again.
    return read(config_path, listed=listed)


def add_endpoint(config_path: Path, body: Dict[str, Any]) -> Dict[str, Any]:
    """Add one custom endpoint through the host's own writer, and answer the page as it now reads.

    The body is the page's four fields — a name, a base URL, a model and the typed key — and nothing
    else is composed here: ``upsert_custom_endpoint`` validates the URL, slugs the id from the name,
    writes ``providers.<id>``, puts the key in ``.env`` behind the entry's ``key_env`` and clears or
    migrates a legacy plaintext ``api_key`` on the same write. So the plugin writes no config and
    makes no id, and an endpoint Hermes adds later is added the same way.

    ``discover_models`` is left at the body's own default: this is a new entry, so the host's default
    is the answer a person would give — there is no stored value a body could contradict.

    The key may be absent: a local server that takes no key is an endpoint Hermes holds too, and the
    API tolerates a write with no key for one. (The page's form requires a key before it offers Save,
    which is the form's rule, not this one.) A key that *is* a mask is refused first of all, before
    anything else in the body is read or written, on the host's own rule.

    Three fields are required, and each has to hold something: a body short one of them is refused in
    a sentence naming all three. A name an endpoint already carries is refused too —
    ``upsert_custom_endpoint`` would merge onto that entry rather than add a second one, so a form
    that said "add" would rewrite an endpoint its user never touched.

    A host refusal (a base URL with no host) arrives as FastAPI's ``HTTPException`` and leaves here as
    a ``ValueError`` carrying its sentence, which the route answers as a 400 the user can read.
    """
    fields = body if isinstance(body, dict) else {}
    key = _typed_key(fields.get("key"))
    _refuse_preview(key)
    name = str(fields.get("name") or "").strip()
    base_url = str(fields.get("base_url") or "").strip()
    model = str(fields.get("model") or "").strip()
    if not (name and base_url and model):
        raise ValueError("A custom endpoint needs a name, a base URL and a model.")
    _refuse_duplicate(name)
    from hermes_cli.web_models import CustomEndpointUpdate
    from hermes_cli.web_routers.config_env import upsert_custom_endpoint

    update = CustomEndpointUpdate(
        name=name,
        base_url=base_url,
        model=model,
        api_key=key or None,
    )
    _ask_host(upsert_custom_endpoint, update)
    # The host's list is read again here, unlike a key write's: the row this add made is only in the
    # fresh list, and those are the rows the answer has to draw.
    return read(config_path)


def _refuse_duplicate(name: str) -> None:
    """Refuse a name whose id an endpoint already carries, in a sentence naming that endpoint.

    The host's writer merges onto the entry the body's id names, and that id is slugged from the
    name: a second endpoint whose name slugs what one is already filed under — ``Home box!`` and
    ``Home box`` are one id — would quietly rewrite that one's base URL and model rather than add
    anything. So the two are compared by id, each through the host's own slug, rather than by their
    words, which is the spelling the writer itself would resolve.
    """
    wanted = _slug(name)
    if not name.strip() or not wanted:
        return
    for row in _endpoint_list():
        held = str(row.get("id") or "").strip()
        if not held:
            continue
        if wanted in (held, _slug(held)):
            raise ValueError(
                f"This Hermes already has a custom endpoint named {str(row.get('name') or held)}. "
                "Adding one with that name would replace it instead of adding a new one."
            )


def remove_key(config_path: Path, target: str) -> Dict[str, Any]:
    """Remove one provider's key, and answer the page as it now reads.

    The removal is Hermes's credential lifecycle, not its ``remove_env_value``: dropping the value
    from ``.env`` alone leaves the value-matched ``config.yaml`` mirror and the env-seeded pool entry
    authenticating with a key the page would then call *Not set*. The lifecycle is idempotent, so a
    key that was already absent is the same answer rather than a refusal — a stale screen's Remove,
    or a ``curl``'s, still gets the block.

    The target is resolved by the same rule a write's is, so an unknown slug and a provider with no
    slot are both refused by name before anything is asked. No key is ever named here: a removal
    takes the env variable alone.

    Raises ``ValueError`` for a target this host can't write, and ``ImportError`` where this host has
    no lifecycle, which the route answers with a 501.
    """
    slot, entries = _slot_of(str(target or "").strip())
    from hermes_cli.credential_lifecycle import remove_provider_env_credential

    remove_provider_env_credential(slot)
    # A removal changes no row the page lists, so the catalog it was resolved in is the one drawn.
    return read(config_path, catalog=entries)


def remove_endpoint(config_path: Path, target: str) -> Dict[str, Any]:
    """Remove one custom endpoint — its entry and its key — and answer the page as it now reads.

    The endpoint is resolved through the host's own ``list_custom_endpoints()``, so an id this host
    doesn't list is refused in a sentence naming it, and the row that comes back says whether the
    bot's model runs on it. That one is refused before any writer is asked: the host's delete would
    detach the main-model mirror, which is to say it would quietly unpick the model the reader chose
    in Hermes's own model picker. Switching one is that picker's decision, so the sentence says to
    make it there first — and nothing is written or deleted on the way.

    Any other endpoint goes through the host's own ``delete_custom_endpoint``: it drops the
    ``providers`` entry, detaches whatever main-model mirror a legacy row left behind, and removes
    the key from ``.env`` behind the entry's ``key_env``. So the plugin composes no entry removal and
    writes no ``config.yaml`` of its own, exactly as it composes none of an add.

    A host refusal (an endpoint its own list held but its writer won't) arrives as FastAPI's
    ``HTTPException`` and leaves here as a ``ValueError`` carrying its sentence, as the other writes
    do.

    Raises ``ValueError`` for an unknown id and for the endpoint the model runs on, and
    ``ImportError`` where this host has no endpoint list or no delete, which the route answers with a
    501.
    """
    row, _ = _endpoint_of(str(target or "").strip())
    endpoint_id = str(row.get("id") or target).strip()
    name = str(row.get("name") or endpoint_id)
    if bool(row.get("is_current")):
        raise EndpointInUse(f"This bot's model runs on {name}. Switch the model first.")
    from hermes_cli.web_routers.config_env import delete_custom_endpoint

    _ask_host(delete_custom_endpoint, endpoint_id)
    # The list is read again, as an add's is: the row that went is only gone from the host's fresh
    # one, and the answer draws the rows the host holds now.
    return read(config_path)


def read(
    config_path: Path,
    *,
    catalog: Optional[List[Any]] = None,
    listed: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """The page's one read: every provider and endpoint this bot can be given a key for, masked.

    ``catalog`` and ``listed`` are the rows a write already fetched and left as they were — the
    host's provider catalog, which no write changes, and its endpoint list, which a key write
    doesn't touch. Handed over, they cost one read each rather than two; a write that changed the
    list (an add, a removal) passes none, since only the host's fresh list holds the rows the answer
    must show. The answer is the same block either way.

    ``config_path`` is the profile's ``config.yaml``, opened once, and only to find the ``key_env``
    an endpoint's entry names (``_endpoints``): a provider's key lives in the bot's env, which the
    host reads for itself, and the endpoints come from the host's own list rather than the file.

    Raises ImportError where this host has no catalog, mask or endpoint list, which the route answers
    with a 501 rather than with a page of *Not set* rows.
    """
    entries = _catalog() if catalog is None else catalog
    providers: List[Dict[str, Any]] = []
    for entry in entries:
        row = _row(entry)
        if row is not None:
            providers.append(row)
    return {"providers": providers, "endpoints": _endpoints(config_path, listed)}
