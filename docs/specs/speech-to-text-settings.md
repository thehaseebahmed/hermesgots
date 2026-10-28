# A bot's Speech-to-text page edits every speech setting its host carries

Status: ready for a human to read. Design: [ADR 0063](../adr/0063-a-bots-speech-to-text-page-edits-every-speech-setting-its-host-carries.md).
Placement follows [bot settings restructure](./bot-settings-restructure.md): Gots's own settings
above, the bot's Hermes below.

## Problem Statement

The Speech-to-text page draws three rows: Vocabulary, the cleanup model, and the host speech model.
Everything else that decides how a bot's speech is heard sits in the bot's `config.yaml` under `stt`,
editable only at the Hermes Dashboard — which a phone cannot reach. The result is a page that names a
model while the switches and numbers that decide what it returns are invisible, and a user who wants
Spanish, a longer pause tolerance, or a different provider has to find a laptop.

## Solution

The page mirrors the Dashboard's Speech-to-Text form and writes the bot's own `config.yaml`, one key
at a time. Under **Hermes**: the provider pick, the speech model, *Enabled*, then the take's own
tuning inline (language, local language, initial prompt, VAD, the three thresholds, idle unload),
then the settings that shape Hermes's speech elsewhere (streaming, echo transcripts, the silence trim
and its two numbers), then *Other providers* — a page listing every provider but local, each opening
its own page of that provider's model and language (and, for OpenAI and ElevenLabs, their few extra
knobs). No secrets, no `base_url`, no invented ranges.

## User Stories

1. As someone who dictates in another language, I want to set the language the host hears me in, so
   that a short clip isn't decoded as English.
2. As someone whose dictation cuts off at pauses, I want to change the VAD switch, its minimum
   silence and the two decode thresholds, so that my speech splits where I actually paused.
3. As someone on a small host, I want the model unloaded after a stretch of idle time, so that it
   isn't holding memory all day.
4. As someone whose Hermes keeps loading the wrong backend, I want to pick the provider (or say
   Automatic) from my phone, so that voice notes elsewhere stop failing.
5. As someone tuning a cloud provider, I want that provider's model, language and timeouts on their
   own page, so that the list of providers stays a list.
6. As someone who changed a setting and wants it back, I want a reset to the host's own default, so
   that I never have to remember what it was.
7. As someone whose provider has no key on the host, I want the list to say so, so that I know why a
   pick will fail before I make it.

## Implementation Decisions

**What the page draws**, in order under **Hermes**. Every key below is written as Hermes spells it.

| Key | Row | Control |
| --- | --- | --- |
| `stt.provider` | Provider | pick: *Automatic*, then every provider the host declares |
| `stt.local.model` | Speech model | pick (existing row, unchanged) |
| `stt.enabled` | Enabled | switch |
| `stt.language` | Language | text field |
| `stt.local.language` | Local language | text field |
| `stt.local.initial_prompt` | Initial prompt | multi-line field |
| `stt.local.vad` | VAD | switch |
| `stt.local.vad_min_silence_ms` | VAD min silence | numeric field |
| `stt.local.no_speech_prob_threshold` | No-speech threshold | numeric field |
| `stt.local.logprob_threshold` | Logprob threshold | numeric field |
| `stt.local.unload_after_idle_seconds` | Unload after idle | numeric field |
| `stt.streaming` | Streaming | switch |
| `stt.echo_transcripts` | Echo transcripts | switch |
| `stt.cloud_trim_silence` | Trim silence | switch |
| `stt.cloud_trim_threshold_db` | Trim threshold | numeric field |
| `stt.cloud_trim_keep_ms` | Trim keep | numeric field |

**Other providers** opens a page listing every provider the host declares except `local`; each row
is the provider's name over the model it holds, marked where it is the one Hermes is using, and
saying *Key not set* where the host holds no key for it. A provider page holds:

