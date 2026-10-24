# A prompt library entry is picked as a copy

Prompts lived only on the host, one per project, so a good one had to be retyped into every project
and every bot that wanted it. The library is the account's, not the host's: a `prompts` document in
the same encrypted sync store the bots live in, entries of a name, optional tags and body text, read
and edited from the project's prompt editor on any signed-in device, starting empty and shipping no
presets — the built-in default stays the host's default (ADR 0027).

The host can never read that document: sync is sealed with the account's data key, which the host does
not have, and the sweep runs with the app closed. So a pick is a **copy**: the app writes the entry's
text into the project's prompt over the route the plugin already serves, and the project also records
which entry it took. The prompt row then tells copy from original — an entry whose current text no
longer matches the copy shows an **Update** badge in front of the row's title, and tapping it asks in
a dialog before pulling the new text in; hand-editing the prompt clears the recorded source, so the
badge cannot lie about the user's own words; an entry deleted from the library leaves the copy
standing unbadged. A pick keeps the standing rule that a project's prompt and its workflow are
mutually exclusive.

## Considered options

- **A pointer the host resolves at run time.** Rejected: the host cannot decrypt the library, so a
  pointer would mean storing prompts server-readable outside the vault — trading the account's
  encrypted store for a weaker one to save one write from the app.
- **Pushing every edit to every pick.** Rejected: each open device would have to learn which projects
  point where and race the pushes at hosts. A pull on open gives the same freshness where the user is
  looking, with one write and no cross-device protocol.
- **A host-side library like the workflow library.** Rejected: that library lives per host, so
  "usable across bots and projects" would mean copying entries between hosts by hand — the very
  problem this library is for.
- **Seeding the default prompt as a preset.** Rejected: the default is the host's and moves with the
  plugin (ADR 0027); a copy of it in the library would quietly drift from the thing it was copied
  from.

## Consequences

- A new `prompts` document on the sync allowlist, merged per record like bots (tombstones included),
  with a Dexie table behind it. The library needs a signed-in account with the vault unlocked; the
  pick itself needs only a host with `afk_prompt` — no new host capability to read the library.
- `project_afk` gains `prompt_id`: a pick writes `{prompt, prompt_id}` together, a plain `{prompt}`
  clears the id, a workflow pick clears both prompt and source, and the whole library UI sits behind
  `afk_picks` with the rest of the change.
- The marker is a comparison, not a version: text that differs from the entry with that id is a
  changed entry, so nothing extra is stored or synced to know it. A pull that cannot reach the host
  toasts and leaves the marker in place.
