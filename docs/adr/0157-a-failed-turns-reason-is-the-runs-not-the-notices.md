# A failed turn's reason is the run's own words, not the notice the host writes in its place

Hermes gives up on a turn for reasons of its own — a provider that refused the key, a rate limit, a
usage window spent, a stream that died — and writes one sentence into the transcript in the turn's
place for all of them: `FAILED_TURN_NOTICE`, "Your request was not processed. Send it again if you
still want me to carry it out." (`agent/turn_failure_copy.py`). The provider's account of what went
wrong is deliberately kept out of that row: it rides `final_response`, which on the API server is
the run's ending, `run.failed`'s `error` and `GET /v1/runs/{id}`'s `error`.

The chat screen drew only the row, so a usage limit, an exhausted balance or a refused key reached
the reader as the same generic sentence. The reader could not tell a spent account from a bad key
from a dropped stream, and the advice the sentence gives — send it again — is the one thing that
cannot help when the provider has refused the account.

**A turn this device watched fail says what the run said.** A `run.failed` ending that carries words
is the failure's own reason, and the app draws it where the notice stood: on the streamed turn as the
run ends, and on the transcript's turn once the row that opened it is known. The words are the
host's — the same reading of "the host's own error" the send's banner already uses (ADR 0071) — so
nothing is invented and nothing is paraphrased.

**The device keeps them, by the row that opened the turn.** The transcript may hold the notice for
the same turn, and a chat opened later should not fall back to it, so the reason is stored beside
the session's other per-turn readings (`stats`, `answers`) under that row's id, in the record
chat-next already keeps. A failure heard before the transcript named the row waits in the state
until the next read supplies it. Keyed by the row, a later failure can never lend its words to an
older turn, and a turn nobody heard fail keeps the host's notice.

**And the host keeps them, for the device that was never there.** A device's own copy only helps the
device that watched the run, so the turn's own end keeps the reason on the host: the
`on_session_end` hook reads the run's `error` from the API server's own run statuses — the one place
it outlives the turn — and `failures.py` keeps it in the plugin's store, one row per session, served
at `GET /api/plugins/gots/sessions/{id}/failure` with the moment the run ended. A chat opening reads
it once (on the open and again when a turn ends) and files it under the row of the turn it explains,
under two guards: the rows must already call that turn failed, and the run must have ended after
the turn began. The reason that comes this way is the session's newest, not its history — a chat
whose older failure had a different reason keeps the notice on that older turn, which the browser
flow pins.

**A wordless failure keeps the notice.** Hermes falls back to `agent run failed` where the ending
says nothing else, and that names the failure less than the notice does; those endings — and a run
that was cancelled or interrupted — draw nothing of their own.

## Considered options

- **The notice kept, with the reason as a second line or the chat's banner.** Both say the same thing
  twice, and the banner is where a *send* that never reached the host is answered (ADR 0071): a turn
  that ran and failed is a different reading, on its own row.
- **The reason appended to the notice in one string.** The transcript row would then carry words the
  host never wrote there, and any reader comparing it with `turn_failure_copy.py` — Hermes's own
  `untyped_failed_turn_display_kind` matches the exact text — would find words that should not be in
  it. The row keeps the host's sentence; only what the screen draws changes.
- **The reason read back from the host on opening a chat (`GET /v1/runs/{id}`).** A run's status is
  kept briefly after it ends, and the id is not on the transcript, so a chat opened the next morning
  would ask about a run the host has forgotten — and the device has no id to ask with. Kept on the
  host by the turn's own end, the reason outlives both; read from the live run's status at that
  moment, it is still the run's own words, not a summary of them.
- **Interpolating the reason into the notice in the plugin, at the turn's end.** The plugin writes no
  transcript rows, and the notice is the host's: a row rewritten by the plugin is one the host's own
  readers no longer recognise.

## Consequences

- A failed turn reads as "You have used up this account's usage for now" rather than as "Your request
  was not processed", and Retry stays where every failure offers it.
- A second device, and one opened the next morning, read it too: the reason is kept on the host by
  the turn's own end, so only the plugin's store has to outlive the run. A Host whose plugin is older
  than this route falls back to the notice, which is what every device read before.
- The host keeps a session's newest failure: two failures in one chat, and the older turn reads the
  notice again on a device that never watched it.
- `app/scripts/chat-next-host.ts`'s `fail()` takes the notice and the run's ending separately, since
  Hermes keeps them apart, and `app/scripts/mock-hermes.mjs` models the same pair for "out of usage"
  with the route that serves it back.
- `app/scripts/test-chat-next-mount.tsx` holds both halves: the reason on the turn as the run ends,
  the reason still there on the chat opened again, and the reason read from a host that kept it while
  this device watched nothing.