| Provider | Rows |
| --- | --- |
| groq | `model` (pick), `language` (text) |
| openai | `model` (pick), `streaming_model` (pick), `language` (text), `timeout` (number), `max_retries` (number) |
| mistral | `model` (pick), `language` (text) |
| xai | `model` (pick), `language` (text) |
| elevenlabs | `model_id` (pick), `language_code` (text), `tag_audio_events` (switch), `diarize` (switch) |
| deepinfra | `model` (text, blank = the host's live catalogue) — page listed only once the host reports a catalogue |

- **A row shows what will happen.** Its value is the explicit one, else Hermes's own default, muted.
  Editing writes the value explicitly; a reset writes `null` and the key leaves the file.
- **The provider row** reads `Automatic · local` while `stt.provider` is absent, naming what Hermes's
  own resolver picks. When that resolver answers nothing usable, the row says so in the host's words
  and no provider carries the in-use mark.
- **No range, no clamp, no invention.** Hermes declares no bound on any number here. A value that
  isn't a number is refused before it is written; anything else is written and the host's own refusal
  is shown in its words.
- **The local model list** is Gots's catalogue filtered to the names the host declares, with the model
  in use always present even when it falls outside the filter, keeping its size, speed and downloaded
  note.
- **No secrets.** The providers list asks only whether a key is set; a value is never read, shown or
  written. `base_url` is not exposed.
- **Writes are per key.** One dotted path, written through Hermes's round-trip YAML writer, so
  comments, ordering and everything else in the section survive — including a command or plugin
  provider's own block.
- **Reads are one call.** `GET <plugin>/speech` gains an `stt` block: the values, the defaults, the
  resolved provider, each provider's model and key presence, and the model catalogue, so the
  providers pages draw from the payload the page opened with.
- **Write shape.** `POST <plugin>/stt` takes `{key, value}` — `key` a dotted path the app's table
  names, `value` a scalar or `null` — and answers the fresh `stt` block. An unknown key is refused.
- **Gating.** `info.features` gains `stt_settings`. A host without it keeps today's page (three rows,
  no new ones), and `MIN_PLUGIN_VERSION` does not rise for a surface that degrades cleanly.
- **Routes.** `/settings/bots/<id>/speech-to-text/providers` and
  `/settings/bots/<id>/speech-to-text/providers/<provider>`, through the existing `BotSub`
  mechanism (`app/src/lib/bot-subs.ts`), so both widths behave as every other drill-in does.
- **New pure module** `app/src/lib/stt-settings.ts`, import-free: the key table, `effective()`,
  `providerLine()`, `modelOptions()`, `providerRows()`, `parseNumber()`.
- **Plugin** `plugin/speech.py` grows `stt_settings()` (read) and `set_stt_value()` (write), reading
  defaults from `hermes_cli.config_defaults.DEFAULT_CONFIG["stt"]`, the resolved provider from
  `tools.transcription_tools._get_provider`, catalogues from
  `tools.transcription_common.STT_MODEL_CATALOG`, and presence through
  `agent.credential_pool.get_env_prefer_dotenv` — each behind a `getattr`/`ImportError` guard, since
  one that moves only means the feature is absent, as `dictation.py` already treats them.

## Testing Decisions

- **Unit** (`app/scripts/test-stt-settings.mjs`): the table covers every key the payload carries; the
  effective value when a key is unset; `parseNumber` on a negative, a decimal, a blank and junk; the
  provider line for Automatic, for a pick and for nothing usable; the local model options filtered
  with the model in use kept; deepinfra present only with a catalogue.
- **Component** (`app/scripts/test-bot-dictation-tab.tsx`): the page draws the rows from a seeded
  payload; a switch writes exactly one key; a reset writes `null`; a provider page draws its rows; a
  host without `stt_settings` draws today's page; the provider list marks the one in use and says
  *Key not set* where a key is missing.
- **Plugin** (`plugin/tests/test_speech.py`): the read answers the block; writing one key keeps its
  siblings and the file's comments; `null` removes only that key; an unknown key is refused; the
  presence check never returns a value.
- **No new e2e flow**: the page is data over one route that the component tier reaches, and geometry
  is the only thing a flow would add (ADR 0019).

## Out of Scope

- `base_url` overrides, and every API key: both belong to the Dashboard and to `.env`.
- A "test this provider" action, and any per-provider "use this one" button — the provider pick is
  the only place the choice is made.
- Hermes's own text-to-speech section (`tts.*`), and the `voice` section above it.
- The cleanup model and Vocabulary, which stay exactly as they are (ADR 0036, ADR 0060).
- Any change in `hermes-agent`: the read uses what the host already declares.
- Cloud trim's effect on Gots's own takes: a take is never uploaded to a cloud provider.

## Further Notes

- ADR: [0063](../adr/0063-a-bots-speech-to-text-page-edits-every-speech-setting-its-host-carries.md).
- Glossary: **Speech provider**, **Host default**, **Heard on the host**, all in
  [GLOSSARY.md](../../GLOSSARY.md).
- The page names the schema's real keys rather than the Dashboard's labels (`cloud_trim_*`, not
  `cloud_tts_trim_*`; ElevenLabs has `language_code`, not `language`).
- Plugin version bumps in both `plugin/plugin.yaml` and `plugin/dashboard/manifest.json`; no Dexie
  change, nothing stored on the device.
