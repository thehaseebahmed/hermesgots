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
What a project session is doing — idle, working, waiting on the user, or closed by the user as resolved or discarded. Waiting is the user's move: an answer, an approval, a plan review, a stall, or a live pull request's checks to watch. A session whose subagents are still at work is working, whether or not a turn is live. Composed from the host's run status, its subagents and this device's own marks, not derived from one source.
_Avoid_: status, state machine

**Last activity**:
The most recent event a session has seen — a turn ending, its pull request moving, the session being resolved or discarded — worked out from those moments rather than stored as one.
_Avoid_: updated at, updatedAt, last update

**Read mark**:
When a device last had a session's thread rendered on it. It stays on that device, is never synced, and a session with anything newer has not been read there.
_Avoid_: last seen, read receipt, unread count

**Question**:
A bot's ask its user must answer before its turn can go on, drawn in place of the composer, and never kept back by work the bot has running.
_Avoid_: clarify, prompt, ask

**Approval**:
A bot's request to take a sensitive action, answered Once, Session, Always or Deny, drawn in place of the composer and, like a question, never kept back by running work.
_Avoid_: permission prompt, consent, authorization

**Card**:
A block Gots draws for itself inside a chat — a question, an approval, a subagent's work, a session's state — as opposed to a message, a chat drawn in a bot's Main thread, or the blocks of an interface the model drew.
_Avoid_: panel, box, widget, chip

**Conversation**:
The stored record of one exchange with a bot: the row a chat list shows and sync carries. A coding session's conversation also names its project.
_Avoid_: chat object, session record, thread

**Thread**:
A conversation's messages in the order they happened, as the screen draws them — what the agent said, what it ran, and what it thought. Every thread is drawn the same way, whoever it is with.
_Avoid_: transcript, message log, feed, timeline

**Thinking**:
What a model worked out before it answered, kept with the reply and drawn as rows in the thread: one per run — a run being one contiguous stretch of thinking between tool calls — each in the place it happened, above the tool call it precedes and below the call that broke it, so a turn that ran something shows its working-out on either side of what it ran. Rows drawn with nothing between them are one row, holding their stretches together. A row says what the turn is doing: its spinner while the thinking still arrives — on screen from the first moment the turn works, before a word of thinking arrives, except while a call runs (the tool row says that) or while the turn waits on the reader (the footer says that), and drawn before a word arrives as a status line with nothing to open — the one place the thread names thinking, never beside a footer line saying it too — and its label once the thinking is written down. It opens in the same sheet a call's details open in, holding the whole working-out as the reply's own markdown; the sheet never closes itself, a live run opened in it lands on its newest words and keeps them in view until the reader scrolls away inside it, and a run already written opens at the top. It reads "Thinking…" while it thinks, "Thought for 12s" where this device measured every stretch it holds, the spans added, and "Thought it through" where it did not; the thinking is kept with the reply on every device, the span only on the device's own row that measured it. Every thread draws it the same way — a chat's, a delegated agent's sub-thread, a coding session's own thread.
_Avoid_: chain of thought, scratchpad, reasoning trace

**Command**:
Something Gots itself does from the composer: opening a thread (a chat, where threads are off), settings, the Cheatsheet, or how a message sent mid-reply goes. A command never reaches the agent as a message.
_Avoid_: slash command, action, app skill

**Skill**:
One of a bot's named capabilities, written `/name` in a message — wherever the caret was when the slash menu picked it. Gots offers them from the slash menu; the bot's Hermes profile is what runs them.
_Avoid_: command, tool, plugin

**Slash menu**:
The list over the composer that a slash opens: the commands and the bot's skills.
_Avoid_: autocomplete, command palette, picker

**Cheatsheet**:
The sheet `/cheatsheet` opens from the composer: the keys a hardware keyboard can send in Gots and what each does, by group — and only the shortcuts whose switch is on.
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
The warning above a chat's composer that a provider account is nearly out of usage, or out of it.
_Avoid_: alert, limit banner, usage warning

**Bot**:
One Hermes profile the user has linked to Gots: its own agent, skills and settings, reached at the host it runs on.
_Avoid_: profile, agent, assistant

**Thread**:
One of a bot's chats, drawn as a card inside its Main thread at the time it was started. A project session is not one.
_Avoid_: conversation, session

**Main thread**:
A bot's one permanent chat and the screen its bot opens to: its messages land there first, the ones needing no thread stay there, and every thread it has is drawn inside it as a card. It can't be deleted.
_Avoid_: default chat, general chat, inbox

**Bot Chat**:
A bot's one chat surface: its Main thread and the threads drawn inside it as cards. A project session is not one.
_Avoid_: bot screen, chat screen, bot page

**Triage**:
The host's decision, for each message sent from the Main thread, whether it stays there, continues an older thread or opens a new one. Unsure means it stays.
_Avoid_: routing, sorting, dispatch

