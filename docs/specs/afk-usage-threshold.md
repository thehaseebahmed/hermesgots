# AFK stops picking tasks up while the account is nearly out

Status: grilled 2026-10-30, every decision settled and recorded in
[ADR 0026](adr/0026-afk-stops-picking-up-when-the-account-is-nearly-out.md), which is amended in place
because its argument still holds and only its facts moved: the control's home, the flag that advertises
it, and the scope a window carries. The glossary's *Usage threshold* entry is rewritten alongside.
Published as #716 with tickets #717 to #719; the build order at the end is the tickets' shape when
implementation starts. The spec carries `ready-for-agent` and the tickets stay bare, so the agent claims
the spec and works the graph in order.

## Problem Statement

A user leaves their projects on and walks away. That is the whole point of AFK, and it is also the one
moment nobody is watching the account.

ADR 0026 decided the account is judged at the pickup, the glossary says AFK "stops picking up while the
bot's account is over its usage threshold", and neither is true of the code. Reproduced before this spec
was written: with every window of the account at 100% used, one sweep read the account zero times and
claimed the oldest ready task anyway, writing its label and its assignee; and the bot's own write route
answers a body naming only a threshold with "pick_budget must be a whole number from 1 to 10". So today
a project left on keeps claiming until GitHub runs out of ready tasks, whatever the account has left.

What the user sees when the account runs out mid-flight is not one failure but a scatter of them. Runs
fail or stall half-way, an issue keeps Gots's claim with a session nobody is working, a pull request sits
unfinished, and the sheet says a run failed rather than that the account was the reason. The stop the
documents promise is invisible in every place it could be seen: no control to set it, no figure to read,
no sentence naming it.

The gap is not a missing line of code. It is that the rule ADR 0007 wrote for the composer's notice —
which window decides whether the account can run — lives only in the app, and the sweep runs with the
app closed.

## Solution

One number for the bot: a **usage threshold**, a used share from 50 to 100, off until it is set, in the
bot editor's Coding tab beside Pick budget. It is one number over every project the bot serves, because
the account is one.

The sweep reads the account once per pass, before any project's frontier is read and only for a project
that could otherwise claim. A project whose deciding window is at or above the threshold claims nothing,
and its refusal line names the window, its percent and the threshold — in the host's own words, like
every other refusal. Everything already claimed runs to the end of its work: a prompt project's one run,
a workflow project's stages, a rewind's new round, a run the host resumes after dying.

The Coding tab's row says what the deciding window is at, so the stop is a thing the user can see coming
rather than a session that failed for no stated reason. When the account cannot be read at all — no key,
no fetcher for the provider, a provider that is down, an answer with no windows — the sweep claims as
usual and records nothing: a host that can't read an account is not a reason to stop working.

## User Stories

1. As someone leaving projects on overnight, I want AFK to stop claiming once my account is nearly
   spent, so that it does not burn the last of it on tasks it cannot finish.
2. As someone with one bot and several projects, I want the threshold to be the bot's single number, so
   that two projects cannot disagree about when the account is out.
3. As someone on their phone, I want the threshold on the bot's Coding tab beside Pick budget, so that
   the two numbers that bound a bot's work are in one place.
4. As someone who does not want the feature, I want the threshold off until I set it, so that a bot with
   no limit behaves exactly as it does today.
5. As someone setting the number, I want it to read as the share of the account already used, so that
   "80" means what the refusal sentence will later say.
6. As someone setting the number, I want only the whole tens from 50 to 100 to be reachable, so that the
   control is one tap and not a form.
7. As someone setting the number, I want Off to be a choice of the same control, so that turning the
   limit off is not a separate switch to find.
8. As someone opening the Coding tab, I want the row to say what the deciding window is at right now, so
   that I can tell a hold-back from a bug before it happens.
9. As someone whose project was held back, I want its refusal line to name the window, its percent and
   my threshold, so that I know what to wait for or change.
10. As someone whose account recovered, I want the next pass to claim again without touching the switch,
    so that the stop was a pause rather than a thing to undo.
11. As someone with a project that runs one prompt, I want it judged exactly like a project that runs a
    workflow, so that the kind of work a project does cannot decide whether the account is watched.
12. As someone with a staged task mid-workflow, I want it to carry on through its stages while the
    account is over the threshold, so that a half-done task is not stranded on an issue.
13. As someone with a task held and its session closed by me, I want the claim given back as it is today,
    so that the account never becomes a second reason a claim sticks around.
14. As someone whose run the host resumed after dying, I want the resume to happen regardless of the
    threshold, so that the stop applies to pickups and not to work already begun.
15. As someone whose provider is down, I want the sweep to claim as usual, so that an unreadable account
    does not silently stop every project.
