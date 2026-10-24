# The audit of the end-to-end flows

Every key in the end-to-end registry (the `FLOWS` map in `app/scripts/e2e/cli.mjs`) gets one
verdict here — **stay**, **component**, **plugin** or **delete** — with what the flow asserts
today, why it moves or stays, and what replaces it. This is the committed record #297's plan calls
for, delivered by #299: a flow leaves the registry only once its replacement is green, so this
page records where each assertion goes rather than claiming it has already arrived.

Every verdict applies one rule — a test belongs to the cheapest tier that would fail for the
reason the change can fail — from ADR
[0019](adr/0019-a-test-belongs-to-the-cheapest-tier-that-would-fail-for-its-reason.md), which owns
what the tiers are along with `AGENTS.md`'s Testing paragraph. This page records only which one
each flow lands in: **stay** (end-to-end), **component**, **plugin** (the plugin's own Python
suite), or **delete** (a duplicate another flow already asserts). The end-to-end skill points here
once it is rewritten for the stays (#317). The counts describe the registry at this commit; the
ticket that lands a family edits its own rows.

## The arithmetic, and how to check it

The registry in `app/scripts/e2e/cli.mjs` holds **70 keys**, and every one of them has a row
below. `pnpm e2e list` prints the same 70 keys, and the rows here are grouped by the ticket that
takes them rather than by the registry's order, so the count is the thing to check:

| Verdict | Keys |
| --- | --- |
| stay | 12 |
| component | 53 |
| plugin | 2 |
| delete | 3 |
| **total** | **70** |

Of those 70, 64 keys point at a script under `app/scripts/e2e/` (one of them, `todos-legacy`,
reuses `todos.mjs`, so 63 distinct files there) and 6 point at the older
`app/scripts/regression-*.mjs`.

#297's plan counted **60** keys and split them **48 component / 7 stay / 3 delete / 2 plugin**.
Two things in that arithmetic did not hold, and both are checkable:

- Its clauses name **59** keys — 53 pointing at `app/scripts/e2e/` and 6 at the older
  `regression-*.mjs` — and its sixtieth is `todos-legacy` counted a second time, as "one registry
  key reusing another's script" rather than as the 53rd of the first group, which it already is.
  Today's 63 keys under `app/scripts/e2e/`, less the ten that arrived since, are those 53.
- It left out goal mode's two keys, `goal-wizard` and `goal-pill`, which the registry still held
  when the plan was written: the commit before they left, `8a4e842^` (#282's `1b98896`, merged
  before the plan), carries 61 keys. Both went with goal mode (#296), so that omission costs
  nothing today.

Eleven keys have arrived since: five are components by the same rule — `delegation-model` (#318),
`afk-skills` (#327), `afk-stage` (#328), `pipeline-pill` (#330) and `afk-prompt` (#359) — and five
are stays, for what no lower tier can watch: `thinking-line` (#368), the app's line following a
host's own reasoning as it arrives; `openui` (#389), an interface's geometry at two widths and a
scroll offset a patch must not move; `openui-map` (#490), a map's fitted geometry and the gesture
contract deciding whether one finger scrolls the thread or pans the map, both things a DOM without
layout has not got; `question-during-delegation` (#471), the question card taking the composer's
place while a subagent still runs, with its result and its wake turn landing after it; and
`card-widths` (#497), because a card's width and the offset of the column beside it are geometry,
which no DOM without a layout engine has. The eleventh, `bot-threads` (#422), is a component by the
same rule as the five: every rule it walks — a card's place in Main, `/thread` with text, the
marker a moved message keeps — is a component test's, and what the browser adds is that they
compose. So the registry holds 59 + 11 = **70** keys, the component verdicts are the plan's 48 less
the key it counted twice, plus those six: **53**, and the stays are the plan's 7 plus those five:
**12**.
#299's own criterion still says 48; the 53 above
supersedes it for the reason just given, and nothing else in the ticket's split moves.

`app/scripts/test-e2e-registry.mjs`, a unit test, holds the registry and this page to each other:
a key with no row here, a row with no key, a verdict outside the four, a count in the table above
that its rows don't add up to, or a stay beyond the eleven fails the app's gates. A new flow is then
an argument this page has to carry, never a default (ADR 0019).

Check any of it in one line:

```bash
grep -c '^| `' docs/e2e-flow-audit.md                           # 70 rows, one per registry key
grep -c '^| `[a-z0-9-]*` | stay |' docs/e2e-flow-audit.md      # 12
grep -c '^| `[a-z0-9-]*` | component |' docs/e2e-flow-audit.md # 53
grep -c '^| `[a-z0-9-]*` | delete |' docs/e2e-flow-audit.md    # 3
grep -c '^| `[a-z0-9-]*` | plugin |' docs/e2e-flow-audit.md    # 2
cd app && pnpm -s e2e list | wc -l                             # 70 keys in the registry
git show 8a4e842^:app/scripts/e2e/cli.mjs |
  sed -n '/^const FLOWS = {/,/^}$/p' | grep -c '^  [a-z"-]*: {'  # 61, before goal mode left
```

## The verdicts

Each family below is the ticket that takes it. The **What replaces it** column states the test the
demotion produces: a key is deleted in the change that writes that test.

### Chat, a reply and a failure — #306

Six keys, one family: what the composer sends, what the thread shows of a turn, and what a send or
a turn that fails leaves behind.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `chat-message` | component | A new chat sends `hello there`, gets a reply with text, and the chat is listed under Recents. | A send, a streamed reply written into Dexie and a list row: the app's own wiring over an HTTP boundary a handler fakes. | A component test sends from the composer over a handler that streams a reply, then asserts the reply settles `done` and Recents holds the chat. |
| `plain-error` | component | A turn that fails before it says anything reads as a marked error line on the page with no bubble or picture — the way every reply is drawn now — while the reply above it is on the page too. | Which row a failure takes is a render over the host's own error. | A component test asserts a reply, a chat's and a session's alike, is on the page with no bubble and no picture (`test-thread-rendering.tsx`); the flow keeps the landed reply drawn on the page without one, and the failed turn's own mark. |
| `failed-send` | component | A send nothing reached stays dimmed like a queued message, wears a mark, says only that it didn't go, can be sent again with what it held or taken back, outlives a reload, and sends are refused meanwhile. | The failed row's state and its two actions are device state; the reload is Dexie's persistence, which a remount reaches. | A component test asserts the row's state and its two actions, and that it shares the queued row's own class tokens rather than a computed colour. |
| `submission` | component | Two sends racing in one chat start one run and get one reply. | A guard in the send path: the same call twice without awaiting is the whole condition. | A component test calls the send path twice without awaiting and asserts one request and one reply row. |
| `approval` | component | A session's approval waits in the sidebar's Waiting for input and Code's Waiting on you, and both move it under Today once it is allowed — with the three panes it also checked at 1440px. | Two renders from one plugin answer; only the three-pane layout it checked is beyond a DOM. | A component test renders the sidebar and Code over a seeded waiting session, asserts both waiting lines, and both lists under Today after the answer; the three-pane layout is the snapshots'. |
| `approval-missed` | component | An approval the host timed out dismisses itself, and an answer refused with `approval_not_pending` marks the approval missed even while the run status still shows the old request. | Two clearing rules against the host's own error and a stale run status: no wall clock the browser supplies. | A component test drives a timeout and a refused answer against the host's error plus a stale run status, asserting the slot clears and is not re-raised. |

### A thread and its history — #307

Eight keys, one family: what a thread derives from a transcript or a run's events, and what a chat
looks like after a model change, a compaction or a page of history.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `todos` | component | The todo list shows above the composer while the reply that wrote it still runs, from the run's events and, on a host whose events the browser can't read, from the transcript — one script under two keys, this one and `todos-legacy`. | A derivation from a run's events and from a transcript, with a pill's render on top. | One component test with two legs — a change stream carrying todos, and a transcript-only host carrying the same — asserting the running turn's tool list beside the pill (#307). |
| `todos-legacy` | delete | The same pill read from a transcript, on a host whose event stream the browser can't read. | It is `todos` run against the legacy mock: one claim under two registry keys. | The second leg of the todos test, which #307 writes as it deletes this key. |
| `photo-progress` | delete | A message sent with a photo shows its reply's tool calls while it runs, on a host the browser can't read the events of. | It asserts the running turn's tool list from a transcript — the derivation the todos test owns; the photo is the mock's keyword, not the claim. | The tool list in that same leg. |
| `model-switch` | component | A chat's model pill picks a new model, and the thread draws one divider naming it above the turn it answered with — after a reload, in a project session, and as a turn opens where the host's record hasn't reached the device. | Where a divider sits is a pure placement rule (`model-changes.ts`) drawn over a rendered thread. | A component test asserts one divider above the right turn, over a seeded record plus a turn this device sent; the placement rules stay unit tests (`scripts/test-model-changes.mjs`). |
| `history-pages` | component | A session opened here mid-turn from another device loads its newest turn whole, Load earlier pages back a whole long turn twice, the running reply stays one reply at the end, and a chat an older version split at the page edge is mended by its next Load earlier. | Merging paged transcripts: a reconcile over rows, and the render that shows each turn once. | A component test fakes paged transcript handlers and asserts whole turns, the running reply once, and the mended chat; the reconcile stays a unit test where it is pure. |
| `history-generations` | component | A session compacted on the host while this device already showed its turns ends with each turn once, not the whole sequence twice, and the carried turns land around the messages sent since. | A dedupe over rows Hermes re-emits under fresh ids. | A component test over a handler that re-emits carried turns, with the reconcile rules as unit tests. |
| `compressed-live` | component | The device that sent the turn, compressed mid-run: the reply reaches its end, picks up again after a reload, and comes down on Stop — while the host keying that broke on a real host is the plugin's, pinned by `plugin/tests/test_session_run_keying.py`. | The app's side of a rotating session id is a stream handler's behaviour, not layout — but a real cancellation on a real host under that rotation is not reproducible here. | A component test streams a turn whose session id rotates, asserting the reply finishes, a remount resumes it, and Stop's request carries the rotated run; the real host's cancellation is the loss recorded below (#307). |
| `pipeline-pill` | component | A staged task's session carries its pipeline as the first pill above the composer — three bars, green where a step is done and red where it failed, with the stage in words — and its sheet counts the stage out of three and names what each step ran, still there once the task is done. | A pill and a sheet drawn over the host's own record — bars, words and counts, not geometry or a rate — with `pipeline.ts`'s verdict rules already unit tests (`scripts/test-pipeline.mjs`). | A component test renders the pill and its sheet over seeded pipeline records for each stage and a failed one, asserting the bars, the words and the sheet's counts. |

### The ask-the-user card — #312

Three keys become one test: the four outcomes a card can read back, an answer that survives stale
reads, and a question whose window closed.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `clarify-polling` | component | An answered question survives two stale transcript reads, the turn's completion and a reload. | The settle rule over stale rows; the reload is a remount. | The one clarify test (#312): an answered card after two stale transcript reads and a stale run status. |
| `clarify-transcript` | component | A fresh transcript reads as Answered, No answer, Not answered or Skipped, with the answers the card holds. | A mapping from a tool row to a title and its answers, plus a render. | The same test: the four outcomes (the mapping itself a unit test), single- and multi-select answers, on one shared fixture. |
| `clarify-missed` | component | A question whose window closed stays as a No answer card with the question it asked, and Ask again starts a new turn that asks afresh. | The expired card's render and its retry wiring; nothing resumes the expired call, so no host behaviour is at stake. | The same test: an expired card offers Ask again and sends a new turn. |

### The composer — #308

Four keys demoted and one deleted: the slash menu, drafts, dictation with a stubbed recording, and
a reply's images holding their place.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `slash-skills` | component | The composer's `/` menu lists the bot's skills from the plugin rather than Hermes's `/v1/skills`, keeps the list on the device, opens on a slash that begins any word, and lands a picked skill where the caret is, with a space to keep typing — at a laptop width in light and a phone in dark. | A token rule, a cached list and an insert, all the app's; only the menu's height rules are beyond a DOM. | A component test over a seeded skills row asserts the list, a mid-word slash opening it, and the insert on pick; the token parsing and the insert's text stay unit tests and the height cap goes to the snapshots. |
| `drafts` | component | A composer's unsent text is kept per chat and cleared on send. | A device row read per chat. | A component test types in two chats, asserts each keeps its own text, and that a send leaves none. |
| `dictation` | component | Dictation in a real browser over the mock: pieces cut at the pauses, sent while the voice carries on and landing tidied at the end with the bot's word on both the clip and the cleanup; a take kept across a reload and retried; a take refused, by a recorder that errored mid-take or a track the device ended, and a host that can't take one, its reason on a tap; a tap that doesn't land on the bar; and the Dictation tab's word and model read back after a reload — with Chromium's fake microphone standing in for a real one. | Every ending is a state machine over a stubbed `MediaRecorder` — Stop, Send, Cancel, a cleanup that fails, answers junk or hangs, a clip the host never answers, one take per profile (`test-dictation-ending.tsx`, `test-dictation-failing.tsx`, `test-dictation-kept-offer.tsx`) — and the pause-cut points are a pure rule. | Those component tests assert the pieces land in order, a failed piece retries, a take ends tidied or raw inside its wait, the recording is kept until its text is in, and the mic is absent without the host; the cut points stay unit tests. The flow stays as the one proof that a real `MediaRecorder`, the mock's own answers and a real reload compose. |
| `image-skeleton` | component | An agent's images hold their place with a skeleton while they load — in a chat and in a project session — give way to the image or to the tag's text, and a lone image takes the same cell as one in a group. | A placeholder's lifecycle over a seeded reply, with the media route's answers faked. | One component test asserts that lifecycle and absorbs `image-viewer`'s opened-photo leg (#308); the cells' reserved sizes go to the snapshots. |
| `image-viewer` | delete | A photo opened from a message holds its place while it decodes, then paints — at a fifth of the page's normal speed, so the placeholder is catchable. | A duplicate of the placeholder lifecycle the image test owns; the slowdown is the flow working around the browser, not a claim. | The opened photo's placeholder becomes the image test's second leg. |

### Settings, sync and usage — #309

Seven keys: what the app says about a bot's limits, a session's outputs and pull requests, a
draft, and the two recovery-code screens.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `usage-limit` | component | The notice follows the account — quiet with credits, warning near a limit, out without — a dismissal doesn't outlive the state it dismissed, the reset counts down in words, and the Usage sheet names the model in a row above its meter. | A choice over the account's windows plus a render; the choice and the reset text are already pure (`provider-usage.ts`). | A component test over seeded windows asserts the notice's choice and its words; the choice and the reset text stay unit tests, and the banner's responsive form goes to the snapshots. |
| `outputs` | component | The outputs pill counts a session's filed files and pull requests, and opens a drawer with the session's pull requests — live and finished, newest first — and the Library's tree restricted to its own folders, as a sheet on phones and a drawer from 1024px. | List composition and two tabs drawn from the host's answers; the sheet-or-drawer choice is `usePopupDrawer`, not geometry. | A component test seeds the outputs and asserts the pill's count and both tabs; the drawer drawn as a sheet goes to the snapshots. |
| `prs` | component | A shipped pull request lists in its project's Pull requests tab, and a host that can't reach GitHub keeps the ones the app already knows instead of storing none over them. | A failed read and what the store keeps when one fails. | A component test answers the read with an error and asserts the known rows survive, then with a list and asserts it renders. |
| `recovery-code` | component | Setup always issues a recovery code, offers the passkey only beside it, writes nothing before the code has been copied, and gates Continue on that copy; a passkey that can't be made is a quiet choice to go on with the code alone. | Write counts and step order against a stubbed vault, with the real key handling exercised locally. | A component test asserts nothing written before the copy, one wrapper after it, and Continue gated. |
| `recovery-code-rotation` | component | Replacing a code in Settings: one dialog asks for the current one, the new wrapper is written before the new code shows, and the old one is retired only once the new one is copied, over the version just written. | Two steps in one dialog and the order of two writes. | The same recovery-code tests assert one wrapper, then a second that retires the first over the version it just wrote. |
| `onboarding` | component | The wizard's Join the leaderboard step is on by default, Continue joins the board, and a user who switches it off goes on to link bots without joining. | A switch's default and one request. | A component test asserts the step's default, the join request on Continue, and none with the switch off. |
| `draft-mode-sync` | component | A draft and a picked mode travel in the plugin's chat record, come back to a device that lost its copy, and typing leaves `updatedAt` — the activity clock the lists sort on — alone. | Reads and writes of one record. | A component test asserts the write carries text and mode, a second render reads them back, and typing leaves `updatedAt` where it was. |

### Navigation and the rules that choose what is drawn — #310

Four keys: which pane is drawn at which width, the collapsed sidebar, a chat not started, and the
list a project session belongs to.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `panes` | component | The list beside what it opened, for Projects, Code, Meetings and Research: one pane on a phone and a tablet in portrait, two on a tablet in landscape with the sidebar as a rail, one again with the sidebar open, and the list beside the item from 1280px; the item opened last reopens; New research asks in the item pane; New session takes the chip's project. | Which pane is drawn follows media queries (`useSplit`, `useProjectsPane`, `useMeetingsPane`, `useResearchPane`), which a mocked `matchMedia` reaches; the sizes themselves are geometry. | A component test with a mocked media query asserts the pane count per width, the remembered item and both new-item actions; adjacency and real widths go to the snapshots. |
| `sidebar-collapse` | component | The docked sidebar collapses to an icon rail, hiding its labels and the Bots heading while keeping an accessible name and a 44px target on every row, remembers the choice across a reload, and the phone drawer has no button. | The choice, the labels and the accessible names are the app's; the rail's heights and touch targets are geometry. | A component test asserts the collapsed state, the hidden labels and wordmark, the accessible name and the drawer's missing button; the rail's heights go to the snapshots. |
| `session-empty` | component | A chat or session not started shows the big bot, a greeting on a line of its own (the first in an hour only) and one of the bot's five lines in turn, with no bot or title in the header; a session also names the project's repository chip with the branch it starts from, and its header carries no text at all. | The greeting's rule is already pure (`greeting.ts`); what is left is the render, the chip's branch and the header's bareness, which the flow asserts today because no component test mounts the empty state. | A component test over the stored last-greeted value asserts the greeting's presence and the lines' rotation, plus the repository chip and an empty header. |
| `code-sessions` | component | Project sessions stay out of Recents and open from Code. | A derivation of two session lists. | A component test seeds a session and a chat and asserts Recents holds only the chat and Code only the session. |

### Meetings, research, plan mode and a notification — #311

Four keys: two screens read end to end, plan mode's per-session card, and a notification's
question.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `plan-mode` | component | Two sessions of one project: the plan a session finishes belongs to that session alone — the second session's screen shows no card, a plan taken from another session doesn't stay on its row, and a session swapped in place shows nothing of the one before it. | Per-session ownership over two renders and a refetch. | A component test renders two sessions with the host answering each own workspace record, asserting the card's ownership across a switch and a swap. |
| `meetings` | component | Meetings behind its Developer switch over the plugin's routes: a transcript file written up as notes, a cited time opening the transcript, a recording sent in chunks and followed to its recap (timeline, pinned decisions, topics, a topic's transcript), a meeting recorded in the app with a stand-in microphone (pause holds the clock, End meeting sends it), a recording the page left behind offered and sent, an action item starting a session with its text in the composer, a question answered with the times it rests on, a failed meeting tried again, an upload nothing is finishing, search, and Delete — at phone, tablet in dark and laptop widths. | A screen and its sheet over the plugin's routes; the pane beside the list at 1280px is a width. | A component test walks the gate, the new-meeting form, the stages and the notes from a faked host; chunking, transcript parsing and content types are unit tests (`test-meeting-text`); the widths go to the snapshots. |
| `research` | component | A mission from question to guide: the brief, the Scope Gate, reading and drafting, delivered, another format, a citation opening the Sources drawer on its claim, the header's Sources button, questions it missed researched and the guide written again around them, its revisions opening, and a rewrite with another model — at phone, tablet and laptop widths. | Screens and a drawer over the plugin's routes; the mission-beside-list split is the panes rule, and the widths are geometry. | A component test walks the mission's states over faked handlers and asserts each answer and the drawer; the widths go to the panes test and the snapshots. |
| `question-from-push` | component | A notification's question opens a chat this device hasn't loaded and reads as waiting from the first frame — never No answer — then its form; and a question in a chat not on the device yet opens it once synced rather than landing on the home screen. | A route resolution and a first-frame state. | A component test from a notification-shaped URL asserts the waiting state at the first frame, the form after it, and the route waiting for sync. |

### The MCP tab, and which of its controls a feature answer draws — #302

Three keys: the tab's rows, the gating matrix behind them, and the Catalogue behind Add.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `mcps` | component | The MCP tab at `/settings/bots/<botId>/mcps`: Add a server on top, Your servers then From plugins, each row a name over its health (a tool count, Off, Connecting…, the host's own failure text, Click here to authenticate) with no badge, a switch that writes and whose row follows, the tab a history entry of its own, and no heading at all for a bot with no servers. | Which controls draw, and what a row says, are rules over the plugin's answers. | A component test renders the tab over seeded servers and asserts the headings, each health line, the switch's write and the push back to General. |
| `mcps-gate` | component | The plugin's `info` decides what is drawn: no `mcps` leaves no tab and sends the tab's URL back to General; no `mcps_write` leaves rows with no switch; no `mcps_catalogue` keeps Add for a server typed in by hand only; no `mcps_add` leaves no Add; no `mcps_remove` leaves no Remove in Config; no `mcps_config` gives a Tools-only sheet with Remove under it. | A matrix of feature answers — seven scenarios in a browser for what one parametrised test reaches. | One parametrised component test over feature sets, asserting the tab, Add, the switch, Remove, Config and Tools. |
| `mcps-catalogue` | component | Add opens Hermes's Catalogue: only the entries the bot doesn't have and nothing marked added, a search over an entry's name and Hermes's description, a match that finds nothing saying so, and no add sent by opening or searching. | A difference against what the bot holds and a search predicate, with a list's render above them. | The difference and the predicate as unit tests, with the screen's rendering asserted above them (#302). |

### The MCP sheets — #303

Five keys: the sheets that add a server, describe one, remove one, and land its access.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `mcps-add` | component | A Catalogue entry that declares values opens a form — a field per value titled by the name it lands under, subtitled by the manifest's prompt, a required one starred, a secret masked, a default filled in, a held value standing empty with Set as its placeholder; a required value left empty refuses the add and marks the field; a typed value is never shown back; an entry with nothing to fill is added by one tap; an added entry leaves the Catalogue; and a configuration Hermes refuses surfaces its reason with nothing half-added. | A form over what the host's manifest declares, and the host's own refusal sentences. | A component test asserts the fields and placeholders, the refused add, the one-tap add and the host's sentence verbatim; the arguments split is a unit test shared by the three sheets. |
| `mcps-custom` | component | A custom server is a name and one transport — an address for http, a command and one line of arguments for stdio — the name being the one thing Hermes can refuse and its own sentence what the form shows; arguments reach the host as argv, so a path with a space survives; nothing typed is shown back. | A form, its payload and the host's sentence. | A component test asserts the transport switch, the host's refusal rendered verbatim, and the argv sent for a spaced path. |
| `mcps-server` | component | One server's sheet: Config — the block read whole, a field per environment value titled with the name it lands under and nothing else, a held value standing empty with Set, nothing written until one Save, Save only once something changed, arguments one line — and Tools — the schema cache, which connects nothing, with Load tools to connect, list and disconnect; a plugin's server is read, not edited. | Rendering and payload building over the block the host holds. | A component test asserts the Config's fields and its one write on Save, the read-only plugin server, and the Tools list with Load tools' request. |
| `mcps-remove` | component | Remove server on a bot's own servers and none on a plugin's, a confirmation first (a cancel sends nothing), and the list showing what is left with no manual refresh. | A control's presence and one delete. | A component test asserts Remove's absence on a plugin server, cancel sending nothing, and the row gone after a confirmed delete. |
| `mcps-access` | component | A waiting server's health line starts Server access, shows the host's URL with a copy, the row keeps saying it waits, a pasted callback address lands the access, the row clears by itself, and a server without access — or a plugin's — offers no such line. | A flow's wiring over the host's routes: start, show the URL, paste the callback back, clear. | A component test drives start, the pasted callback and the clearing read, asserting the URL shown, the payload sent and the row clearing. |

### AFK — #304

Nine keys: seven about the pop-up and the session it names, two about what the plugin itself
decides.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `afk` | component | A project's options menu carries an AFK row, and its pop-up lists the project's tasks as AFK reads them: ready oldest first, claimed marked with who has them, blocked naming the open task they wait on — with no row for a plugin that doesn't advertise `afk`, and GitHub's refusal shown instead of a list. | A list's derivation and a sheet's render. | A component test renders the pop-up over seeded tasks and asserts the frontier's order, the claim mark and the blocker line. |
| `afk-switch` | component | The switch turns a project on and off on its host, and a reload reads that answer back — the setting is the project's, not the device's. | A write and a read-back, with the switch never flipping before the host answers. | A component test asserts no optimistic flip, the write, and the host's answer read back on a remount. |
| `afk-skills` | component | The pop-up picks one skill to build by and any number to critique, from the bot's own skills and only what its host can run now, kept on the host apart from another project's, either clearing back to nothing, with no pickers on a plugin that predates them and its switch still working. | Two pickers over the profile's skills and two writes. | A component test asserts both pickers' options, the write, another project's own answer, the clears, and the pop-up without the feature. |
| `afk-switch-reasons` | component | Where the switch can't be offered: a host with no GitHub account says why once rather than as both the switch's reason and the frontier's refusal; a plugin too old to switch it shows the switch off and out of reach, reading Turned off and saying nothing about the plugin; and a project already on keeps a live switch with the reason under it. | The same pop-up's refusal line; the drift is recorded below. | A component test asserts the one reason line, the disabled switch with no spinner under it, and the live switch on a project already on. |
| `afk-stalled` | component | An AFK session nothing is working any more waits where the user finds it: Code's Waiting on you and, from 1280px, the sidebar's Waiting for input, each with the host's own reason under it. | Two renders from one plugin answer; the width is `useLarge`'s switch, not geometry. | A component test asserts both waiting lines and the reason under each at both widths, with a mocked media query. |
| `afk-stage` | component | The pop-up names the stage a staged task is in, by the stage's own name from the task's snapshot, read from the host on its own poll, and keeps naming it once the pickers change under it; a project with no critique skill is one run, with no stage to name. | A prefix over the host's own record. | A component test asserts each stage's prefix as the host's answer moves, and none for a one-run task. |
| `afk-prompt` | component | With the workflow library off, the pop-up draws a Prompt row under the switch reading the words its runs are told — the host's default where the project wrote none — opening one writing sheet (a bottom sheet, or the drawer from 1024px) whose Done writes them back for the next read to answer. Then the account's library, which needs a signed-in account with the vault open on the device: those words saved to it by name and tags, picked in ANOTHER project as a copy that names the entry it came from, the entry rewritten on the library's side so the row says `changed in library`, and one tap pulling the new words in — the host holding them and their source, the marker gone, and a reload reading the copy back unmarked. At 390, 768 and 1024px, light and dark. | The row's rule, the words and the write are a render over the host's answer; only the row's place in the list, the sheet's height and the drawer's edge are geometry. The library's rules are lower tiers' too — `test-prompt-library.mjs` for the pure ones, `test-afk-prompt-library.tsx` for the editor over a seeded database — so what this adds is that the account's own state (a signed-in session, an opened vault, the sync documents, Dexie's rows) holds together with the host's write, in a browser. | `app/scripts/test-afk-prompt.tsx` and `test-afk-prompt-library.tsx`, which landed with the flows and are green: the row only where the library is off and the host holds a Prompt, the words it reads, the one writing surface, a save answering the row, a refusal keeping the words, an emptied field reading the default, and no row on a plugin that predates it; the library's list, an entry's save and edit, a pick's write and the marker's pull. The account-and-vault seeding, the geometry and the real reload stay the flow's. |
| `afk-claim` | plugin | Turning a project on has the host claim its oldest ready task — assigned and marked — so the pop-up says what it is working, the frontier no longer offers it, and a GitHub refusal leaves the switch on with its reason. A project that may hold several tasks holds one per place: the pick count stepper writes a count, the Working block names every task the host answers (oldest first, each with the stage of the session working it) over a count row, the budget line reads the bot's own two numbers, and the frontier lists them all as claimed — at 390, 768 and 1024px, light and dark. | What it asserts is what the plugin decided: the claim sweep. ADR 0019 sends the plugin's own behaviour back to the plugin's suite. | Plugin tests: the claim takes the oldest ready task, fills to the pick count, and a refusal keeps the switch on with its reason. The pop-up's working and refusal lines, the count row, the stepper and the budget line join the AFK component tests; what no lower tier reaches — the stepper's write read back at three widths, and the sheet still scrolling with a longer pop-up — is the flow's, drawn against the mock's own state. |
| `afk-session` | plugin | AFK works its claimed task in a session of its own: the published chat record makes the Code row, titled after the task and marked AFK, and opening it shows one line naming the task rather than the brief. | The published session record is the plugin's; only the Code row's mark is the app's. | Plugin tests: the published record carries the AFK mark, the task's title and its opener. The Code row's mark joins the Code component test. |

### A bot's models — #305

Three keys: the fallback list, the subagent model, and a write the host never answers.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `fallback-models` | component | A bot's fallback models are recorded on its host — two picks, one removed, never a third — and the rows grey out while a write is on its way. | A list's ordering and a form's writes over a faked plugin. | A component test asserts two picks in order, the removal, no third, and the greyed field held against the write. |
| `delegation-model` | component | The subagent model is recorded as the host's delegation model, cleared back to inherit, the field greyed while a write is on its way, and no field at all without the feature. | A picker and one write: the fallbacks' shape, on another field. | A component test asserts the write, the clear as its own write, the saving state, and no field without the feature. |
| `fallbacks-silent-host` | component | A host that takes a fallback write and never answers it: the field is given up on and comes back rather than staying greyed out with a save that never lands. | A timeout, which fake timers assert at no wall-clock cost. | A component test with fake timers asserts the field returns after the write's timeout. |

### A bot's Main thread and its cards — #415

One key, the only one that walks the whole feature: #417–#421 each brought their own tests, and
#422 is the ticket whose job is the flow.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `bot-threads` | component | A bot opens its Main from home; its threads are cards at their start times, the first between the messages written either side of it and the last closing the flow; a card opens its thread and back returns to Main; `/thread` with text opens a thread holding that message, whose card is back on Main at its start and drawn without a marker. Then, on a mock answering `MOCK_TRIAGE=new`, the message leaves Main as its new thread's card carrying Undo and no marker; on one answering `MOCK_TRIAGE=thread` it keeps the Moved marker, linking the older thread it went to, with no card carrying the move. Last, at tablet width with the dark theme, a card, Main's day heading and the Moved line still draw, and the move's Undo is still there. | Every rule it walks is a component test's — a card's place in Main (#417), the marker and the triage-opened card's Undo (#419), `/thread` and the name the switch picks (#420) — and none of them needs a browser's layout. What the flow adds is that they compose: a real route change, a real reload onto the mock's chat list, and the mock's own triage and moves answering a send. | `app/scripts/test-main-cards.tsx`, `test-card-undo.tsx`, `test-main-triage.tsx` and `test-slash.mjs` carry the rules, and #417–#421 landed them green. The flow stays in the registry as the one proof the path holds end to end, which no component test mounts. |

## The ten that stay, and why only a browser can assert each

Every one of these earns its browser by a mechanism no lower tier reproduces, and a stay is
replaced by itself. They are what the end-to-end registry holds once the other 58 keys leave
(#314).

| Key | Verdict | What it asserts today | Why only a browser can assert it |
| --- | --- | --- | --- |
| `thinking-line` | stay | A turn whose thinking a tool call breaks: the working line reading *Writing…* before any thinking lands, the reply's first row open on *Thinking…* with the working line gone, then the call landing with the thinking before it folded above it over the span it measured and a second row open below it, both rows folded at the first answer token, and a reload drawing the same two rows in the same places, still reading the numbers they measured. A second turn thinks at length without a call to break it: the open row lands the thread on its newest words and keeps them in view as the pieces arrive, the reader's wheel stops that follow, the run past its cap draws that much of itself with a fade and a 48px Show more, the row's end sits at the foot, Show more reveals the rest inline with the control and the fade gone, and the cap holds at 390px and 834px with the fade following the theme. | The stream is what no lower tier reaches: the app's rows following a host's own reasoning events as they arrive in wall-clock time, a piece at a time, with a real tool call breaking them in the middle — a faked HTTP boundary answers the shape the code expects, and would pass whether or not a host streams reasoning around a call. The reload leg is the span's own proof: the number the live run measured and wrote onto the reply's row is what the thread reads back after a real reload, and a component test would have to seed that row itself, asserting the shape rather than that the live path wrote it. The long run's legs are the same shape of proof for layout and scrolling: a capped box is a height the page computes against a real viewport and a real fade gradient — jsdom has no layout, so the component tests can only hand the row a size — and the follow is a smooth scroll of the thread's own scroller, which a wheel has to be able to stop. The rows, their labels, placement and cap are `test-thinking-line.tsx`'s, and the span landing on the row is `test-live-span.tsx`'s; this flow proves the live path feeds them and that they survive a reload. |
| `reattach` | stay | A reply still streaming when the page reloads picks its run up again and finishes. | A live run outliving a real reload. A component test can remount a tree, but it has no run still going on a test host to rejoin, so it would pass whether or not reattachment works. |
| `live-poll` | stay | `runs/live` is read by one shared poll: at most 3 reads in 25s with a session, its project and the sidebar all open. | A request rate over wall-clock, with three screens mounted at once. |
| `idle-requests` | stay | An idle open chat makes at most 12 requests in 65s. | A request budget over 65 seconds of real time and a real fetch stack. |
| `foreign-run` | stay | A run started elsewhere shows as running in Code and on the open session screen, is followed to its end, and leaves no duplicate. | A run this browser never started, on a host that owns it: the app only discovers it. |
| `compressed-run` | stay | A chat another device started and Hermes compressed before this device loaded it lands its transcript and follows its run to its end — whether the rotation came before the run or mid-run. | A test host rotating the session id mid-run, the mechanism the plugin's run keying broke on. A faked HTTP boundary would answer the shape the code expects rather than the one the host sends. |
| `screens` | stay | Projects, a project, Code, Routines, a chat and a started project session load their data at 390 and 1024px, in light and dark, with no console error; the session's header has no bot picture, says `Test bot · memento +3` on a phone, `Test bot · memento, gots-app +2` at exactly 768px and `Test bot · memento, gots-app, docs +1` at a laptop's width, without the whole line truncating, leaves its branch out, and its title truncates and stays centred in the room the controls leave — the row's own centre on a phone, where the back control and the actions are both 44px. | Real layout at two widths: a DOM without layout has no sizes. The line is also the only place each width's cap is seen coming out of the real media queries, and the truncation is a rendered width, not a string. It is also where the sweep's visual snapshots live. |
| `stream-writes` | stay | A streaming reply is written to IndexedDB in batches: at most 6 writes a second, where main wrote 7.5. | A write rate measured over a real stream's wall-clock. |
| `openui` | stay | A reply carrying an `openui-lang` block draws its interface from Gots's own components at 390px and at 768px, in light and dark — a card, a table, a callout and two bar charts, the interface taking the thread's own column, its box's left and right edges on the reply text's own (the glyphs measured by a `Range`, ±1px) with the block's undrawn code form in the same place, the gap above and below it the thread's paragraph gap (12px either side, measured box to box against two paragraphs of that text), no chart's five-digit Y tick label outside the chart's own box, and no sideways scroll of the page or the table inside it — and the patched card is what draws at both widths; a block naming a component the library doesn't have draws as the code the model sent, under the `openui-lang` label, with the reply still reaching its last sentence; and a patch that lands while the thread is scrolled up leaves `[data-slot=message-scroller-viewport]`'s scrollTop exactly where it was, and the interface at the same offset of the screen, while the thread grows under the reader. | Geometry and a scroll offset: a DOM without layout has no sizes and no scrollTop, so a component test can assert the card's text but not its box, nor where a reader's viewport sits when a patch re-renders the interface they are reading. The patch also has to arrive on a real stream inside the one reply — a second user message jumps the thread to the end (`FollowOnSend`) — which is a host's own wiring, not a faked boundary's. |
| `openui-map` | stay | A reply's block is a `Map` of four labelled places. It draws a map at 390px and at 768px, in light and dark, fitted to its own points — every label's box wholly inside the map's box at both widths — its required summary the accessible name, each point's detail on its marker; the basemap follows the theme (tiles asked for from `World_Street_Map` in light and `World_Dark_Gray_Base` in dark) with `Esri` and `OpenStreetMap` attributed in the chrome, inside the map's box, and the map takes the thread's own column with no sideways scroll. Then the gesture contract: over an untouched map a wheel and a real one-finger swipe both change the thread's scrollTop while the map's view holds to the pixel and `data-active` stays false; a tap makes it active and shows a 44px button; a wheel zooms and a drag pans the active map while the thread's scrollTop holds; the button hands the gestures back, the thread scrolling over the map again at the view the pan left. | Geometry and a gesture contract. A DOM without layout has no sizes, so a component test can prove the labels, the summary and the required props (`test-openui.tsx`) but not that the view is fitted, that a label lands inside the frame, or that the tiles asked for are the theme's. And which element takes one finger — the thread scrolling or the map panning — is decided by `touch-action` and Leaflet's handlers inside the browser's own input pipeline; nothing below a browser has a touchscreen, a scroll offset to move or a frame to pan within. |
| `question-during-delegation` | stay | A bot delegates and asks in the same turn: the subagent's card reads its child still running; the question card takes the composer's place while the agents route still reports that child running; the answer brings the turn's reply, and then the subagent's result lands as the bot's own message at the thread's end, named above the result it carries, with no bubble and never as the user's; the wake prompt the plugin posts for it draws no message at all, no header, no footer and no user row; and the wake turn that answers it acts on the result and draws as a message of its own, below the delivery, arriving while its run is still going, a piece at a time; and the words the reply said before the question are drawn once, live and again after a reload, never once for each half of the turn. | Composer-replacement timing across a live stream. The question card has to take the composer's place at the instant the host raises it while a child is still working, and the result and the wake turn have to land in the thread as the host writes them, in wall-clock order, under the fold that draws a wake prompt as nothing. A component test over a faked host answers every shape in one step: it asserts the card, the delivery and the wake answer, but not that the card replaced the composer while `runs/live` and the agents route both still said the child was running, nor that the result and the wake turn landed after the reply that answered the question rather than inside it. |
| `card-widths` | stay | A chat's subagent card and its waiting Question fill the box they are given and never pass the reading column's 768px box (ADR 0047): at 390px the pane is narrower than the box, so a 348px card sits on the thread's 16px and a 366px Question on the slot's own 12px; at 1024px the same, 662px and 672px at 16px each; at 1440px, where the 1120px pane clears the box, each stops at 768px and centres — the card at 171px, the Question at 176px — while message text keeps its 736px column at 187px, the capped card framing it exactly, 768px around 736px with the box's 16px gutter each side. A reintroduced pane-fill (ADR 0041) passes the box at 1440px and a reintroduced 448px cap falls short of the text's frame, so both fail there. | Geometry, and nothing else: a card's width and its left edge's offset are layout, so no DOM without a layout engine has them, and a class assertion cannot tell a card that stops at the box from the same card filling the pane or capped at 448px — which is the whole of ADR 0047. The phone and tablet legs keep the fill honest below the box; the laptop leg is the only one where the cap binds, and the one review loses most easily since the text beside the card does not move at all. |

## The coverage a demotion leaves with no home

The 58 keys that leave — 53 demoted, 3 deleted as duplicates, 2 moved to the plugin — take away
the assertion of things a component test cannot see: geometry, real timers and real capture, and a
reload with a live stream. Four of those have a home: the two request budgets and the write rate
stay with `live-poll`, `idle-requests` and `stream-writes`, and the real reload stays with
`reattach` (`compressed-live`'s reload leg becomes a remount, which asserts the resumed state and
not the reload). No test has ever claimed a real audio capture — the flow ran on Chromium's fake
microphone and the component test stubs `MediaRecorder` — so nothing is lost there that was had.

A snapshot is of a screen `screens` already visits, in a state seeded on it, and #314's scope is
exactly the screens that flow visits. So a behaviour on a screen it never visits has no snapshot
to land in. In the table below, a row that names the snapshots can still be closed by seeding that
state; a row that says *nothing* is a loss accepted now, and accepted later unless a ticket takes
it up.

| Behaviour | Asserted today by | After the demotion |
| --- | --- | --- |
| The collapsed sidebar's row heights and 44px targets | `sidebar-collapse` | The snapshots, if the 1024px pass seeds a collapsed sidebar — a state on a screen the flow visits, not a screen added. |
| Pane adjacency at a tablet width | `panes` | The snapshots: `screens` visits Projects and Code at 1024px, where the list sits beside the item. |
| The slash menu's height cap | `slash-skills` | The snapshots, with the menu open on the chat screen's pass. |
| The reserved cell sizes of a reply's images | `image-skeleton` | The snapshots, if that chat carries an image. |
| The dimmed unsent bubble | `failed-send` | The class tokens are the component test's (#306 asserts the failed row shares the queued row's own); the rendered dimness is a pixel claim no snapshot makes. |
| The Prompt row's place under the switch, the editor sheet's height and the drawer's edge | `afk-prompt` | The snapshots, if the project screen's pass opens AFK's Prompt editor — a pop-up on a screen the flow visits, not a screen added. |
| The usage banner's responsive form | `usage-limit` | The snapshots, if the chat screen's pass carries an account near a limit, since the banner is drawn over that screen. |
| The outputs drawer drawn as a sheet on a phone | `outputs` | Nothing: it belongs to a project session's screen, which `screens` never visits. |
| The recovery code's wrap at a hyphen, between two of its groups | `recovery-code-rotation` | Nothing: the wizard is not a screen `screens` visits, and the wrap is CSS rather than a rule. |
| A sender's Stop landing while the session id rotates | `compressed-live` | The app's rule is the component test's — Stop's request carries the rotated run and the reply settles. A real cancellation is covered by no flow, since `compressed-run` never presses Stop; #307 accepts that. |

## The one drift, and which way it is resolved

`afk-switch-reasons` opens by saying a plugin too old to switch AFK "offers no switch at all". Its
second scenario asserts the opposite: the switch is rendered (the flow counts one), disabled,
`aria-checked="false"`, reading *Turned off*. The app's rule is that a control the host cannot
honour is shown, in place, out of reach, as `AGENTS.md` states for AFK's switch — so the comment
is the part at fault.

- **The behaviour the comment describes is dropped.** Nothing asserts it, and `AfkSwitch`
  (`app/src/components/afk.tsx`) renders the row unconditionally, with no branch for a missing
  feature.
- **The behaviour the flow asserts is carried over** into the AFK pop-up's component test (#304),
  which keeps the disabled switch, one reason line rather than two, and a live switch on a project
  already on. A plugin too old to switch AFK gets no reason line, since the host gave none — the
  row reads *Turned off* and says no more — and the test asserts that rather than inventing words
  for the plugin.
- **The comment is corrected in #304**, where the pop-up's tests land, rather than here: this page
  records the drift, and the flow goes on asserting what the app actually does until it is
  deleted.

## What this page does not decide

Whether the ten run on a real Hermes is #313's question, and whether the snapshots seed the
states named above is #314's. This page only says which keys move, where each assertion goes, and
what is accepted if nothing picks it up.
