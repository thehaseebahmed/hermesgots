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
reads *Not set*. That same entry is where a row's ``transport`` and ``affinity`` come from — the
transport under either spelling this host accepts (``transport``, or the older ``api_mode``) and the
affinity header under ``session_affinity_header``, both empty where the entry names neither — so the
two settings the form edits are drawn from the one block the form writes.

A key is written through Hermes's credential lifecycle (``save_provider_env_credential``), never its
``config.yaml`` writer: the lifecycle also reconciles the config mirrors, the env-seeded
credential-pool entries and the provider's model-cache rows, which would otherwise keep
authenticating with the key that was just replaced. An endpoint's key is that same write, behind the
``key_env`` its entry names — ``custom:<id>`` is one address for one key whatever kind of row owns it
— so a key replace rewrites no entry at all. A body whose key *is* a mask — the shape the page was
handed — is refused on the host's own rule before any of it is asked.

An entry written here is the shape this Hermes stores one in — ``api``, ``key_env``,
``transport``, ``session_affinity_header`` and ``default_model`` beside whatever else the block
carries — and the plugin composes none of it: the entry is built by the host's own builder,
``hermes_cli.config_providers._custom_provider_entry_to_provider_config``, which is the function the
host's own writers and migration use, so a field Hermes teaches it about later is written here
without a plugin release. The plugin's own part is the merge: the builder's answer is laid over the
entry already there, so only the fields the page's form sends move, and every key the form has no
field for — ``extra_headers``, the ``ssl_*`` pair, ``catalog_provider``, ``models``, ``extra_body``,
``rate_limit_delay`` — survives exactly as it was written.

A POST is one endpoint's write, whether or not that endpoint is there yet: a body carrying an id
edits that endpoint — keeping the id and its ``key_env`` — and a body without one creates an
endpoint under the id the host slugs from its name, which is also why a name an endpoint already
carries is refused rather than allowed to take over that endpoint's entry. A body that carries no
key leaves the stored one exactly as it is: an empty key field is what the page hands back for a key
it drew as a mask, so reading it as *clear* would delete a key nobody asked about.

A key is removed through the same lifecycle (``remove_provider_env_credential``), never its
``remove_env_value``: dropping the value from ``.env`` alone leaves the value-matched ``config.yaml``
mirror and the pool entry behind, still authenticating with a key the page says is gone. A removal of
a key that is already absent is not an error — the lifecycle's own removal is idempotent, so a stale
screen and a ``curl`` both get the fresh block, in which the row simply reads *Not set*. It is the
provider's key that is removed there: an endpoint's key goes with the endpoint, in the one host
writer that removes both.

An endpoint itself is removed through the host's own ``delete_custom_endpoint``, which drops the
``providers`` entry, detaches any main-model mirror from it and takes its key out of ``.env`` — the
same entry, in one writer, so the plugin composes no removal of its own. Not while the bot's model
runs on it, though: the list's ``is_current`` row is refused before that writer is asked, because
deleting it would silently unpick a model the reader chose somewhere this page can't. Switching one
is a model-picking decision, so the refusal says to make it there first.

Every Hermes import stays inside the function that uses it, as everywhere in this plugin, and none
is softened into a default: a host without the catalog raises ImportError, which the route answers
with a 501 and which ``available`` turns into a withheld page (a bot with no page, rather than a page
of blanks that reads as "no keys").
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import config_keys, credentials

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

    A new endpoint is filed under this function's own answer — the id ``providers.<id>`` is named by,
    and the id the host's list reports each row by — so the plugin asks it rather than restating the
    rule: the id a legacy entry is filed under and the id a new name would collide with are then one
    spelling by construction, and ``Home box!`` cannot land on a ``Home box`` that is already there.
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


def _entry_key_env(endpoint_id: str, entry: Any) -> str:
    """The variable an endpoint's key is held in, as the entry names it or as this plugin would.

    A form labels its key field with this, so a reader sees `HERMES_CUSTOM_HOME_BOX_API_KEY` rather
    than prose — the same way a provider's field is labelled with its own env var.
    """
    if isinstance(entry, dict):
        key_env = str(entry.get("key_env") or "").strip()
        if key_env:
            return key_env
    return _endpoint_key_env(endpoint_id)


def _entry_transport(entry: Any) -> str:
    """One entry's transport, under either spelling this host reads, or ``""`` where it pins none.

    ``api_mode`` is the spelling the Dashboard's own writer emits and the normalizer reads first;
    ``transport`` is the v12 one this instance's ``providers.litellm`` is written in. Both are the
    same setting, so a row reports whichever the entry carries rather than restating the order in
    the page — and an entry that pins nothing says so with an empty string, which is what the
    runtime's auto-detect is.
    """
    if not isinstance(entry, dict):
        return ""
    return str(entry.get("transport") or entry.get("api_mode") or "").strip()


