# The room routes mint no id and reword no refusal

Three routes make a room, rename it and disband it (ADR 0115, ADR 0117): `POST rooms`, `POST
rooms/{id}`, `POST rooms/{id}/disband`. Each is a call to the Host's own `groups.*` method, and what
travels with it is the decision this record holds.

**The room's id is the app's.** `groups.create` is idempotent on `room_id` and refuses the same id
carrying different content, so an id the app minted before it sent is what makes a retry the same
room rather than a second one. A create that arrives with no id is refused here, before the Host is
asked: minting one for the caller would give back the retry safety the field exists for. A rename
carries the replay event id its own call appends; an app that sends none gets one minted here, which
costs a deliberate retry nothing, and the id the app does send is the one the Host reads.

**A refusal is quoted, not translated.** The Host validates the roster — the profiles it can seat, the
2–6 members it allows, handles that repeat or reserve `@all` — and answers a bad one with a sentence
and a code of its own. The route puts that sentence, that code and the `reason` the Host marks some
refusals with into `{ "error": { "message", "code"?, "reason"? } }` and adds nothing to it. Only the
HTTP status is this side's: 400 for a refusal, 503 for a worker that isn't running, 409 and 410 for
the two reasons the Host names, and 502 for a Host that answers neither way in — the app shows the
sentence, so a paraphrase would be a second explanation of the same refusal, drifting from the
desktop's.

The loopback client is the one exception: it is built to hand its caller a bounded reason code rather
than a remote message, so a refusal that arrives that way reads as its code and its reason
(`request_failed` where the Host wrote free text). The in-process way — the one a gateway always has,
and the one whose dispatch the seam asks the server for — is the one that quotes.

**A room's record is projected under a key that says what it is.** It rides the chat list every
device already merges (ADR 0116) — both the list it reads and the merge it posts its own records to,
since that merge's answer is the list a device applies — as `room:<room_id>`, its value `{ kind:
"room", roomId, name, members: [{ profile, handle, name }] }`, `at` the Host's `updated_at` in
milliseconds, and a disbanded room as a deletion at its `disbanded_at` — or at the room's last change
where the Host keeps no tombstone time. A bot is handed only the rooms
whose roster names its own Hermes profile, because members are profiles and only a member's bot can
answer there. The store drops any `room:` id it is asked to keep, at `chats.merge` — the door every
writer comes through — so a record can be read and never stored: a device that echoed one back as a
chat would otherwise freeze a stale room into the list and lose the projection's authority over it.

**The projection is gated on the read half of the contract.** A Host that can list its rooms but not
make one still has rooms worth showing, so `chat_records` asks only for the driver and `groups.list`,
while `info` advertises `rooms` on the whole contract — create, rename and disband included. The gate
is one call either way, and the projection's whole budget covers it: it rides a read the app waits on.

**A bot's record keeps its Hermes profile name.** A room's members are profiles, so the app cannot
offer a bot in the member picker, and cannot seat it, without knowing the name that bot answers as
(`hermesProfile`). The plugin already seals that name with the bot's address; the device keeps it
from the same registry read and backfills bots it already holds on their next read, so no migration
is needed and a bot added by hand — with no host to name it — has none and cannot be seated until it
is linked.

**Rejected: a status per Host code.** The Host answers a family of refusals with one code per method,
so a 404 for a room that is gone cannot be told from a 400 for a roster that is wrong except by
reading the sentence. Mapping the codes would put this side's guess about the Host's meaning into
the app, where a later Host sentence would contradict it; the status says only whether the request
was answered or the Host was missing.

**What follows, and is accepted.** A room's creation cannot be retried by a client that loses the id
it minted — the app mints it before sending and keeps it, which is the same deal a chat's session id
makes. A disband is permanent on the Host: the record rides out as a deletion and nothing restores
the room. A room whose roster names no bot of the reading device has no row on it at all, which is
the room being on a Host this device doesn't hold rather than an error. A Host that reports no
`groups.create`, `groups.rename` or `groups.disband` advertises no `rooms` at all, because a New room
the Host cannot make is worse than no New room — though the rooms it can still list ride its devices'
chat lists, since reading one costs the Host nothing it didn't already answer.