**Triage model**:
The model a bot's host makes that decision with. Nothing set means the bot's own model decides.
_Avoid_: router model, decision model

**Moved marker**:
What the Main thread shows in place of a message triage sent into an older thread, with the way to undo it. A message that opened a new thread is drawn there as that thread's card instead.
_Avoid_: redirect notice, forwarded message

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
The model a chat sends its turns with — the chat's own pick, else its bot's. Gots' own setting, and a wish: what runs is the host's.
_Avoid_: model choice, selected model, current model

**Model change**:
The host's record of the models a chat's calls ran on, one row per change. A thread's divider is drawn from these, wherever they name a turn; where they don't — the newest turn, or one still being written — the model this device sent it with stands until the host has recorded the call.
_Avoid_: model switch, model update, fallback

**Compaction**:
A point where Hermes compressed a chat's context, ending the session and continuing in a child. The host records when; the thread draws a divider above the first message written after it.
_Avoid_: compression event, summary

**Subagent**:
An agent a bot's turn sets to work on part of it, with its own session and its own sub-thread, whose work outlives the turn that started it.
_Avoid_: child, delegate, worker, sub-agent

**Subagent result**:
What a finishing subagent leaves in its bot's thread: its own message at the thread's end when it arrives, opening the sub-thread behind it.
_Avoid_: completion, delivery, summary message

**Sub-thread**:
The thread a subagent's own work draws — its thinking, what it ran and what it found — drawn as a chat's thread is.
_Avoid_: child thread, worker view, agent detail

**Subagent model**:
The model a bot's delegated tasks run on, set in its settings and held on its host as Hermes's own delegation model. Nothing set means a delegated task inherits the bot's own model.
_Avoid_: second opinion, delegation model, child model

**Session stop**:
The composer's control while anything in a session is at work: it ends the turn if one is live, and every running subagent the session holds, whichever turn started it. It stands where Send does while the box is empty, and typing brings Send back.
_Avoid_: cancel, abort, kill, stop all, interrupt

**Subagent line**:
The line at a thread's foot naming how many of its subagents are still at work — riding beside the live turn's own activity while it streams — which opens the **Subagent sheet**. It goes when the last of them ends.
_Avoid_: working line, count chip, running count, agent badge

**Subagent sheet**:
The sheet a **Subagent line** opens: the session's subagent cards, grouped Running then Finished, each running one stoppable there.
_Avoid_: agent list, delegation sheet, subagent drawer

**AFK**:
A project being worked without its user present. On, Gots claims its ready tasks and works up to its pick count at a time, within its bot's **pick budget**, and stops picking up while the bot's account is over its usage threshold, until the switch is turned off. A task runs one run on the project's **prompt**, unless the project has picked a **workflow**.
_Avoid_: autopilot, unattended mode, auto mode, yolo

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
How many tasks one bot's AFK may hold at once across all of its projects, from one to ten, set in the bot's Coding tab. Each project is still held to its own **pick count**, so the bot works the lower of the two.
_Avoid_: concurrency, parallelism, cap, quota, limit

**Refusal**:
Why a project's sweep claimed nothing, in the host's own words: GitHub's answer, a skill the workflow names that its bot no longer has, the account being over its usage threshold, or the bot's pick budget being full.
_Avoid_: error, failure, block

**Usage threshold**:
The share of the bot's account usage at which AFK stops picking tasks up, one number for the bot and off until it is set.
_Avoid_: cap, quota, budget, limit

**Deciding window**:
The usage window that answers whether a bot's account can still run: a balance with room left is capacity, and otherwise the window with the least left.
_Avoid_: tightest window, worst window, primary window

**Workflow**:
The named sequence of stages a project's AFK tasks are worked by, picked from the bot's own library. A project that has picked nothing runs one run on its prompt instead, and the library is offered only where the app's developer setting offers it.
_Avoid_: pipeline, flow, template, playbook

**Preset**:
A workflow the bot ships with: read-only, and forking into a copy of the bot's own the moment it is edited.
_Avoid_: template, default, built-in

**Stage**:
One unit of a workflow's work, named by the workflow: one run of the session, made of the steps it applies, or a checkpoint the host answers itself.
_Avoid_: phase, step, node

**Run**:
One turn a task's session spends on one stage — or on the task's whole work, when it has picked no workflow — posted by the host and named by its own id. A stage ends only when its run ends, and no other turn on that session can end it.
_Avoid_: turn, attempt, job, execution

**Round**:
One go at a stage: its run, the commands that run executed, its findings and why it stopped. A stage takes more than one round only when something asks for it — a loop's retry, a rewind, or the host resuming a run it lost.
_Avoid_: attempt, try, iteration, pass

**Step**:
One of the bot's skills that a stage's run applies, in the order the workflow lists them. A stage with no steps runs its built-in brief instead.
_Avoid_: skill, action, task