16. As someone running a local or custom endpoint with no usage fetcher, I want the same fail-open
    behaviour, so that AFK works for me at all.
17. As someone with a spent Opus week and room on Sonnet, I want the model-scoped window passed over, so
    that a false alarm does not cost a project its work.
18. As someone whose account answers a balance rather than a period, I want a balance with room left to
    count as capacity, so that a spent allowance beside it is not read as the end of the road.
19. As someone whose bot is also at its pick budget, I want the refusal to name the budget, so that the
    most local reason wins and the account read is not spent to say it.
20. As someone whose workflow names a skill the bot no longer has, I want that stated ahead of the
    account, so that a broken pick is not hidden behind a temporary hold.
21. As someone with the app open, I want the row to answer what the host kept, so that a refused write
    never reads as saved.
22. As someone with an older plugin, I want the row to be drawn under the flag I already have, so that
    the plugin and the app stay one change.
23. As someone with several bots, I want each bot's threshold on its own host, so that one bot's limit
    never bounds another's work.
24. As someone reading the AFK pop-up, I want the same refusal line I already read for GitHub and for a
    lost skill, so that a spent account is one more reason in one place.
25. As a screen reader user, I want the threshold's control to announce its name and its chosen value,
    so that the row is usable without seeing the pills.
26. As a maintainer, I want the deciding-window rule in one place — the plugin — so that the sweep and
    any later reader cannot drift apart.
27. As a maintainer, I want the windows to carry the scope the account marked them with, so that the
    model-scoped skip is decided from data rather than guessed.
28. As a maintainer, I want one account read per pass however many projects the bot serves, so that
    five projects cost one read and not five.
29. As a maintainer, I want the check inside the pass's shared planning step, so that a later project
    kind cannot be added outside it.
30. As a reviewer, I want the amended ADR and the rewritten glossary entry in the same change, so that
    the document that promised this behaviour names where the control went.

## Implementation Decisions

**The number is a used share.** A whole number from 50 to 100, stored on the bot's own store beside the
pick budget, absent meaning off. The row reads it as used percent because that is what the refusal
sentence names and what the window's own percentage means; the app's composer notice keeps its
remaining-percent wording until a later change adopts this answer, and the two are not made to agree by
this spec.

**The check is at the pickup, inside the pass's shared planning step.** A project's pass settles the
holds its closed sessions gave back, checks its switch and its free places, then the bot's budget, then
a skill the profile has lost, and only then the account — so the account is read only for a project that
could otherwise claim. The threshold branch sits beside the lost-skill branch rather than inside it: a
bot whose projects all run one prompt reads no skills at all, and a check written inside that branch
would never run there. Nothing after a pickup consults the threshold: a stage's run is posted from the
stage machine, a rewind's round is posted from the same place, and a resumed run is the host's.

**The deciding window is ADR 0007's rule, moved into the plugin.** A window without a reset time is a
balance, and a balance with room left is capacity; otherwise the tightest window decides. A window the
account marks model-scoped is passed over, an absent or unknown scope is treated as deciding. The
provider is the profile's main model from the host's own configuration — the account a pickup's first
run will spend — not a chat's pick, not a held session's pin, and never a fallback provider. The read
happens once per bot per pass, under that home's own profile scope, and its answer is reused by every
project of the pass.

**The windows carry their scope, and the route answers the deciding window.** Serializing a window keeps
the scope the account marked it with, so the skip is decided from the host's own data rather than from a
label's wording. The usage route answers, beside the windows, the one window the pickup rule judged
deciding, or null where the account can still run — one rule with one owner, which the Coding tab and
the composer's notice can both read later.

**Fail-open, in one place.** No key, no fetcher for the provider, a provider that is down, an answer with
no windows, or a main model the host cannot name: the pass claims as usual and records nothing. A
project that was held back before keeps its line until a pass gets an answer, exactly as a stale GitHub
refusal does today.

**The refusal is the host's own sentence.** It names the deciding window, its percent and the threshold,
and leaves the switch on so the sheet shows it. A budget that is full and a skill that is lost are
stated ahead of it, because both are the user's own numbers and configuration and neither needs an
account read to know.

**The control is the Coding tab's, and it is made of segments.** Off, then 50 through 100 in tens, drawn
under Pick budget with the tab's own row pattern. It is advertised under `afk_picks`, the flag ADR 0042
established, because the two controls ship in one change. That is the one back-compat direction this
repo usually avoids: a newer app against an older plugin draws the row, and its write is refused with a
toast rather than the row hiding itself.

**No schema change.** The bot's settings are key-value rows in the store's own settings table, which the
pick budget already uses; a second key needs no version bump and no migration.

