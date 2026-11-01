Status: its tickets carry `ready-for-agent`, and none starts before its own blockers close — every one of them waits on #774, the docs gate that pull request #773 closes on merge. Design: [ADR 0075](../adr/0075-a-dictation-is-measured-at-two-ends.md), which records the two ends a take is measured at and declines ADR 0019's tier rule for a bench. Its tickets are #769, #770, #771 and #772; #771 and #772 also wait on #769. ADR 0074's clause on why a Piece is cut on the device is amended in the same change, and the Glossary's **Hearing prompt** entry is corrected with it — the prompt has never carried the take's text.

## Problem Statement

Dictation is tuned by argument, and it is the one feature judged by a feeling nobody measures. A take's row records how many words were said and how long they took to say; the host states a bound it will not pass; the model picker prints realtime factors nobody has timed. What a Stop actually costs — the words arriving in the composer — is recorded nowhere, so a change to how long a **Piece** runs, which prompt the decoder gets, or which model hears it is defended by reasoning and re-argued the next session. ADR 0067 said so itself: the **Hearing prompt**'s quality "is measurably different, and it is not knowable from a spec which way a take reads better on the host that hears it" — and then shipped without the measurement.

The same gap hides the work that would help most. A take is decoded a **Piece** at a time, each its own pass over a model, so the count of Pieces is the multiplier on everything the user waits for — and the rule that decides a Piece's length has never been checked against a number. Whoever dictates on a phone watches one word, "Transcribing…", for a wait that can run to the length of the host's whole queue, and cannot tell whether it is getting better.

## Solution

Two named numbers, measured at the two ends of a take, replace the argument.

A **Confirm span** is the host's: from the Confirm arriving to its answer leaving, the quantity **Take wait** already bounds. **Stop to text** is the device's: from the last word of the take to the words standing in the composer. A bench that runs on the host drives a take's own functions in process over a committed set of audio fixtures and records each Piece's decode, the Cleanup, the Confirm span, and the words against a reference transcript; the dictation flow that already exists records Stop to text against the mock, which measures the app's own share and nothing more. A committed baseline turns the diff into the history, and every run carries the machine, the model, the level and the cut policy beside its numbers, because a number without them is an anecdote.

With the ruler in place, the first change it justifies: a Piece closes on the first confirmed pause after a short floor, and at twenty-five seconds at the latest, instead of waiting for six seconds of speech before its first chance. Fewer, longer Pieces mean fewer seams for a sentence to be cut at, fewer full passes over the model, and a smaller tail left at Stop. The second: a host measures its own hearing speed once, and the picker states that measurement rather than a printed guess, with the model the measurement recommends named in the row.

## User Stories

1. As someone who dictates on a phone, I want the words to appear sooner after I stop, so that dictating feels like talking rather than waiting.
2. As someone who dictates, I want fewer garbled words where my sentence was cut in two, so that I do not have to read my own message back.
3. As someone who dictates long paragraphs, I want the wait at Stop to stay short as the take grows, so that a long take does not cost twice its length.
4. As someone whose names and product words are not ordinary English, I want those words spelled the way I spelled them, so that I stop fixing them by hand.
5. As someone on a slow laptop, I want the speech model picker to say what my machine actually does, so that I can choose a model that fits it.
6. As someone on a slow laptop, I want the app to name the model the measurement recommends, so that I am not left on a setting somebody guessed.
7. As a maintainer, I want a change to dictation to carry a number before and after, so that I am not defending it from memory.
8. As a maintainer, I want one command that hears a set of fixtures on this host and prints what each take cost, so that judging a tuning change takes a minute.
9. As a reviewer, I want a pull request that touches dictation to show its bench record, so that I can see what it did to the words and to the wait.
10. As a reviewer, I want to know which number a claim is about — the host's or the device's — so that a slow phone is never mistaken for a slow host.
11. As someone reading this repo later, I want the decision to measure recorded as a decision, so that the next session does not re-litigate it.
12. As someone reading a take's log, I want the row to keep meaning what it says, so that "how long they took to say" is never quietly a different measurement.
13. As someone whose host is slower than they expected, I want the measurement to be able to show it, so that a slow host is a fact rather than a complaint.
14. As an agent working this spec, I want the fixtures to be the same bytes every run, so that a number from last week can be compared with mine.

## Implementation Decisions

