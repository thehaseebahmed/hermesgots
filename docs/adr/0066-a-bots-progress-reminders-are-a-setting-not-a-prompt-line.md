# A bot's progress reminders are a setting, not a prompt line

Until now a bot said what it was doing because two things asked it to: a line in the prompt every
run is told ("Post a short update between checkpoints: what landed, what's next"), and — since #672)
— a hook that blocks a tool call after a long silent stretch with the same ask. The user now wants
to choose, per bot, how chatty the bot is. That choice is recorded here, in three decisions.

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
as a promise about the bot that the system cannot keep, so the row is Progress reminders, its values
are Off, Normal and Frequent, and a line under it says the bot still decides how much to say.

**The numbers stay on the host and are never shown.** Normal asks every twenty tool calls and
Frequent every ten; Off asks never. Twenty and ten are counts of tool calls — an implementation
detail of the loop, not something a reader should weigh — so the app sends a level name and the host
owns the threshold, which also means changing the counts later is not an app release. A bot whose
host holds no level runs at Normal, which is what every bot did before this setting existed, so
installing it changes nobody's behaviour.

**The level is read on every tool call**, not once per turn or per session. A user who turns
reminders off while a long run is in flight means it: the next call is not blocked. The cost is one
read of the profile's own settings store per tool call, which is a keyed read in a local sqlite file
and is dwarfed by the tool call it precedes.
