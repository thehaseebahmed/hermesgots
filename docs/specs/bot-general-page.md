# A bot's General page is its own Hermes's General tab, and the page it replaced leads the bot's page

Status: settled in this change, recorded in ADRs 0104 (the page), 0105 (an edit's bar) and 0106 (the
bot's page).

## Goal

Settings > Bot > General becomes a mirror of the bot's own Hermes: the keys its Dashboard's Config >
General tab holds — `toolsets`, `max_live_sessions`, the session timeouts, `timezone`, the update
settings and the rest — read from the host's own schema and written one key at a time. What the page
General showed before — the bot's switches, its profile and its connection — moves up onto Settings >
Bot itself, which leads with the bot under _Bot_ and follows with every setting page in one card
under _Settings_ (ADR 0106). `/general-old` remains as an address that redirects.

## What this is not

- **Not a second writer for a key another page owns.** `model` and `fallback_providers` are drawn as
  the page's lead rows, as Hermes's own tab draws them, and their taps go to the routes that set them
  through Hermes's writers. `model_context_length` is a host key the page writes like any other.
- **Not the Dashboard's form.** No field sits in a row: a switch acts in place, a value opens its
  edit, a pick opens its sheet (ADR 0055).
- **Not a settings list written in the app.** The rows come from the host, so a Hermes release that
  adds, renames or files a key changes the page without an app release.
- **Not a schema change.** Nothing new is stored on the device: the page reads and writes the bot's
  Hermes, and no Dexie version moves.
- **Not a rename of the old page's rows.** The bot's own rows are drawn as they were drawn on the
  page they came from: same switches, same values, same three edits, at `/settings/bots/<id>/bot/…`.
- **Not a Designer or Developer surface.** It is drawn for every bot whose plugin carries the read.

## Decisions

1. **The host answers the page.** `GET /api/plugins/memento/general` answers `{ fields, values,
defaults }`: each field as `{ key, kind, section, options?, searchable?, restart?, note? }`, with the
   dotted path exactly as Hermes spells it. The fields are the host's schema for the Dashboard's
   General category, minus the keys with a shape this page can't write back.
2. **A write is one dotted path.** `POST …/general` `{ key, value }` writes through Hermes's round-trip
   YAML writer, so comments, order and every key the page doesn't model survive; `null` clears the key
   and the host's default takes over. A key the read didn't offer, or a value of the wrong shape, is a
   400 with its own sentence and the file is untouched. The answer is the whole fresh block.
3. **Two keys say the host only reads them at startup** (`max_concurrent_sessions`, `timezone`), in the
   edit itself, so a write that appears to do nothing reads as the host's own timing.
4. **The cards are the host's sections**, captioned as the host files them, and the page's own card
   carries no caption. A key's section is its first segment, which is the rule the Dashboard's own
   renderer groups by.
5. **A row reads the effective value**: what the file holds in the accent colour, else the host's
   default in the muted tone. A list reads as its entries, a pick in its own words, a switch as its
   state.
6. **General is gated on `general_page`**, and a withheld page lands on the bot's own page — the one
   screen every bot has, which asks the host for nothing.
7. **The bot's own rows lead the page** under the caption _Bot_: the switches, then _Bot Profile_
   (name, image, Test connection), then _Hermes_ (address and key), each edit at
   `/settings/bots/<id>/bot/<edit>`; the settings follow in one card under _Settings_ (ADR 0106).
8. **An edit's actions are one bar** — Cancel, a hairline, Save, or Reset and Save where the form can
   clear its key, since going back is the cancel — and the field above it is a filled pill with its
   label in the muted tone. Only the pushed screen asks before discarding (ADR 0105).

## Where it lives

| Path                                                                 | What it is                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `plugin/general.py`                                                  | The page's read and write: the host's schema filtered, the values it holds, one dotted path written |
| `plugin/__init__.py`                                                 | `GET`/`POST …/general`, and the `general_page` feature in `info`                                    |
| `app/src/lib/general-settings.ts`                                    | The table the page draws the host's answer through: kinds, captions, labels, drafts                 |
| `app/src/lib/settings-values.ts`                                     | The readings the speech page and this one share                                                     |
| `app/src/components/bot-settings.tsx`                                | The bot's page, the General page, and the fallback that keeps a withheld page off itself            |
| `app/src/components/settings-chrome.tsx`                             | `FormActions` and the restyled `EditForm`                                                           |
| `app/src/lib/bot-tabs.ts`, `bot-subs.ts`                             | The bot page's segment and its three edits; `general-old` as a redirect; General's keyed edits      |
| `docs/adr/0104-a-bots-general-page-is-its-own-hermes-general-tab.md` | The page's decision                                                                                 |
| `docs/adr/0105-an-edits-actions-are-one-bar.md`                      | The form's decision                                                                                 |
| `docs/adr/0106-a-bots-page-is-what-the-bot-is-then-its-settings.md`  | The bot page's shape                                                                                |
| `GLOSSARY.md`                                                        | **Bot page**, the clause on **Hermes setting**, and **General old** as an address                   |
| `AGENTS.md`                                                          | The settings rules: captions by subject, and an edit's bar                                          |

## Edges

- **A host whose plugin predates the read** — no `general_page`, so General is withheld, its row is
  not drawn, and `/general` lands on the bot's own page.
- **A host that doesn't answer at all** — the read's address stands, and the bot's own page is drawn
  while the app holds no answer.
- **A host whose Hermes has no schema** — 501, and the page is withheld as above.
- **A key the file holds at its default** — the row reads the host's default, muted, and its edit
  leads with _Reset_, which clears the key.
- **A read that fails** — a banner with the host's own sentence and no rows: nothing is written from
  a read nobody made.
- **A refused write** — the host's sentence in a toast, and the row as it was.
- **An address naming a key the host doesn't hold** — the page goes back to itself.
- **An old bookmark into `/general/name`** — a key that host doesn't hold, so it lands on General.
- **An old bookmark into `/general-old`** — the bot's page, by redirect.

## Tests

- **Unit** — `scripts/test-general-settings.mjs`: the fields kept and dropped, the cards and their
  captions, a key's title, an effective value's three shapes, a draft's write.
- **Component** — `scripts/test-bot-general-page.tsx`: the host's rows and their cards, a value held
  and a value at its default, a switch's write, an edit's write and its reset, a pick's sheet and its
  search, the restart note, a refused write, a failed read, and a host without the page landing on
  the bot's own page. Plus the ported suites: `test-bot-settings-list.tsx` (the bot page's shape and
  its rows), `test-bot-page.tsx` (the bot's own cards and their edits), `test-bot-models-and-chain.tsx`
  (the model and the chain, where General holds them), `test-bot-coding-tab.tsx`,
  `test-bot-dictation-tab.tsx`, `test-skills-tab.tsx`, `test-bot-delete.tsx`.
- **Plugin** — `plugin/tests/test_general.py`: the rows are the host's, the None-defaulted kinds, the
  values only the file holds, the sections, the restart flags, one dotted write with its siblings
  intact, a null that clears, and every refusal before the file is touched.
- **End to end** — `bot-settings` and `mcps-gate` by name: the list's cards and General's pane, and a
  withheld MCP page landing on General.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`; `bot-settings` and `mcps-gate`
by name. From the repo root: the plugin's suite.