- **Two numbers, named by their endpoints.** A **Confirm span** (host) and **Stop to text** (device). Neither is "the take's latency", and no figure may be quoted without saying which one it is.
- **The bench drives the take's own functions in process**, not the HTTP route: the same upload, the same worker, the same Confirm. It runs where a real decoder is installed, and it takes the cut policy as an argument, so identical audio can be sliced two ways.
- **What a run records**: seconds spoken, the Piece count and each Piece's length, each Piece's decode, the Cleanup's milliseconds, the Confirm span, Stop to text as the host sees it, the words that landed, their distance from the reference transcript, whether every **Vocabulary** word came back as spelled, and beside them the machine, the model, the **Cleanup level**, the cut policy and the fixtures' hash.
- **The fixtures are committed bytes**: eight short recordings and one Opus-in-WebM, chosen by what can go wrong — a one-Piece take, a sentence that straddles a pause, a long unbroken take, room tone, names said against a Vocabulary, speech over a floor above the app's quiet threshold, a take for the cloud path, and a sixty-second take in several Pieces. A reference transcript is committed beside each.
- **The baseline is committed**, one record per fixture set and model, so the diff of that file is the history and a pull request's body is never the only place a number lived.
- **The device's number is measured in the dictation flow that already exists**, timestamped at the Stop the user presses and where the composer takes the text. The mock behind it answers a constant, so the figure is the app's share only and is never a bar on the decoder.
- **A change is held to a budget, not a behaviour**: a p95 for Stop to text on a stated host, a zero delta for the words on unchanged inputs, and a names case that fails when the Vocabulary is removed.
- **A Piece closes on the first confirmed pause after a short floor, capped at twenty-five seconds.** The cap stays under the host's queue allowance, because a Piece is also the tail a Stop waits for.
- **The picker states measured speed and names the model the measurement recommends.** The model Hermes runs when nothing is picked is Hermes's own key and stays out of this change.
- **Latency is not kept on a dictation's row.** The row's spoken span is the denominator for words per minute, and a mirrored row cannot hold a number whose halves belong to different machines.

## Testing Decisions

- **The seam is the plugin's take functions, driven in process.** It is the highest point at which a real decoder runs without a phone, an HTTP server or a browser in the way, and it is where the fixture bench stands. It is taken deliberately over a bench against the running host, which would add a server, a port and a version gate to a measurement.
- **What a good test asserts here is a budget and a delta**, not an implementation: the same fixtures against the same model land the same words, the silence fixture lands none, and a take's Stop to text stays under its stated bound on a stated machine.
- **Prior art**: the plugin's dictation tests already drive these same functions with a stubbed transcription, so the bench replaces only the stub with a real decoder and a fixture. The flow that dictates already plays a synthetic voice with scripted pauses, and the lane's timing is taken from it.
- **The bench is a job of its own, not a unit test**: a timing assertion inside a required check is a flake, and a decoder is not installed on every runner. The plugin's unit tests keep their stub.

## Out of Scope

- Words appearing before the Confirm, provisional text, and any progress count on the voice bar (ADR 0038's no-preview rule stands).
- Moving a **Piece**'s cut to the host.
- Detecting the spoken language per take, or pinning one.
- Any field on the dictation row for latency, and any change to the words-per-minute rate.
- The **Cleanup**'s default level, its rules, its bounds and its prompts.
- Streaming or CTC speech engines beyond the local faster-whisper family.
- Accuracy figures for cloud providers, and any ranking that compares one host with another.
- The **Hearing prompt**'s default. This spec makes it measurable; it does not flip it.

## Further Notes

- ADR 0067's own sentence — that the prompt's quality is "not knowable from a spec" — is the first thing the bench settles, and it stays unsettled until a run says otherwise.
- Two record defects were found while grilling this. The Glossary's **Hearing prompt** entry claims the prompt carries "the text of the take so far", and no code path ever does, so each Piece is heard on its own; that is corrected in this change. And at the code's own caps the prompt can run about three times the decoder's prompt window, so sending it can truncate the hint it exists to deliver — recorded here because it changes what the prompt's default can be argued to do.
- ADR 0074 says a Stop waits for one Piece's decode plus a Cleanup. The host drains every Piece whose words have not landed, so that holds only when the worker has caught up; saying how often it does not is the bench's first job.
- The bench cannot run where a decoder is not installed. The fixtures, the command and its record are still checkable without one; the numbers need a host.

## Tickets

- [ ] #769 — A bench hears a take on the host, over fixtures
- [ ] #770 — The app's own share of a take's wait is printed
- [ ] #771 — A Piece closes on silence, capped at twenty-five seconds
- [ ] #772 — The speech model is elected by a measured probe

## Build order

1. #769 — the bench, its fixtures, its baseline and its job in CI. Edge: #774, the docs gate.
2. #770 — the lane's Stop to text, printed by the flow that already dictates. Edge: #774; it may land in parallel with #769.
3. #771 — the cut rule, the counts it moves, and the bench record showing the words did not. Edge: #774, #769.
4. #772 — the host's own measurement on the picker's rows. Edge: #774, #769.

## Risks

- **A bench that measures the wrong thing.** The record is compared field by field against a committed baseline, and the fixtures' hash rides in it, so a regenerated voice cannot be compared with an older one; a number that moves without the file moving is the tell that the run was not reproducible.
- **Fixtures too easy.** A names case that passes with the Vocabulary removed proves nothing, so that pair is the case's own acceptance test: if a deliberately broken prompt still spells every name, the fixture set needs a harder one rather than a bar.
- **A baseline updated in the same commit as a regression.** The commit that updates it states its delta, and the diff of that one file is what a reviewer reads; a baseline with no delta sentence is a regression wearing a tidy diff.
- **A floor too low.** Cutting at every comma fragments a sentence into Pieces the model reads alone; the bench's two policies are what say whether the floor moved the words, not the reasoning that picked it.
- **The cap against the queue's allowance.** Twenty-five seconds sits under the host's thirty-second drain allowance; a cap that grows past it turns a long take's Stop into the bound rather than its last Piece.
- **The lane's figure read as the take's.** The mock answers a constant, so the number printed there is the app's share; a bar placed on it would be a bar on the mock.
