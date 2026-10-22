# A bot's speech model is the host's, and the cleanup model is kept on the host

Two settings on the Dictation tab belong to the bot's host rather than to the bot: the speech model
that hears a dictation, and the model a finished phrase's cleanup runs on. Neither is a field of the
bot's own record, because neither is the bot's to hold — one is Hermes's `stt.local.model`, the other
is a call made with the plugin's model access on that host. The tab writes both through the plugin,
and the app reads them back from the host, so two devices pointed at one bot cannot disagree about
what is hearing it.

The speech model pick is a list, not a free field: Hermes's local faster-whisper family, each with
the download it costs and how much faster than real time it hears speech on a CPU. A model too
large to keep up is marked rather than hidden, because it is still the right pick for a host with a
GPU, and a model the host doesn't have yet is marked as downloading rather than refused: the take
that follows waits for it exactly as it waits for a cold model, which is the one call of a take that
may wait already. A pick is written to `stt.local.model` in one pass through Hermes's round-trip YAML
writer, so every other speech setting and every comment survives, and it lands on the next take
because a take snapshots its model when it starts.

A pick that won't load must not cost the user their dictation. The host remembers the model that
last loaded, beside the pick, and a take that can't load the pick loads that one instead and answers
the failure as a warning the tab shows. The failed name is never remembered as the model in play, so
the next take tries the pick again rather than believing it worked; the fallback can't poison
itself. When there is nothing to fall back to the take fails with the host's own reason, which is
what it did before this pick existed.

Cleanup's model is the one line ADR 0017 left a seam for. It is stored in the host's own settings
store, per bot, not on `POST dictation/take`: the take's start body already carries the bot's
vocabulary, and adding a second per-take field would make every app a writer of a setting that only
changes on a settings screen. The host reads the stored pick when a take starts, so a pick made
mid-take lands on the next one and a pick survives a plugin restart. It is gated on the plugin's
model-override permission (`llm.model_override` and `llm.provider_override`, read the way triage's
pick is): where the host withholds it, the tab shows the host's own explanation in place of the
field, and the take start ignores a stored pick anyway, so a permission taken back is honoured at
once rather than at the next time the settings screen is opened.

## Considered options

- **The cleanup model on the bot's own record.** It would sync like the vocabulary, and it is the
  bot's intent rather than the host's state. Rejected: it is the host that has to honour it, on the
  host's permission, and the app already reads the rest of the settings screen from it; a pick that
  synced to a device whose host refuses overrides would have to be explained twice.
- **The cleanup model on `POST dictation/take`'s body, per take.** It is the most direct reading of
  "read with each take", and needs no new route for it. Rejected: the pick changes on a settings
  screen, not while talking, so sending it with every take spends a field on the take's one
  latency-sensitive request to carry a value the host already holds.
- **A free-text model name.** Hermes accepts a repository name, so it would allow a model this
  catalogue doesn't know. Rejected for the picker: a name that has to be typed is a name the user
  has to already know the size and speed of, which is the whole point of the list. A hand-written
  `stt.local.model` still reads back as the model in play.
- **Failing the take when the picked model won't load.** Clear, and honest about the pick. Rejected:
  the user's sentence is worth more than the pick, and the pick is still in the file for a host that
  can load it later.

## Consequences

- `GET speech` and `POST speech` are the tab's one read and one write; `info` advertises
  `speech_model` so a plugin that predates them shows the words alone.
- The host's settings store holds three keys per bot: the cleanup pick, the model that last loaded,
  and the last load that failed. The failure is shown once and cleared by a take that loads the same
  pick.
- The app never guesses what a refused write left behind: the plugin answers its whole record, and
  a refusal is the plugin's own sentence.
