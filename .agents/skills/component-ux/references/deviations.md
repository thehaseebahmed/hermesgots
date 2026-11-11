# Deviations and exceptions

Two lists, both settled. Nothing goes in here as "noted".

- **Exceptions** are deliberate departures, each with the surface it applies to and the decision
  behind it. If a review finds one, the review is done.
- **Open** are findings from an audit that still need a verdict. Each carries the one it should get;
  when it is fixed, the entry is deleted rather than ticked.

Re-running `scripts/audit.mjs` after a fix should move an entry out of **Open**, never add a second
copy of it. An entry that is still Open after two audits is an exception nobody has admitted to.

## Exceptions

| # | Surface | The departure | Decided by |
| --- | --- | --- | --- |
| E1 | A bot's chat list, its foot | The pick is two pills stacked above the button, not a `Popup` — the one place a pick from a button skips the sheet | ADR 0141 |
| E2 | A reply's work rows | Thought, tool group and status line stand 29px tall, not 44px | ADR 0058 |
| E3 | Sync recovery | A form inside an `AlertDialog`, where one step's answer is what the next step shows | ADR 0005 |
| E4 | A room's other members | `ui/bubble` with `variant="outline"`, not `UserBubble` — it is someone else's words, not the reader's | ADR 0115 |
| E5 | A pull request's state icon | `animate-spin` on the icon while checks run: the icon reports the PR's state, it is not a loader | `chat/pr-look.ts` |
| E7 | `Screen`'s header | The settings chrome keeps its own sticky header. Whether it becomes `ChatHeader`'s pinned form is undecided; until then it is the one bar outside ADR 0140 | open question |
| E8 | A dialog that is not a yes-or-no | A reminder (`break-reminder-provider`), a permission question (`canvas-consent`), a one-action notice (`account-settings`), a three-way exit (`session-leave`), a one-field form (`rename-dialog`), the recorder's keep-or-end question (`routes/meetings.tsx`): each says so in its own file | — |

## Open

### N2 — Three empty states, no component

`routes/projects.tsx:110-111`, `routes/meetings.tsx:213-214` and `routes/code.tsx:109-110` draw the
identical disc-and-sentence: `flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6
text-center` around `size-16 … rounded-full bg-primary/10 text-primary`.

**Verdict: make it a rule.** Extract `EmptyState` (icon, one sentence, one optional action) and use
it in the three; `components/chat/empty-states.tsx` keeps the thread's own two states, which are a
different thing (a blank chat, a bot's face) and are allowed to differ.

### N3 — Sixteen page columns

`mx-auto flex w-full max-w-2xl …` is typed 16 times across `routes/research.tsx` (3),
`routes/projects.tsx` (2), `routes/meetings.tsx` (4), `routes/code.tsx` (2), `routes/canvas.tsx`,
`routes/routines.tsx`, `routes/bot-chats.tsx`, `components/settings-chrome.tsx:97`. ADR 0114 fixed
the number at 672px; nothing holds it.

**Verdict: make it a rule.** `PageColumn` (the width, the gutters, the foot's safe area) exported
beside `Screen`, which uses it too. Then a screen cannot pick its own measure.

### N4 — The card's radius is a class, not a token

`ui/card.tsx` ships `rounded-2xl` (16px); `DESIGN.md` says a card is `rounded.3xl` (24px). Six
callers pass `className="rounded-3xl"` to correct it (`routes/routines.tsx:185,256,379`,
`routes/bots.tsx:21`, `routes/settings.tsx:879`, `components/account-settings.tsx:82`), and 18
places skip `Card` entirely and write `rounded-3xl border bg-card` by hand (`components/research.tsx`
×4, `components/compare.tsx` ×2, `routes/research.tsx` ×3, `routes/meetings.tsx` ×3, others).

**Verdict: make it a rule, then fit it.** `ui/card`'s default radius becomes the app's 24px once, the
six overrides go, and the ad-hoc surfaces become `Card`. The alternative — an app-level `Panel` that
wraps `Card` with the right radius and padding — is a bigger change for the same result.

### N8 — A ring spinner in the todos pill

`chat/todos.tsx:99` draws `size-5 rounded-full border-2 border-muted border-t-primary
motion-safe:animate-spin` — a loader painted with two borders, while `ui/spinner` has 37 callers.

**Verdict: fit it.** `Spinner` at the pill's size. The PR icon's spin is E5 and stays.

### N9 — One dead primitive

`components/ui/toggle-group.tsx` has never been imported. (`skill-sheet.tsx` went with the pick-row
round, ADR 0142.)

**Verdict: delete it.** A component nobody calls is a component nobody keeps true.
