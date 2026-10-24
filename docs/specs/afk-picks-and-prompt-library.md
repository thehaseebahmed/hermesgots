# AFK holds several tasks per project within the bot's pick budget, with a prompt library synced across bots

Status: grilled 2026-10-23, every decision settled and recorded in ADR 0042 and ADR 0043, with the
glossary's *Pick budget* and *Prompt library* entries written alongside. Published as #505 with
tickets #506 to #512; the build order at the end is the tickets' shape when implementation starts.
#505 is blocked by the gate issue (#513) that the docs PR carrying this file (#504) closes — work
starts on that merge. The spec carries `ready-for-agent` and the tickets stay bare, so the agent
claims the spec and works the graph in order.

## Goal

AFK works a project's backlog one task at a time, so a project with ready tasks clears them serially
while the user is away, and nothing at the bot's own level bounds how many sessions its projects
together may open. A good prompt is stuck on the project it was written for — hosts do not talk to
each other, so the same instructions are retyped per project and cannot be carried to another bot at
all. A project gets a **pick count** (one to five, default one) and works that many tasks at once as
separate holds, each visible in the pop-up's Working list; the bot gets a **pick budget** (one to
ten, default five) shared across its projects, so the lower of the two numbers is what the bot
works and a freed place goes to the oldest ready task across the whole bot. The account gets a
**prompt library** — one per signed-in account, synced and encrypted with the bots — managed inside
the project's prompt editor, whose picks are copies carried to the host with their source recorded,
so a prompt row can show an Update badge that asks, then pulls the new text in.

## What this is not

- **Not ADR 0026's usage threshold.** It stays its own decision, landing later on this same tab,
  route and flag.
- **Not a bot-level prompt.** Prompts stay per project; the library is what is shared.
- **Not a change to the workflow library.** It stays behind its Developer setting; deprecating or
  moving it is a separate change, and a prompt pick clears a picked workflow exactly as today.
- **Not presets.** The library starts empty; the host's default prompt stays the host's default
  rather than an entry that drifts with plugin versions.
- **Not automatic propagation.** Editing an entry does not push into projects that picked it; the
  prompt row offers the pull where the change is visible.
- **Not a pointer the host resolves.** The host cannot decrypt the account's library, so it never
  reads it — the app carries the text across at pick time.
- **Not a shared or public library, and not variables.** One account's entries, plain text, no
  placeholders, no version history.
- **Not the implementation.** This spec, its ADRs and the glossary are what this pull request ships;
  the build is the seven tickets below, once it merges.

## Decisions

1. **A slot is the task** (ADR 0025 as written): the hold becomes a row in a holds table keyed by
   the task, `project_afk` keeps the switch and the workflow pick and gains the pick count, one pass
   fills every free place oldest first with starts serialized, lowering the count abandons nothing,
   a stalled hold keeps its place, giving a task back frees one row.
2. **The budget is the bot's** (ADR 0042): one to ten, default five, counted in holds once per pass
   before any GitHub read; effective ceiling is the lower of the project's pick count and the bot's
   remaining budget; a freed place goes to the oldest ready task across the bot; stalled holds
   count; lowering abandons nothing; a held-back sweep records a refusal on each skipped project,
   and the budget is answered on the project's read (the pop-up draws no usage line for now).
3. **One flag, one back-compat field**: `afk_picks` gates every new control (amending ADR 0026's
   reserved `afk_parallel`), and the project's read keeps answering `task` as the oldest hold so an
   app already shipped still draws its one Working row.
4. **A pick is a copy with its source** (ADR 0043): the app writes the entry's text through the
   prompt route the plugin already serves and records the entry's id; a plain write clears the id, a
   workflow pick clears both; the marker is a comparison of the copy against the entry with that id,
   so nothing extra is stored to know it; a deleted entry leaves the copy silent; a hand edit
   detaches the source; a failed pull toasts and keeps the marker.
5. **The library is the account's**, in the same encrypted sync document store as the bots: entries
   of client id, name, optional tags and body, merged per record with tombstones, managed inside the
   prompt editor (choose, save, rename, edit, delete), behind `afk_picks` and the prompt row's own
   conditions, with no migration for prompts already written.
6. **One schema bump** carries everything the change needs — holds, pick count, prompt source, bot
   budget row — so the migration lands once and each ticket wires what it needs.

## Where it lives

