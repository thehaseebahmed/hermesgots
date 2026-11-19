# The canvas bench

What a canvas request costs a host, measured over committed prompts. The plan
(`docs/plans/2026-11-19-canvas-builds.md`, G11) says a fixed set of canvas prompts is graded before
and after the change, reported and never gated; this file says how to run it and what its record
means. The dictation bench (`bench/dictation/`, ADR 0075) is the shape this one follows.

## What it measures

A canvas request was one freeform turn whose page nobody ran. A build plans, writes a draft and is
checked on the rendered page (ADR 0170, 0171). This bench is how that is measured rather than
asserted: four fixed prompts — two first builds and two follow-up tweaks — are sent to a real host
the way the app sends them, and the page each one publishes is graded with the step 3 runner
(`plugin/canvas_checks.py`, ADR 0171): the prompt's own assertions run in the harness page the app's
frame code is bundled into, the console's errors ride beside them, and four screenshots — a phone
and a tablet, in the reader's light and dark — are kept on disk for a person.

The record answers, per prompt: the assertions that passed, the warnings the page was written with
(the store's own `canvases.warnings`, read off the published document), the turns the prompt took,
the wall time from the send to the record going still, and the version that was graded. It is
printed beside the machine, the model and the path, and read against the baseline: agreed, moved, or
refused as incomparable.

It does **not** measure what a page looks like. The screenshots are for a person, and no number
here is "the page's quality" — a figure without its name is a figure without a meaning.

## Where it runs

The prompts are sent to a real host over the routes the app itself calls: `POST /canvases` queues a
first build on a fresh canvas's session, and a follow-up is posted to that session on Hermes's own
`/v1/runs`. Nothing is simulated on that path — the host's model answers, or the prompt grades as
having produced nothing.

The grading is the plugin's own runner, called in process the way the plugin reaches Hermes's
browser layer — `tools.browser_use_cli`. That layer exists only inside a Hermes process, so the
bench runs on the Hermes host itself, from the repository root:

```bash
python3 -m bench.canvas --base http://localhost:8642 --key <the bot's key>
```

A host whose browser layer isn't in reach still runs: every page grades `unchecked` with the
plugin's own reason, and the record says so (ADR 0171: a build never stalls on its checks).

## The flags

| Flag | What it does |
| --- | --- |
| `--base URL` | the bot's base URL, the shape the app holds; its trailing `/v1` is dropped |
| `--key KEY` | the bot's key, sent as its bearer token |
| `--provider`, `--model` | the pick the run body names; the host's own model where none |
| `--profile ID` | the bot's profile id, where a host serves more than one |
| `--prompt NAME` | ask only this prompt (repeatable); a tweak's own first build comes with it |
| `--shots DIR` | where the four screenshots per prompt are kept (default `canvas-bench-shots/<when>`) |
| `--poll-ms`, `--quiet-ms`, `--max-wait` | the wait: how often the record is read, how still it must be to read as ended, and the bound |
| `--out PATH` | write the run's whole record as JSON |
| `--baseline PATH` | the baseline to read this run against (default: the one committed beside the prompts) |
| `--write-baseline` | rewrite that baseline from this run |
| `--no-check` | record and print, without reading the baseline |
| `--json` | print the record itself |
| `--dry` | a record from the canned page: no host, no browser, no model call |
| `--self-check` | the bench's own rules, its fixtures and its host client, on a stub |

## The prompts

Four, chosen by what a canvas build has to get right rather than by count. A prompt's text and its
assertions are the fixture: changing either moves the set's digest, and a run on another set is
refused as incomparable with the baseline rather than read as a regression. The assertions are
scripts the runner runs in the page's own context, inside the harness — `document` is the page's,
and `window.canvas.data` is the bridge answered from the read-only snapshot.

| Prompt | Kind | What it asks | What the page must answer |
| --- | --- | --- | --- |
| `standup` | first | a three-column standup tracker with an add form | the three parts named, the data bridge answering a read, a way to add |
| `standup-filter` | tweak on `standup` | a filter row above the list | a filter control, standing above the list, the page still reading its data |
| `dashboard` | first | three stat cards over a bar chart, reading the reading log | a chart drawn with a width, the three stats named, the bridge answering |
| `dashboard-streak` | tweak on `dashboard` | today's bar highlighted, the streak card first | the chart still drawn, the stats still named, the bridge still answering |

A tweak runs on the canvas its own first build left **in the same run**, so a run of a tweak alone
is refused: the set has to hold the prompt it follows.

## The record

```text
Canvas bench — 4 prompts, model gpt-5-codex / openai-codex
harness sha256 31baf9d5ede99a67… (2318036 bytes) · browser ready · plugin 0.123.0
host 7900fdd3678e x86_64, 16 cpus, python 3.13.5 · path http://localhost:8642/api/plugins/gots
prompts sha256 4fda0e9ab8aa57df… (4 prompts)

prompt             kind    passed  turns    wall  warn  version  check
standup            first     3 / 3      1   42.1s     0        1  passing
standup-filter     tweak     3 / 3      1   18.7s     1        2  passing
dashboard          first     2 / 3      1   51.3s     0        1  failing
dashboard-streak   tweak     3 / 3      1   22.0s     0        2  passing
  dashboard: the page draws a chart — the page draws no chart
totals                  11 / 12     4  134.1s
```

The header is what makes two runs comparable: the prompt set's digest, the model that was asked,
the machine's shape, the harness artifact the page was drawn in, whether a browser was there to
draw it, and the plugin that answered. A run whose terms differ from the baseline's is **refused as
incomparable** (exit 2) rather than read as a change. A run that agrees prints its differences
(exit 1) or says it is clean (exit 0). The machine's name and its Python are printed and never
compared, the way the dictation bench treats them: a millisecond and a hostname belong to the
machine that measured them.

`turns` counts the runs the bench made — one per prompt on the single-session path; a build's plan
and report rounds are turns too, and that is the column the before-and-after comparison reads. The
wall time is the send-to-still span, which is a measurement and never a promise.

## The baseline

`baseline.json` holds the **"before" run's stable half**, taken on the single-session path before
builds: each prompt's assertions as they were answered, the warnings the page was written with, the
turns it took, and the reason a check that couldn't run gave. It holds **no timing** and **no
screenshots** — a millisecond belongs to the machine that measured it, and the four drawings are
kept on disk for a person.

A baseline belongs to the machine that took it: the same prompts and the same model can draw a page
differently on another host, so a run from a machine the baseline was not taken on is refused rather
than read as a regression.

```bash
python3 -m bench.canvas --base URL --key KEY --write-baseline
```

A commit that rewrites this file states its delta: the diff of one file is the history, and a
baseline moved without a sentence saying why is a regression wearing a tidy diff (ADR 0075).

## The canned page, and `--dry`

`fixtures/canned-page.html` is a standup tracker — the `standup` prompt's own page — and
`fixtures/canned.json` is what a run of that prompt would have recorded: its three assertions pass
on it, one turn, one version. The fixture's claims are read off the page by `--self-check` as far
as a page's text can be read without drawing it; the drawing itself is a real run's to prove.

`--dry` prints a record from it and needs no host anywhere near it. What it measures is measured
for real — the machine, the harness the page would be drawn in, whether this host can draw at all,
and the warnings the page was written with, read by the store's own rule. The grade, the turns and
the wall time are the fixture's own, and the record says so on its face:

```bash
python3 -m bench.canvas --dry
```

## Where it does not run

It is a job of its own and never a case in the plugin's unit tests: a run costs model calls, and a
grade is a report rather than a pass, so **no CI gate reads it**. `--self-check` is the piece that
runs anywhere: the prompt set's rules, the canned fixture's claims, the client's addresses, the
reading of a run against a baseline, and the whole run loop against a stub of the host's contract —
the client's bodies, its wait and its clean-up — with a browser layer planted the way the plugin's
own tests plant one.

```bash
python3 -m bench.canvas --self-check
```

## What this bench does not do yet

- **No baseline is committed.** It is taken on a real host with `--write-baseline`, on the
  single-session path before builds; until one is, every real run is refused as having nothing to
  be read against, which is the refusal a deleted baseline also earns.
- **The "after" column is step 14's.** The same prompts through builds, each prompt's grade printed
  beside the baseline with its delta.
- **A run's end is a quiet window**, not a run's status: the record going still for `--quiet-ms` is
  the signal a client has, and a page still being written when `--max-wait` runs out is answered as
  unfinished rather than graded as it stood.
- **A page that writes data is graded against a snapshot**, not the host — the check's own rule
  (ADR 0171), carried into the bench with it.
- **A tweak's canvas is the one its first build left in the same run**, so the tweaks measure a
  change to a page the bench itself made, never to a page a reader has lived with.
