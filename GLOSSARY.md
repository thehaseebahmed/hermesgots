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
What a project session is doing — idle, working, waiting on the user, or closed by the user as resolved or discarded. Composed from the host's run status and this device's own marks, not derived from one source.
_Avoid_: status, state machine

**Conversation**:
The stored record of one exchange with a bot: the row a chat list shows and sync carries. A coding session's conversation also names its project.
_Avoid_: chat object, session record, thread

**Thread**:
A conversation's messages in the order they happened, as the screen draws them — what the agent said, what it ran, and what it thought. Every thread is drawn the same way, whoever it is with.
_Avoid_: transcript, message log, feed, timeline

**Thinking**:
What a model worked out before it answered, drawn above the reply as a line that folds once the answer starts. It is kept with the reply; how long it took is kept only where this device watched it think.
_Avoid_: chain of thought, scratchpad, reasoning trace

**Command**:
Something Gots itself does from the composer: a new chat, settings, or how a message sent mid-reply goes. A command never reaches the agent as a message.
_Avoid_: slash command, action, app skill

**Skill**:
One of a bot's named capabilities, written `/name` at the front of a message. Gots offers them from the slash menu; the bot's Hermes profile is what runs them.
_Avoid_: command, tool, plugin

**Slash menu**:
The list over the composer that a slash opens: the commands and the bot's skills.
_Avoid_: autocomplete, command palette, picker
**Usage window**:
One thing a provider account can run out of, as that provider measures it: a period, which resets, or a balance, which doesn't.
_Avoid_: quota, plan limit, usage bar

**Limit notice**:
The warning above a chat's composer that a provider account is nearly out of usage, or out of it.
_Avoid_: alert, limit banner, usage warning

**Bot**:
One Hermes profile the user has linked to Gots: its own agent, skills and settings, reached at the host it runs on.
_Avoid_: profile, agent, assistant

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
How an MCP server is doing, as its row says it in a line: healthy with a tool count where the host knows one, or why it isn't working. A server that is switched off says `Off` there, because that is how it is doing; the switch itself is the separate control beside it. Where the host can start Server access for what it says, the line is the tap that starts it.
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

**Subagent model**:
The model a bot's delegated tasks run on, set in its settings and held on its host as Hermes's own delegation model. Nothing set means a delegated task inherits the bot's own model.
_Avoid_: second opinion, delegation model, child model

**AFK**:
A project being worked without its user present. On, Gots claims its ready tasks and works up to its pick count at a time, and stops picking up while the bot's account is over its usage threshold, until the switch is turned off. A task runs one run on the project's **prompt**, unless the project has picked a **workflow**.
_Avoid_: autopilot, unattended mode, auto mode, yolo

**Prompt**:
How a project's AFK work is carried out, told to the run beside AFK's fixed rules: the words the user writes for it. It lives on the host with the project, starts as the bot's default method, and an empty one means that default again.
_Avoid_: instructions, system prompt, template, playbook

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

**Refusal**:
Why a project's sweep claimed nothing, in the host's own words: GitHub's answer, a skill the workflow names that its bot no longer has, or the account being over its usage threshold.
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

## Dictation

**Dictation**:
Speaking a message into Gots instead of typing it. Its voice bar holds the composer's place while it runs, and its words land in the composer when it ends.
_Avoid_: voice input, speech-to-text, transcription, STT, voice typing

**Voice bar**:
The strip that holds the composer's place during a dictation: the words heard so far, how loud the room is, and Stop, Send and Cancel.
_Avoid_: recorder, overlay, dictation sheet, mic sheet

**Phrase**:
One stretch of a dictation between two pauses: the unit that finishes, is cleaned up, and stops changing.
_Avoid_: chunk, piece, segment, utterance

**Committed text**:
The words of a dictation the host has settled on. Gots never changes them again; a phrase still being heard is not committed yet.
_Avoid_: partial, interim, stable prefix, live text

**Cleanup**:
The pass that tidies a finished phrase — fillers, punctuation, casing, numbers, a spoken list as a list — without rewording it.
_Avoid_: polish, post-processing, formatting, correction

**Vocabulary**:
The words a bot's dictation leans towards: names, product words, jargon. It biases what the host hears and how a phrase is cleaned up.
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
