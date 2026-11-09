# A room offers only the bots its connection seats

New room drew every bot of the picked Host and let two of them be seated, and the create then came
back `member 1 profile 'ops': only a host-scoped connection seats a served profile without an entry`.
The Host's rule, in `gateway/session_hosted_members.py`, is that a room seats the profiles the caller's
own connection serves: a host-scoped grant — the Desktop's shared-primary socket, the dashboard gate —
seats every profile the process serves, and any other grant seats its own profile plus the profiles its
`hosted_rooms.profiles` entries name. Gots' plugin reaches the Host over a loopback client, which is
the second kind, so a room made from it can only hold a profile that grant seats. The Host publishes
exactly that roster as `seatable_profiles` in `groups.capabilities`, for the reported reason (#141178:
its own picker offered bots that `groups.create` then refused).

**So the picker asks the Host what the connection seats, and offers only that.** The plugin reads
`seatable_profiles` from the capabilities answer it already makes for `info`, and answers it there as
`rooms.seatable` — no second Host call, and the roster rides the one answer a screen already reads for
a connection. A bot whose profile is not in it is greyed, and a press says why: a row that silently
disappears is a room the user cannot understand, and another Host's bots are already greyed here with
a sentence for the same reason. A Host that names no `seatable_profiles` — one older than the field —
answers none, and the picker offers what it always did: nothing filters, and the Host's own refusal at
the create still speaks in its own words (ADR 0115).

**The roster is the connection's, not the Host's.** Two bots at one address may reach it by different
keys, which are different grants with different rosters; the create is made as the first bot picked,
so it is that bot's connection the rows are held to, and every pick is held to it again before the
send goes out. Nothing is decided before the first pick, since until then there is no connection to
ask about.

**A create the Host refuses re-reads the roster.** The Host's refusal is the one word on whether a
connection seats a profile, so the answer it contradicts is read again at once rather than dropped:
the picks stay seated and the old answer stands until the new one lands, because a screen that lost
it in between would say the Host can make no room and take away the rows the refusal's own sentence
tells the user to unpick. Only the new read is written — one that began before the re-read and lands
after it answers the question the re-read replaced — and the words the create carried go back into
the field for the retry, as a room's own refused send does (ADR 0125). An answer that names neither
features nor a roster is still not worth keeping, so an older Host is asked again rather than
answered for good.

**What this does not fix.** Where a connection seats one profile, a room of two is not possible, and
the screen will offer one bot and grey the rest. That is the Host's limit: making that room means an
entry in the Host's `hosted_rooms.profiles`, or a host-scoped connection, which Gots does not hold. The
app says what it knows rather than inventing a way round it. **And a Host answered in process carries
no roster at all**: only the gateway's `groups.capabilities` (`gateway/session_group_controls.py`)
fills `seatable_profiles`; `tui_gateway/methods_groups.py`'s own handler for the same call answers
without the field, so a Host the plugin reaches through that dispatcher filters nothing and keeps
today's picker until Hermes adds it there. That half is Hermes's, not this repository's.

## Considered and rejected

- **A route of its own for the roster.** `info` already asks `groups.capabilities` on every app open, so
  a second route would ask the same question again for a screen that already reads the first answer.
- **Hiding the bots the connection cannot seat.** The list would look like every other list, with no
  sign of why a bot the user knows about is missing, and no sentence to act on.
- **Making the create as a host-scoped connection.** Gots' plugin has no such grant and no way to ask
  for one; the Desktop holds it, and a plugin inventing one would be claiming an authority it was not
  given.
- **Restating the Host's field name (`seatable_profiles`) on the wire.** The plugin's seam translates the
  Host's names into the app's (`_member`, `_host_member`); `seatable` is the adjective that survives the
  translation, where the noun "seat" is already the app's word for a member's place and GLOSSARY keeps
  it there.
