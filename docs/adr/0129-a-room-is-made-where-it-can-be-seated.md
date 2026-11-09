# A room is made where it can be seated, not where it was picked first

New room used to make the room on the first-picked bot's connection and then discover that its roster
could not seat the rest: the row greyed, Send held, and the sentence told the reader to unpick
everything and change a connection that is not theirs to change. The Host seats a room per connection,
and the roster is published, so both halves of the dead end are knowable before the create. **The app
now makes the room on the earliest pick whose connection seats every pick, and where no pick's
connection does, the create adds the missing profiles to the making profile's
`hosted_rooms.profiles`, reads the roster again, and only then makes the room.**

The repair lives in the plugin's create rather than in a route of its own, because a create is the only
door to a room and the guarantee must not be skippable by a second caller. It writes only names the
Host's entry rule accepts, only for homes it can read as a real unsymlinked directory beside the making
profile's own, and only where the file already held nothing under that name. It reads
`hosted_rooms.profiles` from the file itself and writes the whole mapping once: the effective config is
a merged view, so writing it back would materialise managed-overlay keys into the user's file, and a
profile name may carry a dot that a dotted key path cannot. A config it cannot read is a refusal, never
an empty mapping to merge over.

The app's roster is a prediction and the plugin's repair is the guarantee, so the picker keeps offering
every bot of the Host: a bot no picked connection seats is marked "Needs the Host configured" and stays
a pick, which reverses ADR 0128's greying. The room's first line says which bots the Host now seats,
and the create re-reads that connection's roster, since `refreshAnswer` otherwise runs only where a
create failed.

## Considered and rejected

- **Repairing after the Host refuses.** A refusal is prose in the Host's own words; deciding that it
  was about a seat means parsing a sentence this repository deliberately passes through untouched.
- **A route of its own for the repair, called by the app.** A second door to the same guarantee, and the
  app would have to sequence a write, a re-read and a create it cannot make atomic.
- **Rewriting an entry that already exists.** One home answering to two names is refused by the Host,
  and a profile re-homed on the Host is the Host's business, not a room's.
- **Choosing the connection that needs the fewest entries.** The earliest pick that works is the one
  the reader already believes is making the room; "fewest entries" is a choice the screen cannot
  explain.
- **A host-scoped connection, which ADR 0128 also rejected.** Gots holds no such grant and cannot ask
  for one.

## Consequences

- A write to the user's `config.yaml` happens without a confirm, and the entry is a standing grant that
  outlives the room: nothing prunes it when the room is disbanded.
- A repair that lands and a create that then fails leaves the Host widened. The write is idempotent and
  a second create writes nothing, but there is no rollback.
- Two creates at once can lose one entry: the read-modify-write of the mapping is unlocked. The file is
  never left half-written, only under-widened.
- A profile whose name the Host's entry grammar refuses (a hyphen, for one), who is not served by that
  Host, or whose home is a symlink can never be seated from Gots, and the create says so instead.
- A Host the plugin reaches through its in-process dispatcher answers `groups.capabilities` without
  `seatable_profiles`: nothing is marked and nothing is repaired there, and ADR 0128's behaviour stands.
  That half is Hermes's.
