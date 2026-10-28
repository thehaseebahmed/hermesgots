# A bot's Speech-to-text page edits every speech setting its host carries

The page has drawn one Hermes-owned row since it was the Dictation tab: the host speech model, picked
from Gots's own catalogue. Everything else that decides how a bot's speech is heard — the provider
Hermes sends audio to, the local model's language, its initial prompt, the VAD switch and the three
thresholds that decide whether a stretched silence is dropped, the idle unload, the streaming flag,
the transcript echo, the pre-upload silence trim and its two numbers, and each cloud provider's own
model and language — lives only in `config.yaml`'s `stt` section, editable at the Hermes Dashboard and
nowhere else. A phone cannot reach the Dashboard: the same fact that sends a dictation through the
plugin instead of Hermes's own transcription route. So the one place a user tunes speech from a
phone shows a single model name while thirty-two keys that decide what they get are out of reach.

The page therefore mirrors the Dashboard's Speech-to-Text form, and it edits what the host runs. The
split the page already draws holds: Vocabulary and the cleanup model stay **Gots**, because Gots
keeps them; everything else is **Hermes**, because it is the bot's own `config.yaml` — the same knob,
named as Hermes names it, not a copy of it (ADR 0055's rows: a value that opens its pick or drills
into its page).

**The shape.** Under **Hermes**, in this order: *Provider* (the pick that decides which backend
Hermes uses), *Speech model* (the local model, unchanged), *Enabled*, then the take's own tuning drawn
inline — *Language*, *Local language*, *Initial prompt*, *VAD*, *VAD min silence*, *No-speech
threshold*, *Logprob threshold*, *Unload after idle* — then the settings that shape Hermes's speech
elsewhere: *Streaming*, *Echo transcripts*, *Trim silence*, *Trim threshold*, *Trim keep*. Last,
*Other providers*, which opens a page listing every provider but local — the provider pages the
host's own defaults declare, read when the page opens, so a provider Hermes adds later appears
without an app release.

**A row says what will happen, not what the file holds.** Hermes strips a value equal to its default
out of `config.yaml` on save, so a key is legitimately absent while the host still runs a value. Each
row shows the effective value — the explicit one, else the host's own default, muted — editing writes
it explicitly, and a reset clears the key back to unset ("Host default"). The *Provider* row reads
`Automatic · local` while the key is unset, naming the provider Hermes's own resolver picks
(`autodetect: local first, then the cloud providers whose keys the host holds`), and *Automatic* is
the pick's first choice because it is a real state and not the absence of an answer. When the
resolver answers `none` — speech-to-text turned off, or no key and no working local backend — the row
says nothing is usable in the host's own words and no provider carries the in-use mark.

**Control by type, never by invention.** Booleans are switches; closed sets are picks read from the
host (the providers, each provider's models, the local ones from Gots's catalogue filtered to the
names the host's defaults declare, with the model in use always shown even when it falls outside
that filter — a host running `distil-large-v3` must not read as running nothing); numbers and free
text are an edit form holding the host's default as its placeholder. Hermes declares no range or
bound on any of these numbers, so the page invents none and clamps nothing: what is typed is written,
and a value the host later refuses is shown in the host's own words.

**No secrets, and no infrastructure.** A provider's key stays in the host's `.env`, which this app
never reads for a value and never writes. The providers list asks only whether the variable is set
(a presence check, never the value) and marks a provider whose key is missing; it never offers a
field for one. The `base_url` override two providers accept — a URL pointing the host at a self-hosted
backend — is not in the schema's own defaults, is not a setting a phone changes, and is left to the
Dashboard: a typo there silently breaks transcription with nothing on screen to say why.

**Writing.** One dotted key at a time, through Hermes's own round-trip YAML writer, so comments, key
order and every other section survive and a write of `stt.local.vad` cannot drop a plugin provider's
own block. Reads and writes go through the plugin, which already owns this file for the speech model
(ADR 0036): a host too old to advertise the route keeps today's page, and no `MIN_PLUGIN_VERSION`
rises for a surface that degrades cleanly without it.

Nothing on the page is disabled while *Enabled* is off. The switch is off on the host, so a take
fails with the host's own reason, but the tuning is still a real setting — and a row that refuses a
value because a different row is off invites the reader to look for the wrong fault.

## Considered options

- **A read-only mirror of the `stt` section.** Cheap and honest about ownership, but a settings page
  that cannot set anything is a screenshot: the user would still need the Dashboard, which is the
  reachability problem this exists for.
- **Only the local path, everything cloud left to the Dashboard.** Half the section, and the half
  that a take honours; rejected because the provider pick decides whether the local path runs at all,
  and a page that tunes one backend while a different one is selected is worse than no page.
- **Every setting inline, the providers included.** Twenty-four rows plus six providers on one
  phone screen buries Vocabulary and the cleanup model, which are the two rows most people open.
- **One page per provider reached from the provider pick.** Fewer rows on the list, but the pick is a
  choice and not a door: it would hide settings a user wants to read without switching to them.
- **Writing the whole `stt` section back on every edit.** One call instead of many, and it reads like
  the speech model's own write; rejected because the section also holds keys this page does not
  model — a command or plugin provider's block, a `base_url` — and a whole-section write deletes
  them.
- **Offering the keys, in `.env`, from the phone.** Rejected outright: nothing in this app ever holds
  or transports a secret, and the providers' keys are exactly that.
- **Inventing ranges for the thresholds** (0–1 for the two probabilities, a floor on the unload).
  They would read as authority the host does not claim; a wrong number is the host's to refuse.

## Consequences

- The plugin grows one read and one write for the `stt` section beside the speech model it already
  writes, plus the provider presence check and the resolved provider — a read that answers the whole
  page in one call, and a write that takes a dotted key and a value.
- The page gains fifteen rows and seven drill-in pages (the providers list, then one per provider the
  host declares); the Providers list is the only place a key's absence is mentioned, and only as a
  mark.
- The app names the schema's real keys, not the Dashboard's labels: the trim settings are
  `cloud_trim_silence`, `cloud_trim_threshold_db` and `cloud_trim_keep_ms`, and ElevenLabs has
  `language_code` and no `language`. A label that disagrees with the key it writes is how a settings
  page starts lying.
- A row's reset writes a deletion inside the section, which is the one write shape the round-trip
  writer has to be tested for: an unset key must disappear without taking its siblings with it.
- The cleanup model and Vocabulary are untouched, so ADR 0036 and ADR 0060 keep their rules, and the
  page keeps its one banner for the host's own refusal.
