# A bot's progress reminders are a setting, not a prompt line

**Amended 2026-10-30**: a Developer switch on the device, *Show progress reminders*, has the thread
draw each reminder as a row of its own where the refused call was, outside the run's tool group and
uncounted in it, opening the note unchanged on a tap — on both chat screens, on a live run and from a
transcript. It is a display choice of the tester's device: it changes nothing about the four levels,
the counts or the hook, nothing is written to a bot's host, and with the switch off the thread draws
what it drew before. The decision below that a refused call is never drawn, and the sentence saying
the app draws nothing for the call a reminder lands on, both read as amended.

Until now a bot said what it was doing because the prompt every run is told asked it to ("Post a
short update between checkpoints: what landed, what's next"). The user now wants to choose, per bot,
how chatty the bot is, at one of four levels. That choice is recorded here, in the decisions below,
alongside the reminder this branch adds: a hook that counts a turn's silent tool calls and blocks one
with the same ask.

**The prompt stops asking, and the hooks are the only enforcement.** Two things asking for the same
behaviour have to be changed together or they drift, and they answer to different clocks: the prompt
is fixed when a session starts, so a bot's level could not change it mid-run, while the hook reads
the level on every call. The line also costs tokens on every turn of every bot, including the bots
that chose Off. So the update sentence leaves the shared do-rules, and what a bot says is asked for
by a reminder the hook puts in front of it — one mechanism, one place to change, one thing to test.
The failure sentence beside it ("Say what you tried when something keeps failing, before you try
again") stays: it reports a blocked attempt, which is not chattiness and which nothing else asks for.
A consequence taken deliberately: Away From Keyboard runs draw on the same rules, so they lose the
line too and follow the bot's level like any other session. The alternative — excluding them from
reminders, as the first version of #672 did — would have left unattended runs with no update
discipline at all, and their transcript is what the user reads the morning after.

**The four levels are Off, Quiet, Normal and Chatty, on the user's call, and only one of them names
what Gots does.** The argument the first version of this ADR made stands, and is kept here for the
next reader: a level cannot say how often the bot reports, because that is the model's choice and no
setting can promise it — a bot told nothing may still narrate everything, and one asked every ten
calls may answer in one clause — so Off, Normal and Frequent named Gots's own behaviour, while Quiet
and Chatty read as a promise about the bot that the system cannot keep. The user wanted the plainer
words knowing what they promise, so the levels are `off`, `quiet`, `normal` and `chatty`. Three
things carry the cost now the names no longer do: the sentence under the row (how much the bot says
is still its own call) stays for exactly this reason and not by habit, this paragraph keeps the
argument so the next reader knows the names were chosen against it, and the host is the only place a
level is written down. The control sits on the row rather than drilling into a pick: a four-way
control is a switch in all but shape, and ADR 0055 lets a control that acts where it sits do exactly
that.

**The numbers stay on the host and are never shown.** Quiet asks every fifty tool calls, Normal every
twenty-five, Chatty every ten; Off asks never. A count of tool calls is an implementation detail of
the loop, not something a reader should weigh — which is why the row says the four names and never
the four numbers — so the app sends a level name and the host owns the threshold, which also means
changing the counts later is not an app release. A bot whose host holds no level runs at Normal. A
store written before the four levels reads `frequent` as `chatty`, the same ten calls, so that bot
behaves exactly as it did, and a write naming it is stored as `chatty` — a second device on a cached
build keeps working mid-update instead of meeting a refusal; `normal` keeps its name and takes the
new count. That is not the old behaviour, and the difference is deliberate: the prompt line above
leaves for every bot, so a Normal bot that used to say something at each checkpoint now says nothing
until twenty-five calls pass with no words. A user who wants chatter as before has Chatty, and a bot
that is asked still decides how much it says.

**A reminder asks for the todo list as well as the words.** A long silent stretch is exactly when a
bot's plan drifts from what it is doing, and that plan is the one thing the user reads on the phone
mid-run, so the same ask carries one clause asking for the list — worded as the prompt's standing
rule words it ("keep the todo list current"), and naming no tool, since the todo tool answers to two
names (`todo_list` and the older `todo`) and a note that picked one would send a bot after a tool it
hasn't got. It carries permission to leave the list alone when the plan hasn't moved. It is asked at
every level, Quiet included: the rarer the ask, the longer the drift it finds. It is asked and not
enforced — a bot with no list is not told to invent one, and a bot that already brought the list up to
date answers by writing the sentence about its work and nothing else — because the list is the bot's
own plan and a nudged plan is worth less than none. The todo call the bot then makes stays a card in
the thread: the list changing is work the reader may want to see, unlike the note that asked for it.

**A stretch is continuous since the agent last said anything.** Any reply that carried text restarts
the count, and a reply of tool calls alone does not, which is what makes "twenty-five continuous
calls" mean silence rather than activity. The count keeps running while a bot is Off, so turning
reminders back on lands on the next call rather than a whole stretch later: the bot has been silent
for everything counted so far, and that is exactly what the user just asked to hear about.

**A reminder is internal, and says so.** The note is the host talking to the model, and a bot that
answers it by announcing "I was asked to update you" would hand the reader the machinery instead of
the work, so the note's last sentence tells the model not to mention it or the reminder at all. That
is the same reason the app draws nothing for the call it lands on, said to the only party who can
leak it: the model's own reply is the one part of this mechanism the user reads.

**A refused call is never drawn; the card the reader sees is the call that ran.** Blocking a call
means Hermes writes the block's message into the transcript as that call's result, so the note Gots
wrote to the model arrived in the user's thread as a card with an error mark on work that never
happened — on every reminder, at every level. The app now skips that card whole: the call, its
result, and the pair's place in the run, matched on the note's pinned first line, which is the same
trick and the same reason as the wake run's header — nothing in the row says who refused it, and a
pinned line is a shape only this hook writes. Only this hook's refusals are skipped, because a
security hook's block is a thing the user should read and its note carries its own words. What the
reader gets instead is the model's update and then the same call, run this time, which is what the
transcript would show if the reminder had never been needed. The device's developer view is the one
exception, and reads as amended at the top of this page: with *Show progress reminders* on, the
refusal comes back as a row of its own rather than as the call's card, saying what it is instead of
wearing an error mark.

**The app offers all four names and an older host refuses the ones it doesn't hold.** The vocabulary
is the host's, but a refusal is something a user can read, so the app draws the four options the
current plugin answers to and lets a plugin that predates them say so in its own 400 rather than
guessing which three that host knows. Read the other way, a level the app has no name for still shows
as Normal, except `frequent`, which it reads as Chatty — so a newer app never draws Normal over a host
that is actually Chatty, and a newer host's own store migrates `frequent` before the app ever sees
it.

**The level is read on every tool call**, not once per turn or per session. A user who turns
reminders off while a long run is in flight means it: the next call is not blocked. The cost is one
read of the profile's own settings store per tool call, which is a keyed read in a local sqlite file
and is dwarfed by the tool call it precedes.
