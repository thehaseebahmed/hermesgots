# Gots

Gots is a client for one Hermes Agent server: chat with your bots from a phone, and watch the work they do on your behalf.

## Language

**Account session**:
Who you are to Gots. Signed out means it has ended, and only a fresh sign-in brings it back.
_Avoid_: login, account, user, "logged out"

**Identity**:
The sign-in service an account session lives in. The Android app talks to it directly; the browser goes through the library.
_Avoid_: auth server, login service, GoTrue

**Sign in with GitHub**:
The only way to get an account session. On Android it leaves the app and comes back through a Custom Tab.
_Avoid_: log in, authorise, connect account

**Vault**:
The key that encrypts what syncs. The server can only hold it wrapped by a passkey or a recovery code.
_Avoid_: sync key, master password, encryption account

**Sync**:
The encrypted copy of your bots, appearance switches and chat lists, kept for you on the sync server.
_Avoid_: backup, cloud, account data

**Sync server**:
The site that holds the synced copy: the origin Gots is read from in the browser, and the site the Android app was built for.
_Avoid_: backend, cloud, "the server"

**Recovery code**:
The code that comes with every vault and is the only way into sync on a device without a passkey; on Android, the only way in at all. Setup always issues one, and Settings can replace it with a fresh code.
_Avoid_: backup code, recovery phrase, seed

**Passkey**:
An optional way to unlock sync on a device whose authenticator can hold one, sitting beside the recovery code and never in place of it.
_Avoid_: biometric login, fingerprint login, WebAuthn credential

**Sync locked**:
The account session is intact but this device holds no vault key, so sync stays off until it is unlocked (the step Gots shows as "Unlock sync").
_Avoid_: signed out, re-login, locked account

**Derived fact**:
Something worked out about a bot's data rather than read straight from it — how many tasks are done, what a context is measured against, what usage cost, why a tool call failed.
_Avoid_: calculated value, computed field, aggregate

**App-level calculation**:
A derived fact worked out in the app from what a bot's host holds. Gots doesn't have any: a fact a host could work out is worked out on the host.
_Avoid_: client-side computation

**Session state**:
What a project session is doing — idle, working, waiting on the user, or closed by the user as resolved or discarded. A run in flight is read first: while the session's own run runs, it is working, and no wait mark from a moment before it starts counts (it is what puts the row in the Code list's Working). Waiting is the user's move: an answer, an approval, a plan review, a stall, or a live pull request's checks to watch. A session whose subagents are still at work is working, whether or not a turn is live, and so is one whose finished subagents still owe it a wake turn — the window between the last subagent ending and that turn starting, when nothing runs and nothing streams and the bot is about to carry on. A **session close** still running is none of these: the user already ended the session, and what the host does afterwards is the close. Composed from the host's run status, its subagents, its owed wakes and this device's own marks, not derived from one source.
_Avoid_: status, state machine

**Session close**:
The host's work of shutting a session down after the user ends it: its worktrees removed except those whose work is uncommitted or unpushed, its open pull requests closed and their pushed branches deleted on GitHub. Delete and Discard ask for it, and it runs on the host beside the row rather than behind the button.
_Avoid_: cleanup, teardown, close job, close task, discard run

**Close report**:
What a session close ended with — the worktrees it kept and why, each repository's closed pull request and deleted branch, and anything it could not do — kept on the host until a device reads it, and told once per device.
_Avoid_: result, outcome, close status, close error

**Run finished**:
A run that has ended and has no active subagents — the one answer to whether the work it started is over, read by whatever draws or tells it: a turn's end ends its own stream, and a delegation that turn set to work carries the run on past it, so neither is read alone.
_Avoid_: turn over, run complete, session idle

**Last activity**:
The most recent event a session has seen — a turn ending, its pull request moving, the session being resolved or discarded — worked out from those moments rather than stored as one.
_Avoid_: updated at, updatedAt, last update

**Read mark**:
When a device last had a chat's thread rendered on it. It stays on that device, is never synced, and a chat with anything newer than its mark has not been read there — one this device has never opened has no mark at all, so nothing about it is called unread. It is what a Code row's dot measures a session's last activity against, and what the sidebar's bot row measures the bot's own threads against — Main among them, never a coding session of that bot's, since that row leads to Main.
_Avoid_: last seen, read receipt, unread count

**Question**:
A bot's ask its user must answer before its turn can go on, drawn in place of the composer, and never kept back by work the bot has running. One call may put several, and they are one card: a page per question with arrows between them, the page showing the one the host waits on, because a host asks them one at a time and moves on only as each is answered.
_Avoid_: clarify, prompt, ask

**Approval**:
A bot's request to take a sensitive action, answered Once, Session, Always or Deny, drawn in place of the composer and, like a question, never kept back by running work.
_Avoid_: permission prompt, consent, authorization

**Card**:
A block Gots draws for itself inside a chat — a question, an approval, a subagent's work, a session's state — as opposed to a message, a chat drawn in a bot's Main thread, or the blocks of an interface the model drew. It comes in two shells and three kinds: a card that waits on the reader floats over the thread in its own colour, a card that records what happened lies flat and muted, and a card that stops the session — read-only, resolved, discarded — floats and stays mute, because it says a decision was taken rather than raising a fault. Its title is the app's words and keeps the app's face; what the bot said inside it takes the **Code face** in a session.
_Avoid_: panel, box, widget, chip

**Conversation**:
The stored record of one exchange with a bot: the row a chat list shows and sync carries. A coding session's conversation also names its project.
_Avoid_: chat object, session record, thread

**Code face**:
The face a project session's own words are drawn in, as against the app's face that chrome keeps
everywhere: what the bot said and wrote — its reply, its thinking, its questions and their choices,
an approval's description, a subagent's goal — and what the user typed or said in that session,
inside a card as much as beside one. A card's title, a button, a count, a pill and a sheet's heading
are the app's words and keep the app's face, and so does everything the app measured or worked out.
_Avoid_: mono mode, code mode, terminal font

**Thread**:
A conversation's messages in the order they happened, as the screen draws them — what the agent said, what it ran, and what it thought. Every thread is drawn the same way, whoever it is with: one look per element on a bot's chat and a project session alike, and the one thing a session adds is its **Code face** over what the bot and the user said.
_Avoid_: transcript, message log, feed, timeline

