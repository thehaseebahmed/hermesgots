# Cluster B — the context window

Do this first: it builds `plugin/models_dev.py`, which cluster C's prices come from.

## Goal

The window a chat's context is measured against is a fact about the host's model, so the plugin resolves
it. The app stops resolving it from three sources and stops caching a copy per bot.

## What the code does today

The app (`src/lib/context.ts:19`) picks, in order:

1. `Profile.contextWindow` when it was written for the model the chat runs next (`heldFor`, `:33`) — a
   per-device cache.
2. Hermes's own window recorded with the session's latest call (`live.window`), when that call ran the
   model the chat runs now.
3. models.dev's `limit.context` for the chat's model, through `modelFacts` (`:28`).

`syncContextWindow` (`src/lib/models.ts:269`) fills that cache from models.dev's catalogue: it asks the
host for its model (`getModelInfo`), looks the window and the model's image input up in the **device's**
catalogue (`db.modelsDevCatalog`, a 24-hour cache the app keeps for the picker), and writes
`Profile.contextWindow` / `contextModel` / `imageInput` (`:274`, `:282-292`). It is called when a chat
opens (`src/routes/chat.tsx:381`) and when the bot editor saves (`src/components/bot-settings.tsx:212`),
and those three fields are synced fields (`src/lib/sync.ts:71-73`).

The plugin (`plugin/context.py`) already records, per session, the `post_api_request` hook's
`usage.prompt_tokens`, the `context_length` Hermes compresses against and the `model` that ran the call,
and `GET sessions/{id}/context` returns `prompt_tokens`, `context_length` (read by the app as `window`),
`model` and `model_changes`. So the middle of the app's three rules is already the plugin's; what is not is
the resolution — which model the window belongs to, and where it comes from before that model's first call.

## The contract

- **New module `plugin/models_dev.py`.** Fetches `https://models.dev/api.json` and caches it in
  `memento.db`. Verified shape (checked 2026-10-17): `{ "<provider>": { "models": { "<id>": { "limit":
  {"context", "output"}, "cost": {"input","output","cache_read","cache_write"}, "modalities": {...},
  "id", "name" } } } }`, 232 providers, ~3.5 MB. Model ids are the provider list's own; the app's matcher
  (`src/lib/model-match.ts::normalise` / `sameModel`, re-exported by `models.ts`) is the reference for how
  a Hermes model string ("anthropic/claude-opus-4.8", "us.anthropic.claude-opus-4-8-v1:0") maps onto one.
- **Cache table.** `models_dev (id TEXT PRIMARY KEY, data TEXT, etag TEXT, fetched_at INTEGER)` in
  `plugin/store.py`, `SCHEMA_VERSION` 22 → 23. One row, `id = 'catalog'`, mirroring the app's
  `ModelsDevCatalog` (`app/src/lib/db.ts:424`: `{ id: "catalog", data, etag, fetchedAt }`) and its
  freshness window (24 hours; reuse the etag with `If-None-Match` and accept a 304 as fresh). Read the
  existing tables in `store.py` for the house style — a guarded `CREATE TABLE IF NOT EXISTS` block under
  the version bump.
- **Never raise.** A fetch failure, a timeout, an unparseable payload or a model the list doesn't have is
  *no window*, not an error: the route answers what Hermes recorded and leaves `window` null. Log at
  `logger.debug(..., exc_info=True)`, the idiom across `plugin/` (`plugin/__init__.py`, `clarify.py`).
  Mirror `plugin/research.py`'s urlopen use (urllib, a 20s timeout, a size cap) rather than adding a
  dependency.
- **`GET sessions/{id}/context` resolves.** `window` becomes the resolved figure rather than only
  `context_length`: Hermes's recorded window when it belongs to the model the chat runs next, else
  models.dev's `limit.context` for that model, else null. Feature flag `context_window` in `info`'s
  `features` (`plugin/__init__.py:237`).
- **One open design point.** The route has to know *which* model the chat runs next, because the recorded
  row names the model the last call ran. The app knows it (`Conversation.modelChoice`, else the bot's
  model) and the plugin knows the bot's configured model (`host_model`). Recommended: an optional
  `?model=<provider/model>` on the route, sent by the app with what it will run, falling back to the
  session's last recorded model, then to the profile's configured one. Whichever is chosen, keep the app's
  current *intent*: a model switch shows its own window before that model's first call lands.

## Steps

1. `plugin/models_dev.py` + the `models_dev` table + `SCHEMA_VERSION` 23, with tests (`plugin/tests/`, the
   style of `test_usage.py`: stub the fetch, assert a 304 keeps the cached row, an unreachable host is
   `None` and never raises, a model resolves through a Hermes-style id and an unknown one doesn't).
2. `plugin/context.py`: resolve the window; keep the recorded fields exactly as they are for the app's
   usage sheet.
3. The route and the `context_window` flag.
4. App: `src/lib/context.ts` collapses — `contextWindow()` keeps only what the plugin sent (or goes
   entirely, with `Conversation.liveContext.window` read straight through in `src/routes/chat.tsx:364`).
   Delete the models.dev branch and `heldFor`.
5. App: `syncContextWindow` dies, **but `Profile.imageInput` must survive** — it is what greys out the
   camera and photos (`imagesAvailable`, `src/routes/chat.tsx:916`, `src/routes/bot-threads.tsx:296`) and
   what `share.tsx:175` checks, and it comes from the same catalogue lookup. Keep a smaller
   `syncImageInput(profile)` doing only that (the app keeps its own models.dev fetch for the picker by the
   ADR's considered options), or move it with the rest — do not silently drop it.
6. App storage: drop `Profile.contextWindow` and `Profile.contextModel` (Dexie bump, upgrade clearing the
   fields, and remove both from the synced list in `src/lib/sync.ts:71-73`; `imageInput` stays synced).
   `Conversation.liveContext.window` keeps its shape — it now always comes from the plugin.
7. Mock: `app/scripts/mock-hermes.mjs` resolves the window the same way (its context route is at `:1721`,
   and the run's `context_length` is hard-coded to 200000 at `:992`), and its `features` list (`:1397`)
   gains the flag. Flows that read the Context ring or a model switch (`pnpm e2e model-switch`,
   `draft-mode-sync`, `screens`) must still pass.
8. Docs: the context paragraph in `AGENTS.md` ("A chat's context use needs the Gots plugin" — its "The
   window the bot holds for the model shows first, then Hermes's for the call that ran it, then
   models.dev's" sentence is the one that becomes untrue), the `src/lib/context.ts` layout row, and
   `plugin/README.md`'s context route line. Delete this cluster's entry from `fixes.md`.

## Pitfalls

- **The plugin is not the app's catalogue.** The plugin fetches models.dev for windows (and C's prices);
  the app keeps its own fetch for the picker's cost tiers, modalities and limits. Two consumers, one public
  payload — deliberate, per the ADR. Do not try to unify them, and do not let the plugin's cache become
  the app's.
- **The bot's model is not always the session's.** A chat can run a model of its own (`Conversation.
  modelChoice`), so resolving from the profile's configured model alone shows the wrong window.
- **Every failure mode resolves to no window.** No plugin, an older plugin, no recorded call, a model the
  catalogue lacks: each is a null window, and the usage sheet draws an empty bar under its "the plugin is
  needed" banner exactly as it does today.
- The models.dev payload is megabytes: cache it, cap the read size, and never fetch it inside a request
  that a screen waits on (a background refresh or a cache miss resolving to null is fine).
