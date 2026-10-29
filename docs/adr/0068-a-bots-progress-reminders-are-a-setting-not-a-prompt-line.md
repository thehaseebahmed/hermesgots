# A bot's progress reminders are a setting, not a prompt line

Until now a bot said what it was doing because the prompt every run is told asked it to ("Post a
short update between checkpoints: what landed, what's next"). The user now wants to choose, per bot,
how chatty the bot is. That choice is recorded here, in three decisions, alongside the reminder this
branch adds: a hook that counts a turn's silent tool calls and blocks one with the same ask.

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

**The three levels are named for what Gots does, not for what the bot will do.** Off, Normal and
Frequent say how often Gots asks. They cannot say how often the bot reports, because that is the
model's choice and no setting can promise it: a bot told nothing may still narrate everything, and
one asked every ten calls may answer in one clause. Naming the levels Quiet, Normal and Chatty read
as a promise about the bot that the system cannot keep, so the row is Progress updates, its values
are Off, Normal and Frequent, and a line under it says how much the bot says is still its own call.
The control sits on the row rather than drilling into a pick: a three-way control is a switch in all
but shape, and ADR 0055 lets a control that acts where it sits do exactly that.

**The numbers stay on the host and are never shown.** Normal asks every twenty tool calls and
Frequent every ten; Off asks never. Twenty and ten are counts of tool calls — an implementation
detail of the loop, not something a reader should weigh — so the app sends a level name and the host
owns the threshold, which also means changing the counts later is not an app release. A bot whose
host holds no level runs at Normal, the count the default reminder has always used. That is not
quite the old behaviour, and the difference is deliberate: the prompt line above leaves for every
bot, so a Normal bot that used to say something at each checkpoint now says nothing until twenty
calls pass with no words. A user who wants the old chatter back has Frequent, and a bot that is
asked still decides how much it says.

**A stretch is continuous since the agent last said anything.** Any reply that carried text restarts
the count, and a reply of tool calls alone does not, which is what makes "twenty continuous calls"
mean silence rather than activity. The count keeps running while a bot is Off, so turning reminders
back on lands on the next call rather than twenty silent calls later: the bot has been silent for
everything counted so far, and that is exactly what the user just asked to hear about.

**The level is read on every tool call**, not once per turn or per session. A user who turns
reminders off while a long run is in flight means it: the next call is not blocked. The cost is one
read of the profile's own settings store per tool call, which is a keyed read in a local sqlite file
and is dwarfed by the tool call it precedes.
