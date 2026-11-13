# Four key spaces the app no longer keeps

The app stored more than it read. Four key spaces across its two blob stores — a legacy per-bot chat
document, the check-in record, three throttle keys and the rankings cache — were asked for on every
pass and answered nothing the code did not already hold somewhere cheaper. Each goes, and the record
that already carried its fact takes its place: a chat list lives only with the bot's plugin, presence
is the answer the sync pass just got, each throttle reads the row it guards, and the picker's scores
ship with the build. Nothing is migrated, because nothing in any of the four was worth reading twice.

What replaced each one:

- **`chats/<profileId>` in `gots-sync`.** Nothing. A chat list lives with its bot's plugin, so the
  document was asked for, 404'd and moved on every pass; the pass no longer asks, the database
  version that followed drops `Settings.movedChats`, and `netlify/lib/docs.ts` now accepts only the
  four names it serves (`vault`, `bots`, `prompts`, `settings`).
- **`users/<userId>/seen/<botId>` in `gots-registry`.** The chat-list pass's own answer for the bot,
  plus the timestamp this device keeps (`seenAt`) of when it last heard the host. The route string
  `POST seen` stays and its payload does not move, because that is the plugin's protocol and the
  answer is what it reads: `{ keyId, bots[botId] = null | { enabled } }`, which is how a host learns
  it was deleted or switched off. The registry writes nothing for it.
- **`users/<userId>/pushed/<hostId>`, `users/<userId>/tested`, `community/gap/<hostId>`.** The records
  each path already reads: the host record's `pushedAt`, the device record's `testedAt` (so one
  device's test no longer throttles another's), and the community report row's own `at`, which is the
  one gap that costs no write on a public endpoint.
- **`gots-rankings` and the `benchlm` function.** A payload baked into the build:
  `scripts/build-rankings.mjs` fetches the overall surface, validates it, and writes the module the
  app imports (`src/lib/rankings-data.ts`), refreshed weekly by `.github/workflows/benchlm-match.yml`
  and reviewed as a diff. `rankings.ts` keeps `useOverallRankings`, so the picker needed no edit;
  `typecheck`, `pnpm dev` and every test read the payload with no network and no `BENCHLM_DATA_KEY`.

**It is a hard cut, with no version-skew shim.** The app, the plugin and the functions ship together,
so a shim would keep both shapes alive for a release that no longer needs either — and a key space
that is only unread is a key space that comes back. The one asymmetry the cut accepts is the old
build's: a device still on it asks for `chats/<id>` once per bot per pass and gets "unknown
document", which its failure log carries, and its dots read unknown until it updates. An old plugin
is unaffected and keeps checking in, since `POST seen` still answers.

**Consequences.** The sweep is irreversible: a chat that only ever lived in a bot's old document, and
was never moved to its plugin, goes with it, which is why the inventory prints per-prefix counts
first and every sweep has a dry run. `scripts/inventory.mjs` holds the four spaces under `RETIRED`
and `--expect-empty` fails while any of them holds a key, so the proof is a live run rather than a
claim — and that run happens twice, days apart, because a device on the old build can write a `seen`
key after the first sweep. That is the cut being honest about itself, not a leak. A cold open now
shows no dot until its first chat-list pass lands, where a stored check-in used to show one at once,
and a host that hangs reads away for as long as the chat-list merge waits. Scores can lag BenchLM by
the weekly job's cadence, and a payload nobody refreshed looks exactly like a fresh one, since the
copy that ships is the only thing that says when it was fetched.
