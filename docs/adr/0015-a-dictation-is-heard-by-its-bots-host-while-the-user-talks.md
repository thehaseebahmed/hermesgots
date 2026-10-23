---
status: superseded by ADR-0038
---

# A dictation is heard by its bot's host while the user talks

Dictation was a batch: the app recorded Opus pieces cut at pauses and sent each one after it ended, so
the first word of a take arrived only once a piece had closed, the last only after Stop, and a take
spoken in one breath waited on the whole thing. Nothing was heard *while* the user talked, which is
the part of dictation that makes it feel like talking rather than recording.

So the take becomes one continuous recording, sliced as it is made, and the plugin decodes it as it
arrives: a rolling window of the last few seconds is transcribed every few hundred milliseconds, and
the words two consecutive windows agree on are the words that get committed. The same window is
re-decoded when a phrase finishes, so the phrase's final text comes from the same model that heard it
live — which is what lets a committed word be a word Gots never touches again.

It runs on the bot's own host, through the same local faster-whisper path everything else uses, and
not on a cloud speech service. Every word a user dictates is private by default here, a take costs
nothing, and the app already asks the host for speech rather than a vendor. Cloud streaming is
genuinely faster and, at the top of the market, more accurate than any model a laptop can run — this
decision trades that for privacy and for having no third key to enter — so the answer to "make it
more accurate" is the host speech model and the bot's vocabulary, both of which the user can turn up,
rather than a vendor choice. That is why the model picker belongs to this feature and not to a later
one.

## Considered options

- **A cloud streaming engine, in the browser or through the host.** The fastest path available, and
  the reason a browser-based dictation tool feels instant. Rejected: it sends everything spoken to a
  third party, needs a separate key and a per-minute bill, and makes the app's accuracy a vendor
  contract instead of a setting on the bot's own machine.
- **The browser's own `SpeechRecognition`.** Rejected: it is Chrome's, sends audio to Google, and
  does not exist in the Android WebView the app is built as — the one client this is for.
- **The batch path, cut into shorter pieces.** The cheapest change, and the one that cannot work:
  a shorter piece is a shorter sentence for Whisper to read, and accuracy falls fastest exactly where
  the user complains it is worst. Batch can never be faster than its piece either.
- **Two models — a small one for the live window, the host's big one for each finished phrase.**
  Rejected as a default: the live words and the final words would disagree, and the committed text
  is meant never to change. The picker's speed warning carries the same trade to the user instead.

## Consequences

- The host decodes audio, so the plugin needs to read Opus itself. PyAV ships with faster-whisper,
  so this adds no dependency to a host that can dictate at all.
- The host's model has to decode a window faster than the window's hop. Where it cannot — a slow
  CPU, a model too large for it — the live words thin out and the take says it is behind instead of
  quietly lying about how fresh the text is.
- A cold host has to load the model before it can hear anything, so starting a take is the one call
  that waits, and the bar says so rather than looking hung.
- A remote host adds its round trip to every window. Partials arrive later there; they are not less
  correct, and the same window/hop rule covers it.
- One take at a time, as one clip at a time was: decoding holds the CPU that the agent's own turns
  need, and a dictation is a second of work at a time, not a minute of it.
- Hermes's own `_transcribe_local` is still the only thing called, so the host's language setting,
  its prompt and its anti-hallucination rules all still apply, and a plugin that moves stays off
  dictation rather than dictating wrongly.