**Checkpoint**:
A stage with no steps whose answer the host works out itself, so it costs no run: today the gate's exit codes, and the condition a loop repeats on.
_Avoid_: gate stage, verification step, approval

**Loop**:
A marked span of a workflow that repeats while the checkpoint ending it fails, up to the cap the workflow sets, and then stalls the task naming the failure.
_Avoid_: retry, iteration, cycle, until-loop

**Shipping stage**:
The one stage of a workflow whose run may open the task's draft pull request. Every other stage's run is refused it.
_Avoid_: ship stage, release stage, PR stage

**Pipeline**:
A task's own passage through its workflow: the workflow as it stood when the task started, the stage and round it is on, and one row per round saying what it ran and what it found. What the session's pill and the sheet behind it read.
_Avoid_: workflow, run chain, progress

**Rewind**:
The agent sending a task back to a stage it has already run, as a new round of it, with the reason it gives. The host posts that stage's run, and the stages it left keep what they ran.
_Avoid_: restart, rollback, reset, go back

**Pending rewind**:
A rewind the agent has asked for that the record holds until the run which asked for it ends — the moment the stage moves, so no record ever names a stage a differently-briefed run is working.
_Avoid_: queued rewind, scheduled rewind

**Build**:
The default preset's first stage: where a task's work is written, and the stage that ends at the gate rather than at a pull request.
_Avoid_: implementation stage, implement, coding, development

**Gate**:
The commands a build names to be checked by, which the host runs in the worktree and reads the exit codes of. A task that fails its gate stalls rather than being reviewed.
_Avoid_: checkpoint, approval, quality gate, verification step

**Test**:
The default preset's checkpoint: it passes only a build whose gate call was made, every command exited zero, the tree is committed and the branch is ahead of its base.
_Avoid_: gate stage, verify stage, CI

**Review**:
The default preset's stage where a task's build is reviewed by the skills the workflow lists, and which opens the draft pull request. The session reviews in its own run; no reviewer is spawned unless a skill asks for one.
_Avoid_: critique, code review, review stage, self-review, PR review

**Summary**:
The default preset's last stage: the wrap-up read when the user is back. It runs nothing until a skill is put in it, and it never writes to the pull request.
_Avoid_: report, closing, digest, recap

**Findings**:
What a review step reported to the host: a count against the skill that raised it, shown on the pipeline's Review row.
_Avoid_: issues, comments, results

**In review**:
A task whose pull request is open and waiting on the user.
_Avoid_: pending, awaiting merge, PR open

**gots-got-it**:
The mark Gots leaves on a task it has claimed.
_Avoid_: claimed, in-progress, assigned, taken

## Media

**Attachment**:
A file the user adds to a message so the agent can use it — a photo, a clip, a recording, or any document.
_Avoid_: upload, document, attached file

**Media**:
An attachment the thread can show rather than only hand over: an image, a video or an audio recording. Everything else is an attachment the thread offers as a download.
_Avoid_: image, file, rich media

**Gallery**:
The row of media in a thread: images and video side by side, each opened in the platform's own viewer. Audio is not in it; it sits in the thread as its own row.
_Avoid_: carousel, thumbnails, media strip, lightbox

## Dictation

**Dictation**:
Speaking a message into Gots instead of typing it. Its voice bar holds the composer's place while it runs, and its words land in the composer when it ends.
_Avoid_: voice input, speech-to-text, transcription, STT, voice typing

**Voice bar**:
The strip that holds the composer's place during a dictation: how long it has been going, how loud the room is, and Stop, Send and Cancel.
_Avoid_: recorder, overlay, dictation sheet, mic sheet

**Take**:
One dictation as the app holds it — from the tap that starts it to the write that lands its words — one at a time per bot.
_Avoid_: session, stream, job, recording

**Piece**:
The unit a dictation uploads: one stretch of its recording, cut at a pause or at its length cap, transcribed by the host while the rest is still being spoken.
_Avoid_: chunk, slice, segment, part

**Cleanup**:
The pass that tidies a dictation's finished words — fillers, punctuation, casing, numbers, a spoken list as a list — without rewording them. It runs once over the whole text when the dictation ends, on the bot's own model, bounded; one that misses its budget, fails or comes back much longer or shorter than the text leaves the words as the host heard them.
_Avoid_: polish, post-processing, formatting, correction

**Vocabulary**:
The words a bot's dictation leans towards: names, product words, jargon. A short list, the bot's own, edited on its Dictation tab; it biases what the host hears and how the finished text is cleaned up.
_Avoid_: dictionary, custom words, hint, keyterms

**Host speech model**:
The model on a bot's host that hears its dictation. Its size is the trade between waiting and being right.
_Avoid_: whisper model, STT model, engine, ASR

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

**Notification settings**:
The screen that decides what a device is told about: the app's own list of categories on the web, and the phone's own list of channels in the Android app.
_Avoid_: notification types, notification preferences, alert settings
