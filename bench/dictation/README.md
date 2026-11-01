# The dictation bench

What a take costs the host that hears it, measured over committed audio. ADR 0075 says why this
exists and what it refuses to measure; this file says how to run it and what its record means.

One command, on a machine with a speech model installed:

```bash
python3 -m bench.dictation
```

It hears the nine fixtures in `fixtures/`, one take after another — uploading each Piece the way the
app does, letting the host's own worker hear it as it lands, and ending each take with the one Confirm
that carries words — prints a line per take, and reads the run against the baseline committed beside
the fixtures. Both the command and `--self-check` run from the repository root.

## What it measures, and what it doesn't

The **Confirm span** is the host's: from the Confirm arriving to its answer leaving, the quantity
`info.dictation.wait_ms` bounds. Beside it the record carries each Piece's decode, the take's spoken
span, what the Cleanup cost, and the words that landed. It does **not** measure **Stop to text**,
which is the device's share and belongs to the lane that dictates on a phone. No number here is "the
take's latency", and a figure without its name is a figure without a meaning.

The seam is the plugin's own take functions, called in process (`plugin/dictation.py`'s `upload`,
worker and `confirm`). There is no HTTP, no server, no port and no version gate between the
measurement and the thing measured; the plugin's own tests drive the same functions with a stubbed
transcription, and this bench replaces only that stub with a real decoder.

## Installing the decoder

The bench hears with `faster-whisper`, the model Hermes's local path uses. What it is pinned to lives in
`requirements.txt` beside this file, and `av` is pinned below 14 there: `faster-whisper` 1.2.1 calls
`av.open(..., metadata_errors=...)`, which av 14 dropped, so a bare `pip install faster-whisper`
installs a decoder that cannot open a file.

```bash
python3 -m pip install -r bench/dictation/requirements.txt
python3 -c "from faster_whisper import WhisperModel; WhisperModel('base')"   # fetches the model
```

A host with no decoder runs `--self-check`, and a plain run says `skipped: …` and exits 0 rather than
reporting a pass.

## The flags

| Flag | What it does |
| --- | --- |
| `--cut device\|pause-first\|whole` | where a Piece's cut falls (default `device`, the rule the app runs today) |
| `--level none\|light\|medium\|high` | the bot's Cleanup level (default `none`, which makes no call) |
| `--model`, `--compute-type`, `--language`, `--beam-size`, `--threads` | the decoder; all named in the record |
| `--no-hearing` | send each Piece with no prompt. On by default, because the Hearing prompt is what carries a Vocabulary to the decoder (ADR 0067) |
| `--no-pace` | upload every Piece at once instead of at the pace it was said, leaving the worker no time to overlap a decode — the worst case at Stop |
| `--no-vocabulary` | drop the fixtures' Vocabulary; the names case is meant to fail without it |
| `--fixture NAME` | hear one fixture (repeatable) |
| `--cleanup-url`, `--cleanup-model`, `--cleanup-key` | an OpenAI-compatible endpoint for a cleaning level |
| `--baseline PATH` | the baseline to read this run against (default: the one committed for this cut policy — `baseline.json` for `device`, `baseline-pause-first.json` for `pause-first`) |
| `--out PATH` | write the run's whole record as JSON |
| `--write-baseline` | rewrite the committed baseline from this run |
| `--no-check` | record and print without reading the baseline |
| `--json` | print the record itself |
| `--self-check` | the bench's own rules, the fixture set and the baseline, with no decoder anywhere near it |

## The fixtures

Nine recordings, chosen by what can go wrong rather than by count, each with its reference transcript
committed beside it. One voice, synthesised once: the bytes are the fixture, so a regenerated voice
cannot be mistaken for the one a baseline was taken on.

| Fixture | What it is for | Route |
| --- | --- | --- |
| `one-piece` | a one-Piece take: one thing said, nothing else | local |
| `straddle` | a sentence that straddles a pause: one Piece under `device`, two under `pause-first` | local |
| `long` | a long unbroken take: past the floor with no pause to open at | local |
| `silence` | room tone: no words at all | local |
| `names` | names said against a Vocabulary (`Gots`, `Memento`, `Haseeb`, `Nous Research`) | local |
| `floor` | speech over a floor above the app's quiet threshold: no pause is ever confirmed | local |
| `cloud` | a take for the cloud path: held whole and uploaded once, at its Confirm | cloud |
| `sixty` | a sixty-second take in several Pieces | local |
| `opus` | the app's own container, Opus in WebM, sent whole | local |

Every fixture is one Piece under some policy and several under another, except the room tone and the
cloud take, which are one Piece under all of them — a cloud host holds the take and uploads the whole
of it at once, so a cut into several Pieces is refused rather than measured as if it weren't.

The `names` case is its own acceptance test: with the Vocabulary it lands `Gots`, `Memento` and
`Haseeb`; without it the same audio lands "Goths" and "his sea b" and word error rate goes from 0.07
to 0.50 (`--no-vocabulary`). The two-word entry `Nous Research` comes back as "News Research" on
`base` either way, which is why the record reports a list of misses and not a yes.

## The record

```text
Dictation bench — 9 fixtures, cut device, level none, model base, pace live, Hearing prompt on
faster-whisper 1.2.1, av 13.1.0 · base int8 · en · beam 5 · 4 threads · warm 0.8s
host 80f1c4acc9d5 x86_64, 16 cpus, python 3.13.5
hallucinations not filtered: no Hermes here to filter with
fixtures sha256 46862ea23bbd4072… (9 files)

take       path   pieces  longest  spoken  decode  cleanup  confirm   wer  words
sixty      local       7     9.9s   58.7s   12.1s     0.0s     1.5s  0.03  I want to write the whole thing down…
```

