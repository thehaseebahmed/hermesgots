# The audit of the end-to-end flows

Every key in the end-to-end registry gets one verdict here — **stay**, **component**, **plugin** or
**delete** — with what the flow asserts today, why it moves or stays, and what replaces it. This is
the committed record #297's plan calls for, delivered by #299: a flow leaves the registry only once
its replacement is green, so this page records where each assertion goes rather than claiming it has
already arrived.

Every verdict applies one rule — a test belongs to the cheapest tier that would fail for the reason
the change can fail — from ADR
[0019](adr/0019-a-test-belongs-to-the-cheapest-tier-that-would-fail-for-its-reason.md), which owns
what the tiers are along with `AGENTS.md`'s Testing paragraph. This page only records which one each
flow lands in: **stay** (end-to-end), **component**, **plugin** (the plugin's own Python suite), or
**delete** (a duplicate another flow already asserts). The end-to-end skill points here once it is
rewritten for the seven (#317).

## The arithmetic, and how to check it

The registry in `app/scripts/e2e/cli.mjs` holds **63 keys**, and every one of them has a row below.
`pnpm e2e list` prints the same 63 keys, and the rows here are grouped by the ticket that takes them
rather than by the registry's order, so the count is the thing to check:

| Verdict | Keys |
| --- | --- |
| stay | 7 |
| component | 51 |
| plugin | 2 |
| delete | 3 |
| **total** | **63** |

Of those 63, 57 keys point at a script under `app/scripts/e2e/` (one of them, `todos-legacy`,
reuses `todos.mjs`, so 56 distinct files there) and 6 point at the older
`app/scripts/regression-*.mjs`.

#297's plan counted **60** keys and split them **48 component / 7 stay / 3 delete / 2 plugin**. Two
things in that arithmetic did not hold, and both are checkable:

- Its clauses name **59** keys — 53 pointing at `app/scripts/e2e/` and 6 at the older
  `regression-*.mjs` — and its sixtieth is `todos-legacy` counted a second time, as "one registry
  key reusing another's script" rather than as the 53rd of the first group, which it already is.
  Today's 57 keys under `app/scripts/e2e/`, less the four that arrived since, are those 53.
- It left out goal mode's two keys, `goal-wizard` and `goal-pill`, which the registry still held when
  the plan was written: the commit before they left carries 61 keys
  (`git show 8a4e842^:app/scripts/e2e/cli.mjs`). Both went with goal mode (#296), so that omission
  costs nothing today.

Four keys have arrived since, each component by the same rule: `delegation-model` (#318),
`afk-skills` (#327), `afk-stage` (#328) and `pipeline-pill` (#330). So the registry holds
59 + 4 = **63** keys, and the component verdicts are the plan's 48 less the key it counted twice,
plus those four: **51**. #299's own criterion still says 48; that figure is superseded by the 51 above
for the reason just given, and nothing else in the ticket's split moves.

Check any of it in one line:

```bash
grep -c '^| `' docs/e2e-flow-audit.md                           # 63 rows, one per registry key
grep -c '^| `[a-z0-9-]*` | component |' docs/e2e-flow-audit.md # 51
grep -c '^| `[a-z0-9-]*` | delete |' docs/e2e-flow-audit.md    # 3
grep -c '^| `[a-z0-9-]*` | plugin |' docs/e2e-flow-audit.md    # 2
cd app && pnpm e2e list | wc -l                                # 63 keys in the registry
git show 8a4e842^:app/scripts/e2e/cli.mjs |
  sed -n '/^const FLOWS = {/,/^}$/p' | grep -c '^  [a-z"-]*: {'  # 61, before goal mode left
```

## The verdicts

Each family below is the ticket that takes it. The **What replaces it** column states the test the
demotion produces: a key is deleted in the change that writes that test.

### Chat, a reply and a failure — #306

Six keys, one family: what the composer sends, what the thread shows of a turn, and what a send or a turn that fails leaves behind.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `chat-message` | component | A new chat sends `hello there`, gets a reply with text, and the chat is listed under Recents. | A send, a streamed reply written into Dexie and a list row: the app's own wiring over an HTTP boundary a handler fakes. | A component test sends from the composer over a handler that streams a reply, then asserts the reply settles `done` and Recents holds the chat. |
| `plain-error` | component | A turn that fails before it says anything reads as plain text with no bot beside it, while the reply above it keeps one. | Which row a failure takes is a render over the host's own error. | A component test seeds a run that fails before answering and asserts the plain-text row with no avatar beside the avatar on the reply above. |
| `failed-send` | component | A send nothing reached stays dimmed like a queued message, wears a mark, says only that it didn't go, can be sent again with what it held or taken back, outlives a reload, and sends are refused meanwhile. | The failed row's state and its two actions are device state; the reload is Dexie's persistence, which a remount reaches. | A component test asserts the row's state and its two actions, and that it shares the queued row's own class tokens rather than a computed colour. |
| `submission` | component | Two sends racing in one chat start one run and get one reply. | A guard in the send path: the same call twice without awaiting is the whole condition. | A component test calls the send path twice without awaiting and asserts one request and one reply row. |
| `approval` | component | A session's approval waits in the sidebar's Waiting for input and Code's Waiting on you, and both move it under Today once it is allowed — with the three panes it also checked at 1440px. | Two renders from one plugin answer; only the three-pane layout it checked is beyond a DOM. | A component test renders the sidebar and Code over a seeded waiting session, asserts both waiting lines, and both lists under Today after the answer; the three-pane layout is the snapshots'. |
| `approval-missed` | component | An approval the host timed out dismisses itself, and an answer refused with `approval_not_pending` marks the approval missed even while the run status still shows the old request. | Two clearing rules against the host's own error and a stale run status: no wall clock the browser supplies. | A component test drives a timeout and a refused answer against the host's error plus a stale run status, asserting the slot clears and is not re-raised. |

### A thread and its history — #307

Eight keys, one family: what a thread derives from a transcript or a run's events, and what a chat looks like after a model change, a compaction or a page of history.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `todos` | component | The todo list shows above the composer while the reply that wrote it still runs, from the run's events and, on a host whose events the browser can't read, from the transcript — one script under two keys, this one and `todos-legacy`. | A derivation from a run's events and from a transcript, with a pill's render on top. | One component test with two legs — a change stream carrying todos, and a transcript-only host carrying the same — asserting the running turn's tool list beside the pill (#307). |
| `todos-legacy` | delete | The same pill read from a transcript, on a host whose event stream the browser can't read. | It is `todos` run against the legacy mock: one claim under two registry keys. | Nothing of its own: the second leg of the todos test, which #307 writes as it deletes this key. |
| `photo-progress` | delete | A message sent with a photo shows its reply's tool calls while it runs, on a host the browser can't read the events of. | It asserts the running turn's tool list from a transcript — the derivation the todos test owns; the photo is the mock's keyword, not the claim. | Nothing of its own: the tool list in that same leg. |
| `model-switch` | component | A chat's model pill picks a new model, and the thread draws one divider naming it above the turn it answered with — after a reload, in a project session, and as a turn opens where the host's record hasn't reached the device. | Where a divider sits is a pure placement rule (`model-changes.ts`) drawn over a rendered thread. | A component test asserts one divider above the right turn, over a seeded record plus a turn this device sent; the placement rules stay unit tests (`scripts/test-model-changes.mjs`). |
| `history-pages` | component | A session opened here mid-turn from another device loads its newest turn whole, Load earlier pages back a whole long turn twice, the running reply stays one reply at the end, and a chat an older version split at the page edge is mended by its next Load earlier. | Merging paged transcripts: a reconcile over rows, and the render that shows each turn once. | A component test fakes paged transcript handlers and asserts whole turns, the running reply once, and the mended chat; the reconcile stays a unit test where it is pure. |
| `history-generations` | component | A session compacted on the host while this device already showed its turns ends with each turn once, not the whole sequence twice, and the carried turns land around the messages sent since. | A dedupe over rows Hermes re-emits under fresh ids. | A component test over a handler that re-emits carried turns, with the reconcile rules as unit tests. |
| `compressed-live` | component | The device that sent the turn, compressed mid-run: the reply reaches its end, picks up again after a reload, and comes down on Stop — while the host keying that broke on a real host is the plugin's, pinned by `plugin/tests/test_session_run_keying.py`. | The app's side of a rotating session id is a stream handler's behaviour, not layout — but a real cancellation on a real host under that rotation is not reproducible here. | A component test streams a turn whose session id rotates, asserting the reply finishes, a remount resumes it, and Stop's request carries the rotated run; the real host's cancellation is the loss recorded below (#307). |
| `pipeline-pill` | component | A staged task's session carries its pipeline as the first pill above the composer — three bars, green where a step is done and red where it failed, with the stage in words — and its sheet counts the stage out of three and names what each step ran, still there once the task is done. | A pill and a sheet drawn over the host's own record — bars, words and counts, not geometry or a rate — with `pipeline.ts`'s verdict rules already unit tests (`scripts/test-pipeline.mjs`). | A component test renders the pill and its sheet over seeded pipeline records for each stage and a failed one, asserting the bars, the words and the sheet's counts. |

### The ask-the-user card — #312

Three keys become one suite: the four outcomes a card can read back, an answer that survives stale reads, and a question whose window closed.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `clarify-polling` | component | An answered question survives two stale transcript reads, the turn's completion and a reload. | The settle rule over stale rows; the reload is a remount. | The one clarify suite (#312): an answered card after two stale transcript reads and a stale run status. |
| `clarify-transcript` | component | A fresh transcript reads as Answered, No answer, Not answered or Skipped, with the answers the card holds. | A mapping from a tool row to a title and its answers, plus a render. | The same suite: the four outcomes (the mapping itself a unit test), single- and multi-select answers, on one shared fixture. |
| `clarify-missed` | component | A question whose window closed stays as a No answer card with the question it asked, and Ask again starts a new turn that asks afresh. | The expired card's render and its retry wiring; nothing resumes the expired call, so no host behaviour is at stake. | The same suite: an expired card offers Ask again and sends a new turn. |

### The composer — #308

Four keys demoted and one deleted: the slash menu, drafts, dictation with a stubbed recording, and a reply's images holding their place.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `slash-skills` | component | The composer's `/` menu lists the bot's skills from the plugin rather than Hermes's `/v1/skills`, keeps the list on the device, opens on a slash that begins any word, and puts a picked skill at the front of the message, which is the only place the host runs one — at a laptop width in light and a phone in dark. | A token rule, a cached list and an insert, all the app's; only the menu's height rules are beyond a DOM. | A component test over a seeded skills row asserts the list, a mid-word slash opening it, and the hoist on pick; the token parsing stays a unit test and the height cap goes to the snapshots. |
| `drafts` | component | A composer's unsent text is kept per chat and cleared on send. | A device row read per chat. | A component test types in two chats, asserts each keeps its own text, and that a send leaves none. |
| `dictation` | component | Dictation's pieces and their retries, the recording kept until its text is in, and no microphone where the host can't take one — with Chromium's fake microphone standing in for a real one. | A stubbed `MediaRecorder` is what the flow already used, and the pause-cut points are a pure rule. | A component test with a stubbed `MediaRecorder` asserts the pieces land in order, a failed piece retries, the recording is kept until its text is in, and the mic is absent without the host; the cut points stay unit tests. |
| `image-skeleton` | component | An agent's images hold their place with a skeleton while they load — in a chat and in a project session — give way to the image or to the tag's text, and a lone image takes the same cell as one in a group. | A placeholder's lifecycle over a seeded reply, with the media route's answers faked. | One component test asserts that lifecycle and absorbs `image-viewer`'s opened-photo leg (#308); the cells' reserved sizes go to the snapshots. |
| `image-viewer` | delete | A photo opened from a message holds its place while it decodes, then paints — at a fifth of the page's normal speed, so the placeholder is catchable. | A duplicate of the placeholder lifecycle the image test owns; the slowdown is the flow working around the browser, not a claim. | Nothing of its own: the opened photo's placeholder becomes the image test's second leg. |

### Settings, sync and usage — #309

Seven keys: what the app says about a bot's limits, a session's outputs and pull requests, a draft, and the two recovery-code screens.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `usage-limit` | component | The notice follows the account — quiet with credits, warning near a limit, out without — a dismissal doesn't outlive the state it dismissed, the reset counts down in words, and the Usage sheet names the model in a row above its meter. | A choice over the account's windows plus a render; the choice and the reset text are already pure (`provider-usage.ts`). | A component test over seeded windows asserts the notice's choice and its words; the choice and the reset text stay unit tests, and the banner's responsive form goes to the snapshots. |
| `outputs` | component | The outputs pill counts a session's filed files and pull requests, and opens a drawer with the session's pull requests — live and finished, newest first — and the Library's tree restricted to its own folders, as a sheet on phones and a drawer from 1024px. | List composition and two tabs drawn from the host's answers; the sheet-or-drawer choice is `usePopupDrawer`, not geometry. | A component test seeds the outputs and asserts the pill's count and both tabs; the drawer drawn as a sheet goes to the snapshots. |
| `prs` | component | A shipped pull request lists in its project's Pull requests tab, and a host that can't reach GitHub keeps the ones the app already knows instead of storing none over them. | A failed read and what the store keeps when one fails. | A component test answers the read with an error and asserts the known rows survive, then with a list and asserts it renders. |
| `recovery-code` | component | Setup always issues a recovery code, offers the passkey only beside it, writes nothing before the code has been copied, and gates Continue on that copy; a passkey that can't be made is a quiet choice to go on with the code alone. | Write counts and step order against a stubbed vault, with the real key handling exercised locally. | A component test asserts nothing written before the copy, one wrapper after it, and Continue gated; the code's wrap at a hyphen goes to the snapshots (#309). |
| `recovery-code-rotation` | component | Replacing a code in Settings: one dialog asks for the current one, the new wrapper is written before the new code shows, and the old one is retired only once the new one is copied, over the version just written. | Two steps in one dialog and the order of two writes. | The same recovery-code tests assert one wrapper, then a second that retires the first over the version it just wrote. |
| `onboarding` | component | The wizard's Join the leaderboard step is on by default, Continue joins the board, and a user who switches it off goes on to link bots without joining. | A switch's default and one request. | A component test asserts the step's default, the join request on Continue, and none with the switch off. |
| `draft-mode-sync` | component | A draft and a picked mode travel in the plugin's chat record, come back to a device that lost its copy, and typing leaves `updatedAt` — the activity clock the lists sort on — alone. | Reads and writes of one record. | A component test asserts the write carries text and mode, a second render reads them back, and typing leaves `updatedAt` where it was. |

### Navigation and the rules that choose what is drawn — #310

Four keys: which pane is drawn at which width, the collapsed sidebar, a chat not started, and the list a project session belongs to.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `panes` | component | The list beside what it opened, for Projects, Code, Meetings and Research: one pane on a phone and a tablet in portrait, two on a tablet in landscape with the sidebar as a rail, one again with the sidebar open, and the list beside the item from 1280px; the item opened last reopens; New research asks in the item pane; New session takes the chip's project. | Which pane is drawn follows media queries (`useSplit`, `useProjectsPane`, `useMeetingsPane`, `useResearchPane`), which a mocked `matchMedia` reaches; the sizes themselves are geometry. | A component test with a mocked media query asserts the pane count per width, the remembered item and both new-item actions; adjacency and real widths go to the snapshots. |
| `sidebar-collapse` | component | The docked sidebar collapses to an icon rail, hiding its labels and the Bots heading while keeping an accessible name and a 44px target on every row, remembers the choice across a reload, and the phone drawer has no button. | The choice, the labels and the accessible names are the app's; the rail's heights and touch targets are geometry. | A component test asserts the collapsed state, the hidden labels and wordmark, the accessible name and the drawer's missing button; the rail's heights go to the snapshots. |
| `session-empty` | component | A chat or session not started shows the big bot, a greeting on a line of its own (the first in an hour only) and one of the bot's five lines in turn, with no bot or title in the header. | The greeting's rule is already pure (`greeting.ts`); what is left is the render. | A component test over the stored last-greeted value asserts the greeting's presence and the lines' rotation. |
| `code-sessions` | component | Project sessions stay out of Recents and open from Code. | A derivation of two session lists. | A component test seeds a session and a chat and asserts Recents holds only the chat and Code only the session. |

### Meetings, research, plan mode and a notification — #311

Four keys: two screens read end to end, plan mode's per-session card, and a notification's question.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `plan-mode` | component | Two sessions of one project: the plan a session finishes belongs to that session alone — the second session's screen shows no card, a plan taken from another session doesn't stay on its row, and a session swapped in place shows nothing of the one before it. | Per-session ownership over two renders and a refetch. | A component test renders two sessions with the host answering each own workspace record, asserting the card's ownership across a switch and a swap. |
| `meetings` | component | Meetings behind its Developer switch: the sidebar row only with it on, sample meetings by when they happened, search and the project filters, a recap's timeline with a time opening its topic at that line, an action started and a question answered, a recording with a marked moment written up, an uploaded recording, a transcript file and a pasted one, a failed meeting retried, and Delete — at phone, tablet in dark and laptop widths. | A screen and its pop-ups over the plugin's routes; only the recording cover's full-viewport geometry is beyond a DOM. | A component test walks the gate, the list's order, the filters, a time opening its topic at a line, each write-up and the retry; the transcript parsing stays a unit test and the recording cover goes to the snapshots. |
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

Eight keys: six about the pop-up and the session it names, two about what the plugin itself decides.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `afk` | component | A project's options menu carries an AFK row, and its pop-up lists the project's tasks as AFK reads them: ready oldest first, claimed marked with who has them, blocked naming the open task they wait on — with no row for a plugin that doesn't advertise `afk`, and GitHub's refusal shown instead of a list. | A list's derivation and a sheet's render. | A component test renders the pop-up over seeded tasks and asserts the frontier's order, the claim mark and the blocker line. |
| `afk-switch` | component | The switch turns a project on and off on its host, and a reload reads that answer back — the setting is the project's, not the device's. | A write and a read-back, with the switch never flipping before the host answers. | A component test asserts no optimistic flip, the write, and the host's answer read back on a remount. |
| `afk-skills` | component | The pop-up picks one skill to build by and any number to critique, from the bot's own skills and only what its host can run now, kept on the host apart from another project's, either clearing back to nothing, with no pickers on a plugin that predates them and its switch still working. | Two pickers over the profile's skills and two writes. | A component test asserts both pickers' options, the write, another project's own answer, the clears, and the pop-up without the feature. |
| `afk-switch-reasons` | component | Where the switch can't be offered: a host with no GitHub account says why once rather than as both the switch's reason and the frontier's refusal; a plugin too old to switch it shows the switch off and out of reach, reading Turned off and saying nothing about the plugin; and a project already on keeps a live switch with the reason under it. | The same pop-up's refusal line; the drift is recorded below. | A component test asserts the one reason line, the disabled switch with no spinner under it, and the live switch on a project already on. |
| `afk-stalled` | component | An AFK session nothing is working any more waits where the user finds it: Code's Waiting on you and, from 1280px, the sidebar's Waiting for input, each with the host's own reason under it. | Two renders from one plugin answer; the width is `useLarge`'s switch, not geometry. | A component test asserts both waiting lines and the reason under each at both widths, with a mocked media query. |
| `afk-stage` | component | The pop-up names the stage a staged task is in — Building, Gate check, Critiquing — read from the host on its own poll, and keeps naming it once the pickers change under it; a project with no critique skill is one run, with no stage to name. | A prefix over the host's own record. | A component test asserts each stage's prefix as the host's answer moves, and none for a one-run task. |
| `afk-claim` | plugin | Turning a project on has the host claim its oldest ready task — assigned and marked — so the pop-up says what it is working, the frontier no longer offers it, and a GitHub refusal leaves the switch on with its reason. | What it asserts is what the plugin decided: the claim sweep. ADR 0019 sends the plugin's own behaviour back to the plugin's suite. | Plugin tests: the claim takes the oldest ready task, one at a time, and a refusal keeps the switch on with its reason. The pop-up's working and refusal lines join the AFK component test (#304). |
| `afk-session` | plugin | AFK works its claimed task in a session of its own: the published chat record makes the Code row, titled after the task and marked AFK, and opening it shows one line naming the task rather than the brief. | The published session record is the plugin's; only the Code row's mark is the app's. | Plugin tests: the published record carries the AFK mark, the task's title and its opener. The Code row's mark joins the Code component test. |

### A bot's models — #305

Three keys: the fallback list, the subagent model, and a write the host never answers.

| Key | Verdict | What it asserts today | Why it moves | What replaces it |
| --- | --- | --- | --- | --- |
| `fallback-models` | component | A bot's fallback models are recorded on its host — two picks, one removed, never a third — and the rows grey out while a write is on its way. | A list's ordering and a form's writes over a faked plugin. | A component test asserts two picks in order, the removal, no third, and the greyed field held against the write. |
| `delegation-model` | component | The subagent model is recorded as the host's delegation model, cleared back to inherit, the field greyed while a write is on its way, and no field at all without the feature. | A picker and one write: the fallbacks' shape, on another field. | A component test asserts the write, the clear as its own write, the saving state, and no field without the feature. |
| `fallbacks-silent-host` | component | A host that takes a fallback write and never answers it: the field is given up on and comes back rather than staying greyed out with a save that never lands. | A timeout, which fake timers assert at no wall-clock cost. | A component test with fake timers asserts the field returns after the write's timeout. |

## The seven that stay, and why only a browser can assert each

Every one of these earns its browser by a mechanism no lower tier reproduces. They are what the
end-to-end registry holds once the other 56 keys leave (#314).

| Key | What it asserts today | Why only a browser can assert it |
| --- | --- | --- |
| `reattach` | A reply still streaming when the page reloads picks its run up again and finishes. | A live run outliving a real reload. A component test can remount a tree, but it has no run still going on a test host to rejoin, so it would pass whether or not reattachment works. |
| `live-poll` | `runs/live` is read by one shared poll: at most 3 reads in 25s with a session, its project and the sidebar all open. | A request rate over wall-clock, with three screens mounted at once. |
| `idle-requests` | An idle open chat makes at most 12 requests in 65s. | A request budget over 65 seconds of real time and a real fetch stack. |
| `foreign-run` | A run started elsewhere shows as running in Code and on the open session screen, is followed to its end, and leaves no duplicate. | A run this browser never started, on a host that owns it: the app only discovers it. |
| `compressed-run` | A chat another device started and Hermes compressed before this device loaded it lands its transcript and follows its run to its end — whether the rotation came before the run or mid-run. | A test host rotating the session id mid-run, the mechanism the plugin's run keying broke on. A faked HTTP boundary would answer the shape the code expects rather than the one the host sends. |
| `screens` | Projects, a project, Code, Routines and a chat load their data at 390 and 1024px, in light and dark, with no console error. | Real layout at two widths: a DOM without layout has no sizes. It is also where the sweep's visual snapshots live. |
| `stream-writes` | A streaming reply is written to IndexedDB in batches: at most 6 writes a second, where main wrote 7.5. | A write rate measured over a real stream's wall-clock. |

## The coverage a demotion leaves with no home

The 56 keys that leave — 51 demoted, 3 deleted as duplicates, 2 moved to the plugin — take away the
assertion of things a component test cannot see: geometry, rates over wall-clock, capture, and a
reload with a live stream. Four of those have a home: the two request budgets and the write rate stay
with `live-poll`, `idle-requests` and `stream-writes`, and the real reload stays with `reattach`
(`compressed-live`'s reload leg becomes a remount, which asserts the resumed state and not the
reload). No test has ever claimed a real audio capture — the flow ran on Chromium's fake microphone
and the component test stubs `MediaRecorder` — so nothing is lost there that was had. What is left
has no home, and each loss below is accepted today unless a seeded snapshot closes it.

A snapshot is of a screen `screens` already visits, in a state seeded on it. #314 forbids widening
that flow's set of screens, so a behaviour on a screen it never visits has no snapshot to land in.

| Behaviour | Asserted today by | After the demotion |
| --- | --- | --- |
| The collapsed sidebar's row heights and 44px targets | `sidebar-collapse` | The snapshots, if the 1024px pass seeds a collapsed sidebar — a state on a screen the flow visits, not a screen added. Loss accepted today; #314 could close it. |
| Pane adjacency at a tablet width | `panes` | The snapshots: `screens` visits Projects and Code at 1024px, where the list sits beside the item. |
| The slash menu's height cap | `slash-skills` | The snapshots, with the menu open on the chat screen's pass. Loss accepted today; #314 could close it. |
| The reserved cell sizes of a reply's images | `image-skeleton` | The snapshots, if that chat carries an image. Loss accepted today; #314 could close it. |
| The dimmed unsent bubble | `failed-send` | The class tokens are the component test's (#306 asserts the failed row shares the queued row's own); the rendered dimness is a pixel claim no snapshot makes. Loss accepted. |
| The full-viewport recording cover | `meetings` | Nothing: it is on a pop-up of a screen `screens` never visits, and #314 forbids adding one. Loss accepted. |
| The usage banner's responsive form | `usage-limit` | The snapshots, if the chat screen's pass carries an account near a limit, since the banner is drawn over that screen. Loss accepted today; #314 could close it. |
| The outputs drawer drawn as a sheet on a phone | `outputs` | Nothing: it belongs to a project session's screen, which `screens` never visits. Loss accepted. |
| The recovery code's wrap at a hyphen, between two of its groups | `recovery-code-rotation` | Nothing: the wizard is not a screen `screens` visits, and the wrap is CSS rather than a rule. Loss accepted. |
| A sender's Stop landing while the session id rotates | `compressed-live` | The app's rule is the component test's — Stop's request carries the rotated run and the reply settles. A real cancellation is covered by no flow, since `compressed-run` never presses Stop. Loss accepted (#307). |

## The one drift, and which way it is resolved

`afk-switch-reasons` opens by saying a plugin too old to switch AFK "offers no switch at all". Its
second scenario asserts the opposite: the switch is rendered (the flow counts one), disabled,
`aria-checked="false"`, reading *Turned off*. The app's rule is that a control the host cannot honour
is shown, in place, out of reach, as `AGENTS.md` states for AFK's switch — so the comment is the part at
fault.

- **The behaviour the comment describes is dropped.** Nothing asserts it, and `AfkSwitch`
  (`app/src/components/afk.tsx`) renders the row unconditionally, with no branch for a missing
  feature.
- **The behaviour the flow asserts is carried over** into the AFK pop-up's component test (#304),
  which keeps the disabled switch, one reason line rather than two, and a live switch on a project
  already on. A plugin too old to switch AFK gets no reason line, since the host gave none — the row
  reads *Turned off* and says no more — and the test asserts that rather than inventing words for the
  plugin.
- **The comment is corrected in #304**, where the pop-up's tests land, rather than here: this page
  records the drift, and the flow goes on asserting what the app actually does until it is deleted.

## What this page does not decide

Whether the seven run on a real Hermes is #313's question, and whether the snapshots seed the states
named above is #314's. This page only says which keys move, where each assertion goes, and what is
accepted if nothing picks it up.
