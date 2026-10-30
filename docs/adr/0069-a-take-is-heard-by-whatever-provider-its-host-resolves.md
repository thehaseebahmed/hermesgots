---
status: supersedes the no-cloud clause of ADR-0038
---

# A take is heard by whatever provider its host resolves

Dictation decided for itself what hears a take. `dictation.info()` asked whether `faster_whisper`
was importable — `_HAS_FASTER_WHISPER`, or a `find_spec` of its own, in the plugin process — and
`dictation.transcribe()` called Hermes's `_transcribe_local` directly, never asking which provider
the host had picked. So a bot whose Hermes resolves Groq, because that is the key it holds, was told
"faster-whisper isn't installed on the host. Run `hermes tools` and pick Local Whisper" — advice the
user follows, in the environment they ran the CLI from, while the process serving the bot keeps
answering no. A host running the whisper CLI instead of faster-whisper was refused the same way,
though it can transcribe. And the one action the app takes before a take — `POST /dictation/warm` —
returned early whenever that check said no, which is exactly the call that would have installed the
package, because Hermes's own warm-up helper lazy-installs and ours never reached it.

The plugin now asks Hermes what it already answers. `_get_provider(cfg)` decides whether a take can
be heard at all and by whom; `_detect_local_backend()` says which local backend sits behind a `local`
answer, which is the only thing the page still needs to name. Both are read with `getattr` and fall
back to the old check, so a host whose Hermes has moved them reports what it always did rather than
breaking. `info` is ready when Hermes resolves any provider, carries the provider's name, and is not
ready only when the host turns speech-to-text off or resolves none — with our own short sentence
saying what to fix, since Hermes's own hint lists every provider's key and reads as a manual.

Ready follows the provider, so a take may leave the host. That is the part worth writing down: ADR
0015 said dictation runs on the bot's own machine and never on a cloud service, for privacy, for
cost, and for having no third key to enter. Keeping that promise while claiming to honour the host's
provider would be two answers to one question — the page saying *Automatic · Groq* while the mic
insists on faster-whisper. So the promise changes with the detection: a host resolving a cloud
provider hears takes there, and the take is decoded by `transcribe_audio`, Hermes's own dispatcher,
which brings that provider's silence trim, its upload chunking and the host's configured model with
it.

Three things follow from a take going to a vendor. It is uploaded once, whole, instead of in the
six-second pieces a local model hears as they arrive — many small uploads during speech are worse
for the vendor's rate limits and for privacy, and no cloud provider gives back partial text fast
enough for the pieces to be worth keeping. The **Hearing prompt** is never sent: a cloud decode reads
the audio alone and the cleanup carries the bot's names, which is ADR 0067's default rather than a
new rule. And a take that fails is not retried on another engine — the provider's words come back,
the app keeps the audio, and Retry re-sends it.

The app is told where a take goes in one line on the Dictation tab, beside the speech model: the
provider's own name for a cloud one, and for the whisper CLI a line saying it ignores the Hearing
prompt and Vocabulary, since `_transcribe_local_command` drops the prompt. Nothing modal, and the
recording UI is unchanged — words land when the user stops, which is what a cloud take can offer.

## Considered options

- **Detecting faster-whisper more honestly and leaving the route alone.** The smallest fix: keep
  `_transcribe_local`, report the interpreter's real answer, and name a restart. Rejected: it leaves
  `ready` disagreeing with `_get_provider`, which is the contradiction this started from, and it
  strands every host whose keys are cloud-only.
- **Ready pinned to local, with a sentence naming the cloud provider found.** Keeps ADR 0015 intact
  and still tells the truth. Rejected as the second-best: a host whose speech lives in Groq cannot
  dictate, and the app's own Speech-to-text page offers provider picks that dictation would ignore.
- **`voice_mode.check_voice_requirements()` as the single source.** Whole-voice readiness, so it
  answers questions about TTS and the mic that dictation never asks. Rejected: the plugin would
  filter its answer back down to the STT half.
- **Buffering on the device and sending one request for a cloud take.** App-side branching, a second
  upload path, and the take's audio handled twice. Rejected: the plugin already owns the pieces, and
  the final piece is one query parameter away from declaring itself the last.
- **A `pending` field on a buffered piece's answer.** Says what is happening instead of implying
  nobody spoke. Rejected: an empty landing is already a normal answer the app stores and moves past,
  so the field would buy a protocol change and no behaviour.
- **Falling back to local when a cloud upload fails.** `transcribe_audio_local_fallback` is right
  there. Rejected: an engine that switches without being asked hides a provider failure behind a
  worse model, and the user's Retry says what happened.
- **Lazy-installing from the status probe.** Would clear the dead end without the user lifting a
  finger. Rejected: Hermes deliberately forbids it — a status probe that installs holds the
  per-install lock for a whole dependency rebuild — so the install rides `warm`, which is an action
  the user started.

## Consequences

- A take on a cloud provider costs money per minute and leaves the host. The Dictation tab says so
  once, where the speech model sits; nothing else in the app claims otherwise.
- A cloud take's words arrive only when the user stops. The recording UI is unchanged, so the take
  looks like recording rather than talking — the one place this is worse than the local path.
- The final piece of a take is one request that may decode minutes of audio, so it is given a
  five-minute budget instead of the two the pieces share.
- The plugin keeps a take's audio in memory between pieces: one buffer per profile, capped at the
  same 9 MB the route already allowed, dropped when the last piece answers or a minute after the
  deepest one. A cancelled take is dropped, never uploaded.
- The Speech-to-text page and the mic read the same two answers, so the Provider row and the take
  can no longer disagree.
- `local_command` hosts dictate, and lose the Hearing prompt and Vocabulary with a line saying so.
- Hermes's own warm-up helper is the install path, so `warm` on a host without faster-whisper may
  take as long as a dependency rebuild, and may say a restart is needed — which is what it says, in
  Hermes's words, rather than ours.
- The mock server grows the buffered contract: a piece that is not last answers nothing, and the
  last one answers the take.