**Nothing else changes hands.** The switch is never turned off, no stage start is refused, no held task
is stopped, and the AFK pop-up gains no field: the threshold is the bot's, set and read on the Coding
tab, and the project's read carries it only so one read still answers both numbers.

## Testing Decisions

**The seam is the pass's planning step on the host, and the Coding tab in the component suite.** The
pickup rule is observable exactly where it acts — was the account read, was anything claimed, what does
the sheet say — and the plugin's own suite already fakes GitHub at that boundary, so the rule is tested
there with the account faked the same way. The app's half is a control and a line of text over a seeded
device, which the component tier already reaches for this screen; no browser flow is needed to prove
the rule, and the one flow that opens the Coding tab gains the row only because seven pills in a row are
geometry at phone width, which a DOM without layout cannot measure.

- **What a good test asserts here** is what a reader of the sheet or the tab can see and what the host
  did with a project: whether the account was read at all, whether the oldest task was claimed, what the
  refusal line says, what the row answers after a write. Not internal call order, not the name of a
  helper.
- **Host, the rule** — windows that are all periods pick the tightest; a balance with room left is
  capacity; a model-scoped window is passed over and an unscoped one beside it decides; an answer with
  no windows, no provider, or a raising fetcher claims as usual and records no refusal. Prior art: the
  usage serializer's own tests, which fabricate windows for exactly this kind of assertion.
- **Host, the pass** — a project over the threshold claims nothing and its refusal names the window and
  the percent; a project under it claims the oldest ready task; a project that runs one prompt and a
  project that runs a workflow are judged the same way, both covered, since the branch that would have
  skipped the check is the workflow one; the bot's budget and a lost skill are stated first; the account
  is read once for a pass over two projects; a held task's stage still posts while the account is over.
  Prior art: the sweep's own tests, which drive the pass through a faked GitHub and read the sheet back.
- **Host, the route** — the bot's write accepts the threshold alone and beside the budget, refuses a
  value outside 50 to 100 with a message naming the range, and answers the field on the bot's read and
  on a project's read. Prior art: the pick budget's route tests.
- **Component** — the Coding tab draws Off and the six tens, writes the choice, drops a refused write
  back to what the host kept, and draws the figure the usage route answered, naming the window. Prior
  art: the Coding tab's own test, over a seeded database with the bot route faked.
- **End-to-end** — `afk-claim` already opens the Coding page and reads the budget back on the wire; it
  gains the row, asserting the seven pills fit at phone width and that a tap on one is what the host
  answers afterwards. Its row and verdict in `docs/e2e-flow-audit.md` are updated with it.
- **Not tested at the browser tier**: whether a real provider's window is the one the user would call
  tightest. That is the host's fetcher and its own tests, and the sweep only reads its answer.

## Out of Scope

- The composer's limit notice adopting the plugin's deciding window: it keeps its own
  remaining-percent rule, and ADR 0026's consequence about it stays as it is.
- A threshold per project. The account is one.
- Stopping anything already begun: a held task's stages, a rewind's round, a resumed run.
- Reading any provider but the profile's main model's, and consulting fallbacks.
- Turning the project's switch off when the account is spent, in the app or on the host.
- A push notification, or any alert, when the account crosses the threshold.
- The pick budget's usage line in the AFK pop-up: the pop-up keeps its refusal line and gains no row.
- Any change to what a pickup claims, in what order, or to the claim label.

## Further Notes

- The reproduction that opened this work: with every window at 100% used, one pass read the account zero
  times, claimed the oldest ready task and wrote its label and assignee; the bot's write route refused a
  body carrying only a threshold. Both are what the first ticket's tests now assert against.
- The reason the rule moves rather than being copied: the sweep runs with the app closed, so a rule that
  lives in the app cannot stop a pickup. The composer's notice reading the same answer is a later
  change, named here so the second copy is deleted rather than extended.
- The scope skip is why the wire carries a window's scope at all. Without it, a spent Opus week would
  stop a bot running Sonnet, which is the false alarm ADR 0026 accepted a cost to avoid.
- `afk_picks` is reused deliberately. An app built from this change and a plugin older than it will draw
  the row and be refused; the alternative — a flag of its own — was considered and dropped because both
  controls ship together and the refusal is a toast rather than a broken screen.

## Tickets

- [ ] #717 — a project over the bot's usage threshold claims nothing, and names the window
- [ ] #718 — the Coding tab sets the threshold, Off first
- [ ] #719 — the Coding tab says what the account is at

## Build order

#717 is the rule, the setting and the route, and it gates both app tickets: nothing can be set or read
before the host carries the number.

#718 and #719 are the tab's two halves and go in order — the control that sets the number, then the line
that says what the number is up against. #719 could be argued into #718, and it is kept apart because the
figure costs an extra read on a screen that otherwise makes one.