A run of some of the fixtures says so (`3 of 9 fixtures`), and its record carries `subset: true`.

`--json` (or `--out`) gives the same run as a record, one entry per take: `spoken_ms`, its `pieces`
(each with its length and its own decode), `decode_ms`, `cleanup` (level, the plugin's own milliseconds, how many
calls it made, whether the words changed), `confirm_ms`, `heard`, `landed`, `reference`, `wer`,
`vocabulary`, `provider`, `model` and the fixture's own `fixture_sha256`, plus the record's `object`,
`at`, `subset`, `totals` and `fixtures.heard`. A Cleanup nothing was asked of records `ms: null`
rather than a zero, so no column can read "free" for a cost nobody measured. The header names the machine, the
decoder (backend, model, compute type, language, beam, threads, temperature, whether a VAD ran), the
Cleanup level, the cut policy's every number, whether the Hearing prompt rode along, whether a
Vocabulary was sent, the pace, whether the host's own hallucination filter was in the path, and the
fixture set's hash. The pace is in the header and not in the comparison: it decides how long the host
had to keep up, never which words came back.

`--fixture NAME` hears one fixture and reads it against the baseline's take for that fixture; the
header still carries the whole set's hash, so a run of some of the audio is compared with the set the
baseline was taken on rather than refused outright.

That header is what makes two runs comparable: a run whose decoder, level, cut policy, Hearing prompt,
Vocabulary, hallucination filter or fixture hash differs from the baseline is **refused as
incomparable** (exit 2) rather than read as a change.

## The baseline

`baseline.json` holds what the same bytes and the same model must keep saying: the cut, each take's
spoken span and Piece lengths, the words that landed, their distance from the reference, and whether
the Vocabulary came back as spelled. It holds **no timing**, because a millisecond belongs to the
machine that measured it. A run's own record carries the timings; the baseline is the file a reviewer
diffs.

A baseline belongs to the machine that took it: the same bytes and the same model can land a word
differently on another CPU, so the run's `host` is part of what it is compared on, and a run from a
machine the baseline was not taken on is refused rather than read as a regression.

There is one baseline per cut policy — `baseline.json` for `device`, `baseline-pause-first.json` for
`pause-first` — so the two slices of the same audio are a diff rather than a memory. On this host they
read:

| | `device` | `pause-first` |
| --- | --- | --- |
| `straddle` | 1 Piece | 2 Pieces |
| `sixty` | 7 Pieces, 12.1 s decode | 15 Pieces, 21.7 s decode |
| `sixty`'s words | word error rate 0.03 | word error rate 0.04 |

More Pieces buy a smaller tail at Stop and cost more decodes, and the words barely move — the trade
#771 exists to weigh.

- A run that disagrees with it exits 1 and prints where, word by word — and a take whose words did
  not move says so, so a cut change is not read as a decoding one.
- A run that can't be read against it exits 2 and says which field moved. A run with no baseline to
  be read against also exits 2: a gate that goes green when its baseline is deleted is a gate that a
  deleted file turns off.
- `--write-baseline` rewrites it. A commit that rewrites this file states its delta: the diff of one
  file is the history, and a baseline moved without a sentence saying why is a regression wearing a
  tidy diff (ADR 0075).

## Where it runs

It is a job of its own and never a case in the plugin's unit tests: a decoder is not installed on
every runner, and a timing assertion inside a required check is a flake waiting for a busy machine.
`.github/workflows/dictation-bench.yml` runs it on the nightly sweep and on a pull request that
touches `plugin/**`, the bench or the app's own cut rule (`app/src/lib/dictation.ts`, which the
`device` policy is copied from), installs the pinned decoder, proves it is there and caches the model.

It does not compare against the committed baseline there, and says why: that file belongs to the
machine that took it, and a runner is not that machine. What the job proves instead is the property
that has to hold anywhere — the same bytes and the same model land the same words twice in a row on
its own CPU — by taking a record, then hearing the set again against it. Both records are uploaded,
including when that comparison failed, which is the run a reviewer most needs.

Neither gate depends on a timing number: only the words can move it.

## What this bench does not do yet

- **The Cleanup is only measured where a model can be asked.** The bench runs outside a Hermes
  process, so there is no `ctx.llm` behind the plugin: at `--level light` (or above) without
  `--cleanup-url`, the level's call is skipped, the heard words land, and the record says
  `asked: false` beside the level. Run against any OpenAI-compatible endpoint to measure a real one.
- **A cloud take is heard by the host's own decoder.** No vendor is called, so the cloud fixture's
  figure is the host's share of a cloud take — the held audio and the one whole-take decode — and
  never a vendor's.
- **The hallucination filter is Hermes's, where a Hermes is installed.** The plugin drops the words a
  model writes over room tone by importing `tools.voice_mode_transcript`; the bench registers that
  module as it is when the host has one, so a full host measures the path it really runs. On a host
  with no Hermes at all the import fails, the decode is what the model wrote, and the record's
  `hallucinations` line says `not filtered`. The room-tone fixture lands nothing on `base` either
  way; a model that writes "Thank you." over silence shows up there as a word where none belongs,
  which is the finding.