**Away**:
A host this device could not reach — a read got no answer, or none in time — so what the thread shows is what this device holds. It is said in two wordings, because the app can tell the two causes apart only by whether this device has a network at all: "You're offline" where it does not, and "This host isn't answering" where it does. The words last only as long as the host is away: the page reads at its fast pace while they are up, slower the longer the host stays away, and any answer from the host takes them back — a read that lands, an error it answers, a run's own events (ADR 0082).
_Avoid_: offline (for the host), disconnected, down, unreachable

**Thinking**:
What a model worked out before it answered, kept with the reply and drawn as rows in the thread: one per run — a run being one contiguous stretch of thinking between tool calls — each drawn above the tool row whose call it follows and touching it — one block, on the reply's own left edge with its text — so a tool row never lands between two thought rows and a turn that ran something reads as its working-out over the work it led into. Rows with nothing between them but tool rows are one row, holding their stretches together; text, media, a card, a steer, an approval or another reply still keeps rows apart. A turn that has had no word of thinking yet draws no row of its own — the status line says the turn is thinking — and a stretch that follows a question or a delegated agent's card sits after that card. A row says what the turn is doing: the word "Thinking" pulsing in the row's own muted colour while the thinking still arrives — no sign ahead of it, the row starting on the reply's edge whether it runs or is finished (ADR 0092) — and never while a call runs (the tool row says that) or while the turn waits on the reader (the status line says that); its measured label once the thinking is written down. The colour is the row's while it works and after: a row says its state by its pulsing words, never by a loader or its grey. It is the one place a working turn says it is thinking, so the status line below never says it too and turns no loader of its own while the row is turning one. It opens in the same sheet a call's details open in, holding the whole working-out as the reply's own markdown; the sheet never closes itself, a live run opened in it lands on its newest words and keeps them in view until the reader scrolls away inside it, and a run already written opens at the top. While it thinks it says that one word, not the status line's rotating one (its name for assistive tech and its sheet's heading stay "Thinking…"); it reads "Thought for 12s" where this device measured every stretch it holds, the spans added, and "Thought it through" where it did not; the thinking is kept with the reply on every device, the span only on the device's own row that measured it. Every thread draws it the same way — a chat's, a delegated agent's sub-thread, a coding session's own thread.
_Avoid_: chain of thought, scratchpad, reasoning trace

**Work row**:
The shape a reply draws its own work in: one line 29px tall on the reply's own edge, holding only the
label that says what the work is doing, and opening when there is something to open. It carries no
mark at its start: a row at work pulses its own words in the muted colour it already wears, so it
starts and stays on the reply's edge whatever it is doing, and the chevron that opens it stands one
gap past its words rather than at the row's edge. A group whose calls failed keeps that muted row and
says so on a line under its words, which are the destructive colour — the failure is never worn by the
row itself (ADR 0092, ADR 0096). A thought row and the tool group its calls merged into are both work
rows; a turn that has said nothing yet draws neither, and the status line — the one row that keeps a
sign — says it instead.
_Avoid_: tool row (which is a work row holding calls), step, item, log line

**Thread card**:
A bot's thread drawn inside its Main at the moment its opener was sent: the message in the reader's
own bubble where any device can name it, and under it the thread's state, its name and the way in. A
card is not a turn and wears no avatar. Its bubble says the message and its line says the thread's
name, never the other way round, and a thread whose opener nothing can name draws no bubble rather
than the name (ADR 0082, ADR 0090). It wears one shape whichever way it was opened: the line reads
"View thread", and a thread triage opened carries Undo outside the card, at the end of its row
(ADR 0094).
_Avoid_: thread row, thread item, preview

**Opener**:
The message a thread began with — what its card's bubble draws, and the moment the card stands at.
The screen that sends a thread's first turn records its words and its time on the thread's own
record, and the host records them for a thread its triage opens, so a device that has never opened
the thread still draws it; what the device holds for the thread wins where it holds something
(ADR 0090, ADR 0096).
_Avoid_: first message, preview, snippet

**Sort**:
A list's order, said as the fact it ranks by — created, last activity, title, name — and a direction
arrow. The control reads one sign and one name: the arrow at its start, then the key's name. The
chosen key carries the same arrow in the menu, and picking it again flips it; every list that sorts
itself sorts this way (ADR 0091, ADR 0095). The one exception is a title bar that holds another control
beside it — Code's search — where the sort is the arrow alone, its key named in the menu and to a
screen reader (ADR 0097).
_Avoid_: sort mode, order by, asc/desc toggle

**Refused call**:
A tool call a hook or the reader turned back before it ran, whose result is a note rather than anything the call produced. A thread draws nothing for a progress reminder's own refused call — the note is the host talking to the model — so only the call the model repeats is the reader's, and a refusal any other hook made, or an approval the reader denied, still shows. That one is not a failure: the call's row keeps the muted tone with no reason under it, and its sheet says it was refused rather than completed (ADR 0098).
_Avoid_: blocked call (that is the host's word for one shape of it), failed call, denied call

**Status line**:
The one line under a reply that says what the turn is doing while it works — "Writing", "Running bash", the host's own words for it — a loader and those words together, both in the muted colour the thread's work rows wear. Its words are the only ones that rotate: where the turn is thinking and no thought row holds it, it says the rotating thinking word and turns the loader itself. The rotation is for the reader's eye alone: a screen reader is told the plain state — "Thinking", "Writing" — so the flavour never becomes a fresh announcement every four seconds. It says nothing while a thought row above says the turn is thinking, and nothing while a call runs save the count of subagents at work. When the turn waits on the reader ("Waiting for your answer") its wait words stand in that place, whole and muted with the loader turning beside them, and the count rides at their end. Once the turn is done and its subagents still run, that count is its only words. The count is the one thing in the line in the info colour, and a loader wears that colour only when it turns for the count alone — any other loader wears the colour of the words it turns for. A failed or stopped reply draws no status line at all; its error or "Stopped" stands in that place.
_Avoid_: footer (that is where the line stands, not what it is), progress text, activity

**Command**:
Something Gots itself does from the composer: opening a thread (a chat, where threads are off), settings, the Cheatsheet, or how a message sent mid-reply goes. One that acts — settings, the Cheatsheet, opening an empty thread — never reaches the agent as a message. One that takes the rest of the message as its own (`/thread`) is a prefix instead: picked, it lands in the field, and Send opens the thread on what was typed after it (ADR 0096).
_Avoid_: slash command, action, app skill

**Skill**:
One of a bot's named capabilities, written `/name` in a message — wherever the caret was when the slash menu picked it. Gots offers them from the slash menu; the bot's Hermes profile is what runs them.
_Avoid_: command, tool, plugin

**Slash menu**:
The list over the composer that a slash opens: the commands and the bot's skills.
_Avoid_: autocomplete, command palette, picker

**Cheatsheet**:
The sheet `/cheatsheet` opens from the composer: the keys a hardware keyboard can send in Gots and what each does, by group — the shortcuts whose switch is on, and a key whose meaning a switch picks drawn the way that switch leaves it.
_Avoid_: hotkey list, keyboard help, command palette, cheat sheet

**Built-in skill**:
A skill that ships with Hermes and was seeded into the bot's profile. It can be switched off; it is never removed.
_Avoid_: bundled skill, core skill, essential skill

**Hub skill**:
A skill installed from a skills hub. Removed through the hub's own uninstall.
_Avoid_: downloaded skill, store skill, registry skill

**Your skill**:
A skill written on the bot's own profile, by you or by the bot, rather than one that arrived built in, from the Hub or from a plugin.
_Avoid_: custom skill, own skill, local skill, user managed skill

**Plugin skill**:
A skill a Hermes plugin on the host provides. Gots can switch it off and change nothing else about it.
_Avoid_: plugin-provided skill, provided skill, managed skill

**Project skill**:
A skill a repository carries in its own skills folder. It belongs to the project, not the bot, so the Skills tab leaves it out.
_Avoid_: repo skill, repository skill

**Skill sheet**:
One skill's own panel, opened by its row: its SKILL.md, its linked files, and where it came from, with the host's Readiness and Setup where it has them. No URL of its own — it is about one skill, not a place.
_Avoid_: skill page, skill detail screen, editor

**Usage window**:
One thing a provider account can run out of, as that provider measures it: a period, which resets, or a balance, which doesn't.
_Avoid_: quota, plan limit, usage bar

**Limit notice**:
The warning a chat's composer carries above its text that a provider account is nearly out of usage, or out of it.
_Avoid_: alert, limit banner, usage warning

**Bot**:
One Hermes profile the user has linked to Gots: its own agent, skills and settings, reached at the host it runs on.
_Avoid_: profile, agent, assistant

**Main thread**:
A bot's one permanent chat and the screen its bot opens to: its messages land there first, the ones needing no thread stay there, and every thread it has is drawn inside it as a card. It can't be deleted.
_Avoid_: default chat, general chat, inbox

**Bot Chat**:
A bot's one chat surface: its Main thread and the threads drawn inside it as cards. A project session is not one.
_Avoid_: bot screen, chat screen, bot page

**Chat threads**:
Whether a bot may start a new thread at all: Developer's switch, off by default and carried by the account, and the one thing that decides it. Off, no bot's chat offers a start command, a new chat's first send lands in that bot's Main, and the host is never asked to triage — a thread that already exists still lists in Main, opens and sends (ADR 0120).
_Avoid_: bot threads (that is the layout), thread mode, threads on

**Thread lane**:
The pane a bot's Chat opens beside Main for the one thread it holds: half the room the sidebar leaves while it holds one, and not there at all once the thread is closed, so Main has the whole width. A bot's alone — Code, the projects, the meetings, research and the apps keep their list lane.
_Avoid_: sidebar, third pane, detail pane, right pane

**Split handle**:
The separator between a bot's Main and its Thread lane: dragged, it sets the share the two read at, and a double-click or Enter returns it to half. Not a **Divider**, which is a thing that happened between two turns.
_Avoid_: divider, gutter, grip, drag bar

**Blank chat**:
A chat-next chat with no record yet: the bot's face, an empty thread and the composer, whose first send makes the chat and hands the message to the thread that draws it (ADR 0111). It is the legacy layout's New chat; under bot threads a chat starts at its bot's Main instead, and with **Chat threads** off its first send lands there too.
_Avoid_: new chat screen, draft chat, empty chat

**Triage**:
The host's decision, for each message sent from the Main thread, whether it stays there, continues an older thread or opens a new one. Unsure means it stays. It runs only while **Chat threads** are on, and with them off nothing is asked and every message stays.
_Avoid_: routing, sorting, dispatch

**Triage model**:
The model a bot's host makes that decision with. Nothing set means the bot's own model decides.
_Avoid_: router model, decision model

**Moved marker**:
What the Main thread shows in place of a message triage sent into an older thread, with the way to undo it — the undo riding the same system line the thread's name stands in. A message that opened a new thread is drawn there as that thread's card instead (ADR 0094). A marker stands among the cards and the dividers by its own time, under a day heading of its own (ADR 0097).
_Avoid_: redirect notice, forwarded message

**Steer**:
A message the user sends into a run already under way, drawn where it reached the agent: the user's own bubble, splitting the reply's work at that point, with "Steered" muted under it. The words are the user's, so the bubble is theirs; the caption is the one thing saying they arrived mid-run rather than as a new message.
_Avoid_: interrupt, injection, mid-run message

**Host**:
The machine a bot's Hermes runs on: where its profiles, its MCP servers and the keys they use live.
_Avoid_: server, backend, machine

**MCP server**:
A source of abilities a bot's host runs and the bot draws from, added and switched on one bot at a time.
_Avoid_: connector, integration, plugin, tool

**User managed server**:
An MCP server the bot's own configuration holds, so Gots can switch it off or take it away.
_Avoid_: own server, config server, local server, third-party server

**Plugin managed server**:
An MCP server a Hermes plugin on the host provides. Gots shows it and cannot change it.
_Avoid_: plugin server, provided server, built-in server

**Custom server**:
An MCP server added by typing its address or its command, rather than picked from the Catalogue. User managed once it is added.
_Avoid_: manual server, raw server, own MCP

**Health**:
How an MCP server or a skill is doing, as its row says it in a line. A server is healthy with a tool count where the host knows one, or says why it isn't working; a skill says `Ready`, `Off`, or `Doesn't load` with the host's reason. A thing that is switched off says `Off` there, because that is how it is doing; the switch itself is the separate control beside it. Where the host can start Server access for what a server's line says, the line is the tap that starts it.
_Avoid_: status, state, badge, indicator

**Server sheet**:
One MCP server's own panel, opened by its row: its Config, the block the host holds, and its Tools, what it offers. No URL of its own — it is about one server, not a place.
_Avoid_: server page, server detail screen, editor

**Catalogue**:
The MCP servers Hermes offers to add, as the host knows them.
_Avoid_: store, marketplace, directory, library

**Server access**:
The permission an MCP server needs from the service it talks to. Gots starts the flow; the browser finishes it, and the host holds the result.
_Avoid_: authorization, OAuth, sign in, connect

**Model pick**:
The model a chat sends its turns with: its own pick where the user made one, else its bot's default, else the host's model. It is fixed at the chat's first send — the model in effect then is written into the chat's own pick — so a Default model changed later leaves a chat already under way where it was, and a message triage moves into a thread is that thread's next send, so a thread holding no pick takes the model the moved message named. Main is the exception, following the default for as long as it lives. Gots' own setting, sent with the turn and still the host's to run.
_Avoid_: model choice, selected model, current model

**Default model**:
The model a bot's next turns run on, set in its Chat settings: the host's own main model where the plugin can write it, else a default the bot holds itself, synced with the bot. It chooses a model for chats to come, never one already under way — a chat keeps the pick its first send fixed, and Main is the exception, following the default live. Tapping Default on a chat writes that choice down as a marker with no model in it, which is how a started chat is told to follow the default from its next send; a chat that never had it tapped pins the model in effect at its first send instead.
_Avoid_: bot model, base model, default pick

**Pin**:
The model a chat keeps, fixed at its first send: the model in effect then — the bot's default, else the host's main model — written into the chat's own pick and read back by every turn after it, so a Default model changed later leaves that chat where it was. Once written it follows nothing: not the default, not the bot's fallback chain, and a synced record that names no model leaves it as it is. Main carries none, following the default for as long as it lives, and the plugin reads a pin back to run a session's own turns with the app closed — an AFK task's, and a wake's. It is the model that is pinned, not the session's place: a session placed at the top of a list is **Pinned**, a different thing.
_Avoid_: lock, freeze, sticky model

**Pinned**:
A session held above the Code list's status groups, in a band of its own: positional and personal, it changes nothing about the session — not its state, not the model it runs, not whether anything sweeps it — and it leaves the group its claim would put it in rather than being drawn twice. It outlives the session changing state, it is ordered by the list's own sort, and a search or a project chip drops the band with the other headers. A project carries the same word in the project list, where it means the same thing — a place above the list rather than a claim about the item — though that list orders its pins by when they were pinned and the Code list orders them by the sort the reader picked.
_Avoid_: favourite, star, bookmark, sticky

**Model change**:
The host's record of the models a chat's calls ran on, one row per change. A thread's divider is drawn from these, wherever they name a turn; where they don't — the newest turn, or one still being written — the model this device sent it with stands until the host has recorded the call.
_Avoid_: model switch, model update, fallback

**Divider**:
A thing that happened between two turns, drawn as one piece: a squiggle on either side in the fainter border colour, broken by its words in the muted one at the thread's smallest size, and spoken as a separator. A day in a bot's Main, a compaction in any thread, and a model change in a project session — a chat draws no model change, and only a Main draws a day.
_Avoid_: separator, rule, hairline, timestamp

**Progress reminder**:
A note the host writes to the model while a turn works, drawn as a system line where it fell in the work, saying the bare words "Progress reminder" and opening the host's note unparaphrased. It stands outside the calls beside it, so a tool row beside it counts only calls that ran.
_Avoid_: nudge, check-in, reminder row

**Compaction**:
A point where Hermes compressed a chat's context — in place under the same session, the default, or by ending the session and continuing in a child. The host records when, the context's size where it measured one, and the summary's own row for one made in place. The thread draws a divider above the first message written after it, or inside the reply it fell in, at its seam, where the record is matched by that row (else by the summary's own time) — the row the record names is the seam on whichever side it was written, since one made while a reply runs is that reply's own row rather than a user row. A divider stands between two drawn messages and nowhere else — a user's words, or a reply's words or calls — so the top of a chat whose archive isn't loaded, the foot of a chat nothing follows, and a Main whose turns were all triaged away carry none. Between two drawn messages there is one divider, the one whose label names a size over a bare one.
_Avoid_: compression event, summary

**Carried copy**:
A turn a compaction kept, written live under a fresh row id with its text and times untouched while the original became an archived row.
_Avoid_: copied turn, re-emitted message, duplicate

**Archived row**:
A row a compaction left behind: off the chat's live transcript, drawn only once the reader reaches back far enough for it.
_Avoid_: old row, compacted message

**Live cluster**:
The three rows a working reply ends on, in one order at its foot: the thought row, the tool group's row, then the status line. The order governs those rows and nothing already drawn — a thought row that streamed earlier stays above the call it led into — and a reply that thinks and calls more than once draws the order per cluster with one status line under its last words. The thought row is absent until a word of thinking arrives, and the status line says the turn is thinking in that absence; where a call runs the tool group's row alone speaks, and the status line keeps only the **Subagent count**. One loader turns at a time, wearing the colour of the words it turns for.
_Avoid_: work block, status stack, footer rows

**Live window**:
The rows written since the last compaction, which the host counts as the chat's own and a device holds without reaching back.
_Avoid_: recent rows, first page

**Subagent**:
An agent a bot's turn sets to work on part of it, with its own session and its own sub-thread, whose work outlives the turn that started it.
_Avoid_: child, delegate, worker, sub-agent

**Subagent result**:
What a finishing subagent found, read in its **Sub-thread** from its card or the **Subagent sheet**. It is never a message in the bot's thread: the host's delivery row for it is bookkeeping the thread does not draw.
_Avoid_: completion, delivery, summary message

**Wake turn**:
The turn the host starts on a chat when a subagent finishes, so the bot reads the result and carries on. Its prompt is the model's input and draws nothing; its reply, tools and questions draw as any turn's do, and it is the main run continuing the work, not a side effect to hide.
_Avoid_: wake run, notification turn, callback turn

**Sub-thread**:
The thread a subagent's own work draws — its thinking, what it ran and what it found — drawn as a chat's thread is.
_Avoid_: child thread, worker view, agent detail

**Subagent model**:
The model a bot's delegated tasks run on, set on the _Delegation_ page and held on its host as Hermes's own delegation model. Nothing set means a delegated task inherits the bot's own model.
_Avoid_: second opinion, delegation model, child model

**Session stop**:
The composer's control while anything in a session is at work: it ends the turn if one is live, and every running subagent the session holds, whichever turn started it. It stands where Send does while the box is empty, and typing brings Send back.
_Avoid_: cancel, abort, kill, stop all, interrupt

**Subagent count**:
The status row's count of how many of a thread's subagents are still at work — at the end of the line's words while the turn works or waits, and its only words once the turn is done — which opens the **Subagent sheet**. It is the one thing in the row in the info colour, and its loader wears that colour only when it turns for the count alone. It goes when the last of them ends.
_Avoid_: subagent line, working line, count chip, running count, agent badge

**Subagent sheet**:
The sheet a **Subagent count** opens: the session's subagent cards, grouped Running then Finished, each running one stoppable there.
_Avoid_: agent list, delegation sheet, subagent drawer

**AFK**:
A project being worked without its user present. On, Gots claims its ready tasks and works up to its pick count at a time, within its bot's **pick budget**, and stops picking up while the bot's account is over its usage threshold, until the switch is turned off. A task's whole work is one run told by the project's **prompt**.
_Avoid_: autopilot, unattended mode, auto mode, yolo

**Host prompt**:
Everything Hermes tells a session before Gots's own words: the profile's identity from its `SOUL.md`, its system prompt, and the project's context files, the `AGENTS.md` chain above the worktree. The host tells it and Gots never copies it, so editing `SOUL.md` changes what a session is told without touching Gots.
_Avoid_: system prompt, persona, injected prompt

**Prompt**:
How a project's AFK work is carried out, told to the run beside AFK's fixed rules: the words the user writes for it, or the ones they pick from the **prompt library**. It lives on the host with the project, starts as the bot's default method, and an empty one means that default again.
_Avoid_: instructions, system prompt, template, playbook

**Prompt library**:
The prompts kept for AFK work, one library per account: named pieces of text shared by every bot, project and signed-in device, from which a project picks the words its **prompt** runs with.
_Avoid_: snippet library, template library, prompt bank, presets

**Ready task**:
A task the user has marked for an agent to work, by the tracker's `ready-for-agent` mark.
_Avoid_: approved, agent-ready, todo, queued

**Task**:
One specified piece of work on a project, carried by one of that project's GitHub issues. AFK works one task per session.
_Avoid_: ticket, work item, card, job

**Blocker**:
A task that has to be closed before another one can start.
_Avoid_: dependency, prerequisite, upstream

**Stalled**:
An AFK session nothing is working any more: its run failed, was interrupted by the user, or stopped without finishing. It keeps its task, its claim and its transcript, and waits for the user beside the questions and approvals waiting sessions are shown with. A run the host lost rather than one the user stopped is not a stall: the host resumes it once.
_Avoid_: stuck, broken, paused, aborted

**Frontier**:
The ready tasks that can be started now: their blockers are all closed, and nobody has claimed them.
_Avoid_: backlog, queue, ready list, board

**Claim**:
Taking a task so nothing else picks it up. A claimed task is out of the frontier.
_Avoid_: assign, lock, pickup

**Hold**:
One of the tasks a project's AFK switch has claimed, with the session working it: the host's own record, one row per task in flight, kept until the task's work is in review. A finished task lets go of its hold and leaves the claim, and a session the user closes gives both back.
_Avoid_: lock, lease, slot

**Pick count**:
How many tasks a project's AFK will hold at once, from one to five, set in its AFK pop-up.
_Avoid_: concurrency, parallelism, workers, slots

**Pick budget**:
How many tasks one bot's AFK may hold at once across all of its projects, from one to ten, set in its bot's Coding settings under Away From Keyboard. Each project is still held to its own **pick count**, so the bot works the lower of the two.
_Avoid_: concurrency, parallelism, cap, quota, limit

**Refusal**:
Why a project's sweep claimed nothing, in the host's own words: GitHub's answer, the account being over its usage threshold, or the bot's pick budget being full.
_Avoid_: error, failure, block

**Usage threshold**:
The share of the bot's account usage at which AFK stops picking tasks up: a used percent from 50 to 100, one number for the bot and off until it is set, set in its Coding tab. Judged afresh at every pickup, so a task already claimed runs to the end of its work; a **refusal** names the deciding window and its percent against it.
_Avoid_: cap, quota, budget, limit

**Deciding window**:
The usage window that answers whether a bot's account can still run: a balance with room left is capacity, and otherwise the window with the least left.
_Avoid_: tightest window, worst window, primary window

**In review**:
A task whose pull request is open and waiting on the user.
_Avoid_: pending, awaiting merge, PR open

**Watermark**:
The one line Gots leaves at the bottom of every pull request description it writes, naming Gots, its site, and that it is a Hermes plugin. The tool writes it, not the model.
_Avoid_: footer, signature, attribution block, branding, co-author line, byline

**gots-got-it**:
The mark Gots leaves on a task it has claimed.
_Avoid_: claimed, in-progress, assigned, taken

## Rooms

**Room**:
A chat on one Host shared by several of its bots: what the user says reaches every member, and their
answers stand in one transcript. Its roster is fixed when the room is made, and its rounds are the
Host's to drive.
_Avoid_: group chat, group, channel, room chat

**Member**:
One of the bots a room holds. It answers in the room as itself, with its own name and picture.
_Avoid_: participant, teammate, occupant, seat

**Roster**:
The members a room holds, fixed when the room is made. Changing them means a new room.
_Avoid_: member list, participants, seats

**Disband**:
End a room: its work is stopped and the Host leaves a tombstone where its record was, so no device
draws it again. The word is the Host's, and the plugin only relays its answer.
_Avoid_: delete, archive, close, remove, leave

**Room write**:
The Host's declared ability to make, rename and disband a room. Where a Host declares none of it, the
app draws none of those controls rather than one that could only come back refused.
_Avoid_: room admin, write access, room management

**Room log**:
Everything that has happened in a room, in the Host's order, each event numbered in the room's own
sequence. The thread is what the screen draws of it.
_Avoid_: transcript, history, event log, room history

**Needs you**:
A room waiting on the user: a member's approval, its question, or a member addressing the user.
_Avoid_: waiting, attention, unread, needs attention

## Media

**Attachment**:
A file the user adds to a message so the agent can use it — a photo, a clip, a recording, or any document.
_Avoid_: upload, document, attached file

**Inline**:
An attachment whose bytes ride in the message itself, which only a model that reads images can take. Everything else reaches the agent as a path on the host.
_Avoid_: embedded, attached copy, base64 upload

**Media**:
An attachment the thread can show rather than only hand over: an image, a video or an audio recording. Everything else is an attachment the thread offers as a download.
_Avoid_: image, file, rich media

**Gallery**:
The row of media in a thread: images and video side by side, each opened in the Previewer. Audio is not in it; it sits in the thread as its own row, and its tap opens that same Previewer.
_Avoid_: carousel, thumbnails, media strip, lightbox

**Previewer**:
The app's own full-screen look at one piece of media, holding the name, the size and where the reader is in the media it was opened on — a message's, or the one file a Library row opened: a photo at its own shape — magnified by a pinch or a double tap about the point touched, and dragged only as far as it overflows the pane — a clip on a player that starts paused, a recording on a player. A file the app can't show is handed to the platform instead — a new tab on the web, the phone's own app in the Android app — and never drawn in the Previewer.
_Avoid_: lightbox, image viewer, gallery popup, media sheet

**Library**:
The files an agent made, kept in a project's own tree and listed by folder — the tab a project opens them from, and the outputs a session filed. A tap opens the file the way a thread does: in the **Previewer** from a **Signed URL**, or handed to the platform where the Previewer can't draw it.
_Avoid_: outputs folder, artifacts, files tab, downloads

**Signed URL**:
The address a bot's host mints for one file — a signature over its path, the profile and a few minutes of expiry — which the app draws every photo, clip and recording from, and a file's row opens. It stands in for the bot's key, which an `<img>` or a `<video>` can't send. It is asked for once per file and kept only while the expiry it names is worth drawing from: a page outlives the minutes a signature lives for, so another is minted when one runs out.
_Avoid_: media link, token URL, blob URL, download link

**Media cache**:
What this device keeps of the media it has drawn — a photo's bytes, and the first frame of a clip, since a clip is never played in the thread — so a photo drawn once draws again with no **Signed URL** and with the host away, and a clip's cell takes its frame without touching the clip. Bounded, oldest first, and read before the host is asked anything at all.
_Avoid_: thumbnail cache, offline cache, image store, prefetch

## Speech-to-text

**Speech-to-text**:
Speaking a message instead of typing it. In Gots its voice bar holds the composer's place while it runs, and its words land in the composer when it ends; in another app the **Bubble** starts the take and its words land in the field that app has focused.
_Avoid_: voice input, transcription, STT, voice typing, speed-to-text

**Bubble**:
The one control Gots leaves on a phone's screen while the keyboard is up: a mark that starts one **Take** and puts its words in the field that keyboard belongs to. It stays for a take and for five seconds after it even when the keyboard goes, so a take can be stopped, and dragging it onto the bin at the bottom of the screen turns it off. It hears with its own bot, picked in Bubble settings and never moved by opening a chat (the first bot it hears with is kept until another is picked; the selected bot answers only while its own is disabled or gone), and it runs with Gots closed. Two switches are the phone's and not the app's — drawing over other apps, which draws the mark, and the accessibility service, which types the words and says when the keyboard is up — so switching the Bubble on asks for each in turn, and the mark takes itself away when either is switched off.
_Avoid_: overlay, floating widget, floating button, mic button, dictate anywhere

**Voice bar**:
The strip that holds the composer's place during speech-to-text: how long it has been going, how loud the room is, and Stop, Send and Cancel.
_Avoid_: recorder, overlay, dictation sheet, mic sheet

**Take**:
One speech-to-text run: from the tap that starts it to the answer that lands its words, one at a time per bot. The app names it with a **Take id** when the recording starts, so the host can hold its **Pieces**, hear each as it arrives and answer for the whole of it at the **Confirm**.
_Avoid_: session, stream, job, recording

**Take id**:
The app's name for one **Take** on the wire: minted when the recording starts, carried on every **Upload** and on the **Confirm**. A **Retry** mints a fresh one, so a Piece that arrives late can never join the take that replaced it.
_Avoid_: session id, job id, take key

**Upload**:
One **Piece**'s audio arriving on a bot's host, stamped with the **Take id** and its index within the take, and carrying the bot's **Vocabulary** and the hint. It is answered with nothing: the words it becomes belong to the take, and only the **Confirm** answers those.
_Avoid_: clip, chunk, push, POST

**Confirm**:
The one call that ends a **Take**: it names how many **Pieces** the take has, and the host answers with the words that landed, the words as **Transcribed**, how long the take took to say, and how it was tidied. It is the only call that carries a take's words and the only one that runs **Cleanup**; a host holding fewer Pieces than it names refuses it, saying which are missing.
_Avoid_: finish, finalize, commit, stop call

**Take wait**:
The longest a **Take**'s **Confirm** may take before the bar gives up: one number the host states, the same for **Send** and for **Stop**, covering the Pieces it still owes and its **Cleanup** at the bot's level. A Confirm past it fails the take, which keeps its audio for a **Retry**.
_Avoid_: timeout, deadline, budget, client wait

**Confirm span**:
What a host does for a take between a **Confirm** arriving and its answer leaving: the **Pieces** it still owes decoded, and the **Cleanup** at the bot's level. It is what **Take wait** bounds and what the bench measures; it is not how long the take took to say, and on a host resolving a cloud **Speech provider** it also holds the whole take's upload and decode.
_Avoid_: latency, response time, round trip, take latency

**Stop to text**:
What a device waits after the last word of a take: the recorder closing, the last **Upload**, the **Confirm**'s round trip and the words being put in the composer. Measured on the device and nowhere else — a fake host cannot feel a decoder — and it is not a **Take wait**.
_Avoid_: stop latency, felt latency, perceived speed, delay

**Dictation**:
One finished take as the log keeps it: the bot that heard it, when, how many words and how long they took to say, two texts — **Transcribed**, the words the host's speech model wrote down, and **Cleaned up**, the words as they landed in the composer after Cleanup — and what tidied them: the **Cleanup level**, whether the Cleanup changed anything, and the **Speech provider** and model behind it. It is kept on that bot's host and mirrored on the device, which is what the AI Dictation screen's History lists by month and its Stats count.
_Avoid_: recording, transcript, entry, voice note

**Transcribed**:
The words a take's speech provider wrote down, before Cleanup: one text, its **Pieces** joined by the host in the order they were cut. A dictation keeps it beside the words that landed, and the two are the same text when the cleanup found nothing to change or never answered.
_Avoid_: heard, raw, raw transcript, uncorrected text, whisper output

**Cleaned up**:
The words a take landed in the composer once Cleanup had its say: the dictation's own text, the one its words are counted on and Copy copies. It is the same text as **Transcribed** where the cleanup found nothing to change or never answered, and the sheet then draws one block rather than two.
_Avoid_: tidied, cleaned, corrected text, polished

**Piece**:
The unit a take uploads: one stretch of its recording, cut at a pause or at its length cap, and stamped with its index in the take. The host hears it as it lands, while the rest is still being spoken, and it answers no words of its own.
_Avoid_: chunk, slice, segment, part

**Cleanup**:
The pass that tidies a take's finished words, once over the whole text inside the **Confirm**, on the bot's cleanup model, at the bot's **Cleanup level**. What it may change is its level's; what no level may change is what the take says. It is bounded, and one that misses its budget, fails or answers something no level would produce leaves the words as the host heard them. It runs only for a take its host heard: a take that left the host is transcribed once, and lands as **Transcribed**.
_Avoid_: polish, post-processing, formatting, correction

**Cleanup level**:
How much Cleanup may change in one bot's takes: **None**, **Light**, **Medium** or **High**. **None** makes no call at all — the heard words are what lands. **Light** takes out fillers, false starts and slips, and repairs grammar, punctuation, casing and numbers. **Medium** does Light's work and tightens: wordiness, redundancy and run-ons, without dropping information. **High** does Medium's work and compresses — it may restructure a sentence, drop hedges and low-value words, and reorder within it. No level adds content, answers a question the take asked, or changes a name, a number or what the person asked for. The level is the bot's, kept on its host and read for every take its host hears, and a bot that has never picked runs **Light**. A bot whose takes leave the host keeps its level, unread, for a return to Local.
_Avoid_: cleanup tier, style, strength, aggressiveness, mode, preset

**Vocabulary**:
The words a bot's speech-to-text leans towards: names, product words, jargon. A short list, the bot's own, edited in its Speech-to-text settings; it is spelled as listed in the cleanup of every take, and it also biases what the host hears wherever the bot's **Hearing prompt** is sent.
_Avoid_: dictionary, custom words, hint, keyterms

**Hearing prompt**:
What a take's host speech model is given before it listens: the host's own initial prompt, a hint naming the bot, the chat and its repos, and the bot's **Vocabulary**. Sent, it steers spelling; not sent, the model hears the audio alone and the cleanup repairs the names instead. It never carries the take's text: every **Piece** is heard on its own, so a sentence cut at a pause is not carried across it. The bot's, kept on its host and fixed for a take when its first Piece lands, and offered on its Speech-to-text page only while Developer is on.
_Avoid_: whisper prompt, initial prompt, decoder prompt, context, hint

**Host speech model**:
The model on a bot's host that hears its speech-to-text. Its size is the trade between waiting and being right, and the host times that trade itself: a **Hearing measurement** says how many seconds of speech each model it has hears in a second on that machine.
_Avoid_: whisper model, fast-whisper, STT model, engine, ASR

**Hearing measurement**:
What a host timed of itself, once — its own speech models each decoding one short recording, with the load allowed for — kept per model and per machine: the realtime factor, how many seconds of speech a model hears in a second here, and the row it recommends. The model picker's rows state it and name the one recommended; a row nobody measured says so rather than quoting a figure, and a measurement taken on another machine — or on other bytes than the recording now shipped — is never drawn as this host's.
_Avoid_: benchmark, speed score, realtime estimate, perf number, probe result

**Speech provider**:
The one backend a bot's Hermes sends audio to. Until it is picked it is **Automatic**, and the host decides — its own model first, then whichever cloud provider it holds a key for.
_Avoid_: STT backend, engine, speech service, voice provider

**Transcribed on the host**:
The path a bot's speech-to-text actually runs: the host's own model where its Hermes resolves `local` or `local_command`, and otherwise the cloud **Speech provider** its host picked — the same one its voice notes use. The app reads which from the host (`info.dictation.provider`), and the Speech-to-text page says so where a take would leave the host.
_Avoid_: heard on the host, local mode, offline mode, on-device

## Settings

**Gots setting**:
A setting that is Gots's own — the app, the device or the Gots plugin's own host values — rather than a knob on the bot's Hermes. Settings are grouped by this split.
_Avoid_: app setting, local setting, device setting

**Legacy chat UX**:
The Developer setting that restores the old chat-list sidebar, drawing Recents instead of the bots (ADR 0110). Bot threads is the layout otherwise, on every device.
_Avoid_: old layout, classic mode, bot threads off

**Hermes setting**:
A setting of the bot's Hermes itself: the same knob the Hermes Dashboard shows, named as Hermes names it. The General page is the Dashboard's own Config > General tab mirrored, so its rows are whatever that host's schema holds and its cards are the sections the host files them under — a key Hermes adds later is a row without an app release.
_Avoid_: bot setting, server setting, config

**Host default**:
The value a Hermes setting runs at when the bot's host holds none of its own — the default Hermes itself was built with. A row shows it muted, and a reset returns the setting to it.
_Avoid_: empty, blank, unset value, fallback

**Bot page**:
The screen Settings > Bot opens onto: what the bot is — its switches (Enabled where it is linked, Mute notifications, Test connection), then _Bot Profile_ (name, image, Progress updates), then _Hermes_ (its server's address and key, drawn only where the bot is unlinked) — and every setting page behind it in one card under _Settings_. It is the page a withheld page lands on, and the one screen that asks the bot's host for nothing.
_Avoid_: bot settings list, general old, bot overview

**Delegation**:
A setting page of the bot's Hermes itself, the Dashboard's Config > Delegation tab mirrored through the same body as General. It leads with the subagent model, then the host's own scalar keys in one card with no caption. The endpoint keys (`base_url`, `api_key`, `api_mode`) and `fallback_providers` are never drawn.

**General old**:
The address `/settings/bots/<id>/general-old` and nothing more: the page Settings > Bot > General held before the host's own General tab took its place, kept whole there so a reader who wants it back can still reach it while the rows it held lead the bot page.
_Avoid_: legacy settings, old general tab, deprecated page

**Progress reminder**:
A note Gots puts in front of the bot asking it to say, briefly, what it has done and what is next, then to carry on with the work rather than end there: a reply of words and no tool call ends the run. Where the list has fallen behind it also asks for it, naming `todo_list`. A bot's reminders are set per bot, on its **Bot page** under Progress updates, as Off, Quiet, Normal or Chatty — and none of them promise the bot will speak: how much it says is the model's own choice. A thread draws nothing for the note, since it is the host talking to the model; the one place it is drawn is the device's own developer view, behind **Show progress reminders** in Developer settings, where it stands as a row of its own with the note behind a tap.
_Avoid_: nudge, check-in, status ping, verbosity, quiet mode

## Diagnostics

**Network log**:
The record this device keeps of its own requests to a bot's host, while Developer settings' **Network log** switch is on: one **request** for each call the app made, in the order it made them, held newest-first and only as far back as its cap reaches. It is this device's observation — a request is there because this phone made it — so it never syncs, never leaves the device except when a person copies it, and never says what a bot did.
_Avoid_: telemetry, metrics, performance data, trace, diagnostics

**Request**:
One call this device made to a bot's host, as the network log holds it: the route the app names it by, the bot it was for, when it was asked, how long until its answer began, the status it answered with, and how it ended — answered, refused, never landed, timed out or stopped. A request that opens a stream holds its first frame too, which is what reads as how long connecting took. It is neither a turn's duration nor a model's thinking, which are the host's to measure.
_Avoid_: span, sample, entry, event, latency

**Stream open**:
The wait between asking a bot's host for a stream and its first frame arriving: the time to first byte, plus however long the host took to send its first event. It is the closest this device comes to a connect time — DNS, TCP and TLS happen below it and are not visible here — so the strip draws it as **Connected in**, never as a handshake's own figure.
_Avoid_: connect latency, handshake, connection time, round trip

**First words**:
The wait between this device sending a message and the reply's first words arriving, with the network, the host's queue and the model's own start all inside one figure. It is what a person means when they say a bot is slow, it is kept only for a message this device sent, and it is never called network time nor compared with a request's own duration.
_Avoid_: response time, latency, time to first token, bot latency

## Testing

**Tier**:
One of the three places a test can sit — unit, component or end-to-end — each named for the class of failure it owns.
_Avoid_: level, layer, test type, pyramid

**Flow**:
One path a user takes through the app in a real browser, against a test host.
_Avoid_: test, case, scenario, spec

**Sweep**:
The end-to-end flows run together as one pass. Not AFK's sweep, which passes over a project's tasks.
_Avoid_: suite, run, regression set, full test

**Test host**:
The stand-in for a bot's Hermes that a test talks to, answering in the shapes the real one answers. It is not a Host: what it says is no evidence about the machine a bot's Hermes runs on.
_Avoid_: fake, stub, fixture

## Generative replies

**Interface**:
What a reply draws in place of a stretch of its text: a handful of Gots' own components — a card, a table, a list, a callout, a chart, a map — chosen and filled by the model. A reply may carry more than one, in the order they appear, and one that can't be drawn is the text it came from.
_Avoid_: widget, generated UI, component tree, card set, view

**Component library**:
The components an interface may be made of, and what each takes and means. The app writes it once; the host tells it to the model. Not the app's Library, which is the files an agent made.
_Avoid_: palette, vocabulary, catalogue, kit, widget set

**Block**:
One fenced stretch of interface code inside a reply's text. A finished block draws an interface, redraws an earlier one in its place, or draws nothing.
_Avoid_: fence, code block, snippet

**Patch**:
A block that names an earlier interface's id and redraws that interface in its place; it draws nothing of its own.
_Avoid_: update, diff, override

**Component reference**:
The page that shows every component the library offers — a live drawing, its source and its props. A reader's document, not the model's.
_Avoid_: gallery, component gallery, library page, showcase

## Canvases

**Canvas**:
A page of plain HTML a bot writes for you, keeps on its host and draws in a sandbox you use directly — a tracker, a planner, a dashboard. It has data of its own and is changed only by talking to its bot in its canvas session.
_Avoid_: app, space, studio, gadget, widget, mini-app, artifact

**Canvas session**:
The one long-lived conversation that belongs to a canvas, reachable only from that canvas. It is never a thread, never a card in Main and never triaged, and it carries the canvas's name as its title.
_Avoid_: canvas chat, build session, edit thread

**Canvas sheet**:
The canvas session raised over the canvas on a phone, where the page and its chat cannot share the screen. It opens at half height from the Edit pill, is dragged up to the full screen, and is swiped down to leave the page in view.
_Avoid_: canvas drawer, edit mode, split view, bottom bar

**Version**:
One saved state of a canvas's HTML, made by every write its bot does. Undo steps back to the one before; a canvas's data is not part of a version.
_Avoid_: revision, snapshot, draft

**Canvas data**:
What a canvas keeps for itself — the ticked boxes, the logged runs — stored on its host apart from its versions, so undoing an edit never loses it.
_Avoid_: state, storage, store, database

**Point**:
Tapping an element of a canvas while editing it, so the message you send names that element.
_Avoid_: select, pick, inspect, element picker

**Pinned canvas**:
A canvas that has its own row in the sidebar, on every device.
_Avoid_: favourite, starred, shortcut

**Declared tools**:
The tools a version of a canvas says it may call, named by its bot when it writes that version and enforced where the canvas calls the host. A declared tool is asked about the first time the canvas calls it, and only an allowed one is called. Unrelated to an **Approval**, which a bot asks for mid-run.
_Avoid_: permissions, agreed tools, scopes

**Host shape**:
One of the four reads a canvas may make of its own bot — usage, routines, projects or sessions — answered where the page's call arrives, each a projection of what this bot already holds, without being declared or asked about.
_Avoid_: data source, tool, endpoint

## Notifications

**Push**:
A notification a device is sent for something that happened while the app was closed — a session waiting on the user, or news about one.
_Avoid_: alert, ping, message, notification

**Kind**:
What a push is about: a question waiting, a pull request merged, a mission ready. It says what happened, never whether the device hears about it.
_Avoid_: event, event type, reason

**Category**:
The thing a device switches: one or more kinds that arrive together. It is the only unit a device decides with, and each platform decides where it is switched.
_Avoid_: notification type, group, topic, preference

**Channel**:
A category as a phone holds it — one record per category in Android's notification settings, which is where a phone switches that category.
_Avoid_: topic, group, notification class

**Routine message**:
A message a routine posts into a chat as the bot: written into that chat's own history, so the thread draws it, the bot remembers saying it and the user can reply to it. It names the routine that wrote it, and opens with an aside opener when it arrives while the chat is in a turn or just after one.
_Avoid_: notification, card, notice, automation message

**Routine run**:
The execution a routine message came from, opened from that message as a transcript with no composer: a run's session refuses turns and allows reading.
_Avoid_: job run, execution, log, cron session

**Notification settings**:
The screen that decides what a device is told about: the app's own list of categories on the web, and the phone's own list of channels in the Android app.
_Avoid_: notification types, notification preferences, alert settings

**Gots plugin**:
The plugin Gots installs into a bot's Hermes host, enabled under the name `gots`. It was called `memento`; the old name survives only where older sessions still carry it.
_Avoid_: Memento, memento plugin, the Hermes plugin