def _entry_affinity(entry: Any) -> str:
    """One entry's session-affinity header, or ``""`` where it names none."""
    if not isinstance(entry, dict):
        return ""
    return str(entry.get("session_affinity_header") or "").strip()


def _endpoints(
    config_path: Path, listed: Optional[List[Dict[str, Any]]] = None
) -> List[Dict[str, Any]]:
    """The page's endpoint rows: what the host lists, each key as the mask its own entry names.

    ``listed`` is the list a write already fetched and left as it was (a key write changes no row),
    so that write reads the host's list once rather than twice; an add, an edit or a removal passes
    none, since only the host's fresh list holds the row the answer must show.

    The profile's ``config.yaml`` is opened once, and only where the host listed something: it is
    the one place an endpoint's ``key_env``, ``transport`` and ``session_affinity_header`` can be
    read — the list says a key exists but never which value it is, its ``api_key_preview`` is the
    host's ``"${KEY_ENV}"`` display rather than a mask, and it carries no affinity header at all.

    An entry lives under ``providers.<id>`` — for a row in either kind of endpoint, since a
    ``providers`` entry is what a write here makes of one. A legacy ``custom_providers`` row — one
    the host still routes but the migration never converted — has no such entry, so its key is the
    one *that* list's entry names: the two are read where the host lists them, so a legacy row reads
    its mask rather than *Not set* until a write here converts it (which pops the legacy row and
    writes a ``providers`` one).
    """
    rows_listed = _endpoint_list() if listed is None else listed
    if not rows_listed:
        return []

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
        entry = _entry_of(endpoint_id, entries, legacy)
        rows.append(
            {
                "id": endpoint_id,
                "name": str(raw.get("name") or endpoint_id),
                "base_url": str(raw.get("base_url") or ""),
                "model": str(raw.get("model") or ""),
                "transport": _entry_transport(entry),
                "affinity": _entry_affinity(entry),
                # The variable this endpoint's key is held in, so the form can label its field with
                # it the way a provider's form does.
                "key_env": _entry_key_env(endpoint_id, entry),
                "masked": _entry_mask(entry),
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

    ``delete_custom_endpoint`` raises FastAPI's ``HTTPException`` for an id its own writer won't
    remove. The plugin reads it by its two attributes rather than importing FastAPI for it: the host
    that raises one is the host that imported it.
    """
    status = getattr(error, "status_code", None)
    detail = getattr(error, "detail", None)
    if not isinstance(status, int) or not isinstance(detail, str):
        return None
    return detail.strip() or None


def _ask_host(call: Callable[..., Any], *args: Any) -> None:
    """Ask the host's own custom-endpoint removal, its refusal read as the sentence it carries.

    An id the host won't remove arrives as FastAPI's ``HTTPException``, and the caller wants the
    sentence as a ``ValueError``, which the route answers as the 400 the user reads. Anything else is
    left to raise as it came — a host that is simply broken is the route's 502, not a refusal the
    reader could act on.
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
        # The variable the key is written to. A form labels its field with it, so a reader sees
        # `OPENAI_API_KEY` rather than prose, and so the page names exactly what it writes.
        "env": slot,
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


# The sentence the host's own endpoint writer uses for a URL it won't take. The builder refuses one
# by answering no entry at all rather than by raising, so the words are carried here — the host's own,
# not a rewording a reader would have to reconcile with what the Dashboard says.
_BAD_URL = "base_url must include scheme and host"

# The sentence a body short one of the three fields an endpoint is refuses with. The page's form draws
# all three as required, so this is a stale screen or a `curl` rather than a control offering nothing.
_MISSING_FIELDS = "A custom endpoint needs a name, a base URL and a model."

# The fields this page's form owns: the form's own name for one, the key the host's builder writes it
# as, and the older spellings of that same setting. The normalizer reads those *first*, so a stale one
# left beside the new value would shadow it — an edit therefore clears every spelling before it writes.
_FORM_FIELDS: Tuple[Tuple[str, str, Tuple[str, ...]], ...] = (
    ("name", "name", ()),
    ("base_url", "api", ("base_url", "url")),
    ("model", "default_model", ("model",)),
    ("transport", "transport", ("api_mode",)),
    ("affinity", "session_affinity_header", ()),
)


def _entry_builder() -> Callable[..., Optional[Dict[str, Any]]]:
    """The host's own builder: an entry in the older shape in, the ``providers.<id>`` shape out.

    ``_custom_provider_entry_to_provider_config`` is the function Hermes's own endpoint writer and its
    v11→v12 migration use, so the entry this page lands is the one the Dashboard, ``hermes model`` and
    the runtime already read — a field Hermes teaches it later needs no release here. Its private name
    is the cost of that: a rename is an ImportError the route answers with a 501.
    """
    from hermes_cli.config_providers import _custom_provider_entry_to_provider_config

    return _custom_provider_entry_to_provider_config


def _endpoint_key_env(endpoint_id: str) -> str:
    """The variable this host names a custom endpoint's key by, imported where it is used.

    ``HERMES_CUSTOM_<ID>_API_KEY`` — the name this instance's own ``providers.litellm`` holds its key
    behind — so a key written here lands where the host's own setup would have put it.
    """
    from hermes_cli.config import custom_endpoint_key_env

    return custom_endpoint_key_env(endpoint_id)


def _raw_config(config_path: Path) -> Dict[str, Any]:
    """The profile's ``config.yaml`` exactly as written, for a write to merge onto.

    Not ``config_keys.load``'s view: that expands ``${VAR}`` references, and an entry whose ``api_key``
    is one would come back as the secret itself and be written into the file by the merge. This is the
    host's own guarded read for a read-then-write, which refuses a file it cannot parse rather than
    letting a partial mapping replace it.
    """
    from hermes_cli.config import require_readable_config_before_write

    config = require_readable_config_before_write(config_path)
    return config if isinstance(config, dict) else {}


def _canonical_entry(fields: Dict[str, str]) -> Dict[str, Any]:
    """The form's fields as the host's own builder writes them, or the host's refusal.

    The builder reads the older spelling — ``base_url`` for the URL it emits as ``api``, ``model`` for
    ``default_model``, ``api_mode`` for ``transport`` — and it answers no entry at all for a URL with
    no scheme or host. That ``None`` is the host's refusal and leaves here as its own sentence.
    """
    built = _entry_builder()(
        {
            "name": fields["name"],
            "base_url": fields["base_url"],
            "model": fields["model"],
            "api_mode": fields.get("transport", ""),
            "session_affinity_header": fields.get("affinity", ""),
        },
        provider_key=fields["id"],
    )
    if not isinstance(built, dict):
        raise ValueError(_BAD_URL)
    return built


def _form_entry(entry: Dict[str, Any], fields: Dict[str, str]) -> Dict[str, Any]:
    """The form's fields laid over an entry: only what the body sent moves, and all of it moves.

    ``_custom_provider_entry_to_provider_config`` answers what those fields *are*, not what the entry
    already holds — so its answer is laid over the stored block rather than replacing it, and every
    key the form has no field for (``extra_headers``, ``ssl_verify``/``ssl_ca_cert``,
    ``catalog_provider``, ``models``, ``extra_body``, ``rate_limit_delay``, ``key_env``) is left
    exactly as it was written.

    A field the body did not send is not a field the form changed, so the entry keeps its own; a field
    the body sent empty is a field the form cleared, so its every spelling goes — the builder drops an
    empty ``transport``/affinity, and the merge would otherwise leave the stored value, or worse an
    older spelling of it, standing where the reader just cleared it.
    """
    built = _canonical_entry(fields)
    merged = dict(entry)
    for field, name, older in _FORM_FIELDS:
        if field not in fields:
            continue
        for spelling in older:
            merged.pop(spelling, None)
        if name in built:
            merged[name] = built[name]
        else:
            merged.pop(name, None)
    return merged


def _stored_value(entry: Dict[str, Any], names: Tuple[str, ...]) -> str:
    """One of an entry's fields, under any of the spellings it may hold it in, or ``""``."""
    for name in names:
        value = str(entry.get(name) or "").strip()
        if value:
            return value
    return ""


def _complete(entry: Dict[str, Any], fields: Dict[str, str]) -> Dict[str, str]:
    """The form's fields with the three every entry needs, taken from the entry where none was sent.

    An edit sends only what it changed — the page writes each field whose value differs and no other —
    so a save that moved the model alone carries no name and no base URL. The builder answers an entry
    only from all three, and the ones the body left out are the ones already stored, read under either
    spelling the entry may hold them in. A field equal to what was stored is no change at all: laying
    it back over the entry writes the same value.
    """
    complete = dict(fields)
    for field, names in (
        ("name", ("name",)),
        ("base_url", ("base_url", "url", "api")),
        ("model", ("model", "default_model")),
    ):
        if field not in complete:
            complete[field] = _stored_value(entry, names)
    return complete


def _write_entry(
    config_path: Path,
    endpoint_id: str,
    *,
    fields: Optional[Dict[str, str]] = None,
    key: str = "",
) -> None:
    """Write one endpoint's entry — and its key — the way this Hermes stores one.

    ``fields`` are what the form sent, or ``None`` for a write that changes no field (a key replace);
    ``key`` is a typed key, or ``""`` for one the body did not carry. The entry is the one already
    stored — converted through the builder first where it came from the legacy ``custom_providers``
    list, so it lands in the v12 shape rather than carrying its older spelling into ``providers`` —
    with the form's fields laid over it and the ``key_env`` a key needs named where it has none.

    The entry is written before the key: the entry is the address the key is found by, so a key whose
    write failed leaves an endpoint that reads *Not set* rather than a value in ``.env`` nothing names.
    A plaintext ``api_key`` an older release left in the entry goes when a key is written here, since
    the one place a key is stored is ``.env``.

    ``config.yaml`` is opened only where something about the entry changes: a key replace on an entry
    that already names its ``key_env`` writes the key and nothing else, and no entry at all is touched.
    """
    config = _raw_config(config_path)
    providers = config.get("providers")
    providers = providers if isinstance(providers, dict) else {}
    legacy = config.get("custom_providers")
    legacy = [one for one in legacy if isinstance(one, dict)] if isinstance(legacy, list) else []
    stored = _entry_of(endpoint_id, providers, legacy)
    converted = isinstance(stored, dict) and not isinstance(providers.get(endpoint_id), dict)
    if not isinstance(stored, dict):
        entry: Dict[str, Any] = {}
    elif converted:
        # A legacy row is converted through the builder, not copied: `base_url`/`model` are what the
        # entry it came from spells, and `api`/`default_model` are what a `providers` entry holds.
        entry = dict(_canonical_entry_of(stored, endpoint_id) or stored)
    else:
        entry = dict(stored)
    wrote = converted
    if fields is not None:
        entry = _form_entry(entry, _complete(entry, fields))
        wrote = True
    if key:
        key_env = str(entry.get("key_env") or "").strip() or _endpoint_key_env(endpoint_id)
        if entry.get("key_env") != key_env:
            entry["key_env"] = key_env
            wrote = True
        if "api_key" in entry:
            entry.pop("api_key", None)
            wrote = True
    if wrote:
        config_keys.write(config_path, f"providers.{endpoint_id}", entry)
        if converted:
            config["custom_providers"] = [
                one for one in legacy if _slug(str(one.get("name") or "")) != endpoint_id
            ]
            config_keys.write(config_path, "custom_providers", config["custom_providers"])
    if key:
        from hermes_cli.credential_lifecycle import save_provider_env_credential

        save_provider_env_credential(str(entry.get("key_env") or "").strip(), key)


def _canonical_entry_of(entry: Dict[str, Any], endpoint_id: str) -> Optional[Dict[str, Any]]:
    """One stored entry as the host's builder rewrites it, or ``None`` where it won't take it.

    The entry's own ``key_env`` rides through the builder, so a legacy row's key stays named by the
    variable it already used rather than being renamed behind the reader's back.
    """
    return _entry_builder()(dict(entry), provider_key=endpoint_id)


def write_key(config_path: Path, target: str, key: str) -> Dict[str, Any]:
    """Write one key — a provider's or an endpoint's — and answer the page as it now reads.

    A target spelled ``custom:<id>`` is a custom endpoint's key and goes to ``.env`` behind the
    ``key_env`` its entry names; anything else is a catalog slug, whose key goes to that provider's own
    slot. Either way the write is Hermes's credential lifecycle rather than its ``config.yaml`` writer
    (the lifecycle also reconciles the config mirrors, the env-seeded credential-pool entries and the
    provider's model-cache rows, which would otherwise keep authenticating with the key that was just
    replaced). The key is stripped once, at the top, and that one string is what the mask rule reads and
    what would be stored — the same helper an added endpoint's key goes through, so the two writes can't
    disagree about it. A mask is refused before either is asked, and the key is never logged, echoed
    back or named in a refusal: what a caller gets is the fresh block, in which the key is only ever
    its mask.

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
    """Write one endpoint's key behind the ``key_env`` its entry names, and answer the fresh block.

    The endpoint is resolved through the host's own list, so an id this host doesn't hold is refused in
    a sentence naming it. Nothing of the entry's own is the caller's: the name, the base URL, the model
    and the transport stay exactly as they are stored, and the key goes where every other key in this
    plugin goes — ``.env``, through the credential lifecycle, so the config mirrors and the pool entry
    are reconciled with it.

    The one entry field a key write can change is the ``key_env`` an entry has not named yet: that is
    where the key is found by, so an entry with none is given the name this host gives one, and the
    write that follows is the only reason ``config.yaml`` is opened here at all.

    The list the row came from is the answer's list: a key changes no row of it.
    """
    row, listed = _endpoint_of(endpoint_id)
    endpoint_id = str(row.get("id") or endpoint_id).strip()
    _write_entry(config_path, endpoint_id, key=key)
    return read(config_path, listed=listed)


def add_endpoint(config_path: Path, body: Dict[str, Any]) -> Dict[str, Any]:
    """Add or edit one custom endpoint, and answer the page as it now reads.

    A body carrying an ``id`` is an edit of the endpoint this host lists under it: the entry stays
    where it is, under that id and its ``key_env``, and the fields the body sends — its name, its base
    URL, its model, and the transport and affinity header where it sends those — take the new value.
    Only what it sends: the page writes the fields whose value differs from the row it opened, so an
    edit that moved the model alone carries no name and no base URL, and the entry's own stand in for
    them. A body without an id is a new endpoint, filed under the id the host slugs from its name; a
    name an endpoint already carries is refused, because a second endpoint under that id would take
    over the first one's entry rather than be added beside it.

    Nothing here composes a ``providers`` field: the entry is the host's own builder's answer for these
    fields, laid over the block already stored, so an edit keeps every key the form has no field for and
    an endpoint this page never knew about a field of is written the way Hermes writes it.

    The key is the form's if it typed one: it goes to ``.env`` behind the entry's ``key_env`` through the
    credential lifecycle, and a key that *is* a mask is refused first of all, before anything else in
    the body is read or written. A body with no key — or an empty one, which is what the page hands back
    for a key it drew as a mask — leaves the stored key exactly as it is. A local server that takes no
    key is an endpoint Hermes holds too, and a new one may be saved without one.

    A new endpoint needs all three of its fields, and each has to hold something: a body short one of
    them is refused in a sentence naming all three. An edit needs none of them, but one it sends must
    hold something — a save that blanked an endpoint's name is refused rather than written. A base URL
    this host won't take is its own refusal, in its own words, which the route answers as a 400.
    """
    fields = body if isinstance(body, dict) else {}
    key = _typed_key(fields.get("key"))
    _refuse_preview(key)
    given: Dict[str, str] = {}
    for field in ("name", "base_url", "model"):
        value = fields.get(field)
        if isinstance(value, str):
            given[field] = value.strip()
    endpoint_id = str(fields.get("id") or "").strip()
    if endpoint_id:
        row, _ = _endpoint_of(endpoint_id)
        endpoint_id = str(row.get("id") or endpoint_id).strip()
        if any(not value for value in given.values()):
            # A field the body sent and left empty: an endpoint is these three, so there is no
            # `providers` entry to write without one.
            raise ValueError(_MISSING_FIELDS)
    elif not all(given.get(field) for field in ("name", "base_url", "model")):
        raise ValueError(_MISSING_FIELDS)
    else:
        endpoint_id = _slug(given["name"])
        _refuse_duplicate(given["name"])
    sent = {"id": endpoint_id, **given}
    for field in ("transport", "affinity"):
        # Only a string is the form saying what the setting is now. A field the body leaves out — or
        # sends null for, which is a client's way of saying it has none — is one the form didn't send,
        # and an edit that quietly cleared a transport a reader never touched would break the endpoint.
        if isinstance(fields.get(field), str):
            sent[field] = fields[field].strip()
    _write_entry(config_path, endpoint_id, fields=sent, key=key)
    # The host's list is read again here, unlike a key write's: an add's row and an edit's new name,
    # URL and model are only in the fresh list, and those are the rows the answer has to draw.
    return read(config_path)


def _refuse_duplicate(name: str) -> None:
    """Refuse a name whose id an endpoint already carries, in a sentence naming that endpoint.

    A new endpoint is filed under the id this host slugs from its name, and that id is what names the
    ``providers`` entry: a second endpoint whose name slugs what one is already filed under — ``Home
    box!`` and ``Home box`` are one id — would take over that one's entry rather than be added beside
    it. So the two are compared by id, each through the host's own slug, rather than by their words,
    which is the spelling the write itself would resolve. An edit names its own id and so never comes
    here: renaming an endpoint moves no entry.
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
    the key from ``.env`` behind the entry's ``key_env`` — one host writer for both, so the plugin
    composes no removal of its own, exactly as it composes none of an entry.

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
