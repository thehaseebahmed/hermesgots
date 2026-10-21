# The interface switch is a host setting

Turning interfaces off is a switch under Appearance, and Appearance is where a user looks for how
replies are drawn. But the cost of an interface is paid on the host: the library rides in the system
prompt, and every reply that tries one spends tokens the user never sees. A switch that only stopped
the app from drawing would leave the host telling the model about a vocabulary no device wanted, so
the switch is one fact, written to the host, and off means both halves stop: the app draws a block as
the code it came from, and the next chat is not told the library at all.

It is profile-wide rather than per device. A vocabulary is a property of who the bot is, not of the
phone in hand, and two devices disagreeing would leave the host paying for the permissive one. The
app writes it and reads it back when a settings screen opens, so a second device sees the truth rather
than its own memory of it.

## Considered options

- **Device-local, drawing only.** A display switch that never talks to a host, and the honest reading
  of the word "Appearance". Rejected because the token cost is the reason to want it off, and a
  device-local switch cannot reach it.
- **Per bot.** A vocabulary per bot reads well until a profile has three bots that would all want the
  same one. Rejected as a setting with no second value to offer.
- **One switch that also rewrites an open chat.** Would need a system prompt rebuilt mid-conversation,
  which is the caching exception Hermes does not allow outside compression.

## Consequences

- **A flip lands in the next chat.** The prompt section is frozen when a session starts, so a chat
  already open keeps the library it was started with; turning it off takes effect for the next one, and
  turning it on likewise.
- **An open chat started while on keeps drawing**, because drawing is the app's own rule and the
  section it was given is not rewritten. Off therefore reads forward, not backward.
- **The plugin stores the flag and answers for it.** A route reads and writes it, the section renderer
  consults it, and a host that predates it advertises no `openui` feature, which the app reads as
  "this host has nothing to offer" rather than as "off".
- **Two halves can disagree for one setting change.** The app writes, then the host answers; a failed
  write is shown as a failure rather than as a silent local off, since the whole point of the switch is
  the cost it saves on the host.
