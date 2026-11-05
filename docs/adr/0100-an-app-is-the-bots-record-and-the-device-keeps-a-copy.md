# An app is the bot's record, and the device keeps a copy

An app is kept on the bot's host, the way a chat is, so a new phone has the apps its bot knows. The
device keeps its own copy of every page it has opened, so a saved app draws with the host away.

The alternative was device-only, and it read well: "local, for now" was the owner's phrase, and a
Dexie table beside drafts and saved dictations would have cost no plugin work at all. It was not
taken because of what a reinstall means. Everything else this app keeps is either on the host — a
chat's transcript — or cheap to lose — a draft. An app is neither: it is an artifact the user paid a
model to write, and the phrase "local for now" meant *unpublished*, not *on this device*.

The copy on the device is not a second record. It exists so a page that has been opened once opens
again with the host unreachable, which is the same reason a chat's transcript is read back over the
wire when the host is there; the host is the truth, and a cache that disagrees loses.

Pages are a child record rather than one blob, because the operation the feature performs most is
writing one page. A single row per app would rewrite every page to change one — and would put a
schema inside a value, where the store's own migration pattern cannot reach it.

## Considered options

- **Device only.** No plugin work, instant reads, and gone on reinstall. Rejected: an app is the one
  artifact in this app whose loss a user would call data loss.
- **Host only, no cache.** One record, no divergence. Rejected: an app that cannot draw while the
  host is away is a page that fails to load, and the app's own screens hold their last answer
  everywhere else.
- **Both, with the host as the record.** Taken.
- **Synced through the existing chat sync.** Rejected: the sync carries conversations and messages
  and nothing else, and widening it to carry apps would make a second, larger question of conflict
  resolution for a feature whose record already lives on one machine.

## Consequences

- **A reinstall restores apps** from the bot, and hidden or edited state travels with the record
  rather than staying on the phone.
- **The plugin's store gains a schema version,** so an upgraded home needs the migration the store
  already has a pattern for; a new column needs both the `ALTER` and the version bump.
- **The device's copy has to be cleared** with everything else. A cache left out of the app's own
  "clear all data" list survives a reset, which reads as a bug in the reset.
- **A page never opened on this device cannot be opened offline,** and says so, rather than drawing
  an empty app.