| Path | What it is |
| --- | --- |
| `plugin/store.py` | The holds table, the pick count, the prompt source and the bot's budget row, in one migration |
| `plugin/afk.py` | The sweep's fill, ordering and budget; each hold's lifecycle and stall clock |
| `plugin/__init__.py` | The project's read and write, the bot-level `afk` route, and the `afk_picks` feature |
| `app/src/components/afk.tsx` | The Working list, the count row, the pick count stepper and the budget line |
| `app/src/lib/bot-tabs.ts`, `app/src/routes/settings.tsx` | The Coding tab and its route segment |
| `app/src/components/afk-prompt.tsx` | The prompt editor with choose/save and the changed-in-library row |
| `app/src/lib/db.ts`, `app/src/lib/sync.ts`, a library module beside `workflow.ts` | The library's device table, its sync routine and its list/marker rules |
| `app/netlify/lib/docs.ts` | The `prompts` document's allowlist entry |
| `app/scripts/mock-hermes.mjs` | The mock's answers for the holds, budget and source-carrying writes |
| `app/scripts/e2e/afk-claim.mjs`, `app/scripts/e2e/afk-prompt.mjs` | The flows and their audit rows |
| `docs/adr/0042-*.md`, `docs/adr/0043-*.md`, `docs/adr/0025`, `docs/adr/0026`, `GLOSSARY.md` | The decisions and the vocabulary |

## Edges

- **An app already shipped** reads `task`, which stays the oldest hold: the sheet draws one row
  exactly as today, without the count row or steppers it cannot write.
- **A host without `afk_picks`** hides every new control; the library needs only `afk_prompt` for
  the pick itself, and is hidden with the prompt row's own conditions.
- **Signed out or vault locked**: the library is absent and prompt editing is today's textarea —
  picks already copied to hosts keep working either way.
- **A picked workflow**: a prompt pick clears it, as one write, unchanged rule.
- **A hand-edited prompt** loses its source id, so the marker can never call the user's own words
  stale; a pull restores text and source together.
- **Stalled holds count**, so five stalled tasks stop a budget-five bot — intended, and the refusal
  line is what says so; the place goes back only when the task does.
- **Lowering either number** abandons nothing; what runs finishes, the next claim waits.
- **Two devices editing one entry**: the per-record merge keeps the blast radius to that entry,
  last write wins with its tombstones.
- **A pull that cannot reach the host** toasts and leaves the marker, so nothing is half-applied.
- **A GitHub refusal or a full budget mid-sweep** are refusals like any other, each recorded on the
  project it held back, never on projects the pass did not reach.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Plugin tests** are the host's seam: the existing one-hold pin is rewritten to the new rule, and
  new cases cover a pass filling every free place oldest first, the budget capping claims across
  projects, stalled holds counting, lowering abandoning nothing, the refusal when the budget binds,
  and both prompt write shapes — with the suite's documented harness rules (commit every inserted
  row; plant the host modules imported lazily).
- **Unit tests** (no DOM, `node --test`) for the pure rules: which prompt row is marked, changed or
  not, deleted or silent, detached or sourced — following the existing pure-rule tests for
  pipelines, workflows and skills.
- **Component tests** over a seeded device database with the HTTP boundary faked: the multi-hold
  Working list with count row and stepper, the Coding tab's stepper, the library list with
  pick/save/delete, and the marked row with its pull.
- **End to end** for geometry only: the claim flow grows past its single Working row and the prompt
  flow grows the library, each asserted at phone and tablet widths in light and dark, with rows and
  verdicts in the audit — the mock mirroring the new shapes as it mirrors the prompt text today.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then every flow the change
touches, run by name. From the repo root: the plugin suite (`python3 -m unittest discover -s
plugin/tests -t .`).

## Build order

1. #506 — feat(afk): hold several tasks per project up to its pick count. Edge: none.
2. #507 — feat(afk): draw every hold in the AFK pop-up and set the pick count. Edge: 1.
3. #508 — feat(afk): bound a bot's holds by its pick budget across its projects. Edge: 1.
4. #509 — feat(bots): add the Coding tab that sets the bot's pick budget. Edge: 2, 3.
5. #510 — feat(afk): keep prompts in an account library and pick them into a project. Edge: 1.
6. #511 — feat(afk): show a picked prompt changed in the library and pull it in. Edge: 1, 5.
7. #512 — test(afk): prove the pick count, the Working list and the prompt library on screen. Edge: 2, 4, 6.

## Risks

- **The hold migration** is where an existing host breaks: a project row written before v40 must
  become exactly one hold, or a working claim is lost or doubled — pinned by a test that migrates a
  populated row.
- **The sweep ordering across projects** is new: the pass now sorts the whole bot's ready tasks, so
  a regression claims the wrong task first; GitHub's own claim marks are what keep a double claim
  impossible, and the ordering rule has its own test.
- **A stalled budget reads as a bug** if the refusal does not name it; the wording is the defence.
- **A marker that never clears** would nag forever — the hand-edit detach rule is the guard, and it
  is the unit test.
- **Mock drift**: the mock answers in the plugin's shapes, so every new shape must be mirrored there
  or the flows pass against a fiction.
- **A pop-up that grew twice** (list, count, steppers, budget line) has to still scroll cleanly at
  390px; that is exactly what the claim flow's width assertions are for.
