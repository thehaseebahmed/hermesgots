# AI Dictation says what made a take, and Cleanup is only for one the host heard

Status: grilled 2026-11-03 against the code, the glossary and the ADRs it touches, and re-settled the
same day after the branch was rebased onto ADR 0074's wire; every decision below is recorded in
[ADR 0082](../adr/0082-cleanup-is-only-for-a-take-its-host-transcribes.md). Published as #800 with
tickets #801, #802, #803 and #804, which are worked in that order. The spec carries `ready-for-agent`
and the tickets stay bare, so the agent claims the spec and works the graph. #800 is blocked by the
gate issue #806, which the docs pull request #805 closes: work starts on that merge, when this file is
on `main`.

## Problem Statement

Two things a **Dictation** says about itself are wrong on screen, and one thing happens that should
not. The screen that lists them is called **Dictation**, a word that reads like something the user
dictated rather than something a model wrote, while every take is machine-written and — until this
change — machine-tidied as well. The sheet's first block is labelled **Heard**, which names an act
rather than the text: what sits under it is one model's transcription, and the rename the rest of the
app already made (**Transcribed**) stops at the sheet.

The row records the **Speech provider** and a model (ADR 0074, #756), and the model is always the
*local* model's name: the host answers the field a local decode would use even when a cloud provider
heard the take. A take heard by Groq is therefore logged `groq · base`, a pair no host ever ran, and
the one case the field exists for — a bot whose speech leaves the machine — is the case it reports
wrong. A host that cannot name its provider's model has no way to say so, and the sheet prints the
local model's name beside the vendor's.

**Cleanup** runs on every take, including one that left the host. A cloud take is decoded by a vendor
and then rewritten by a second model that never heard the audio and cannot check a word of it against
the recording, while the bot's Speech-to-text page offers the **Cleanup level** and the cleanup model
as live choices whose effect the user cannot see. The two texts are the only evidence, and their
difference cannot be attributed to either model.

And the Speech-to-text page holds no answer of its own. It draws its rows only once its read lands —
on a slow host, a page of blank space where the values it last read would do — and the only thing
remembered between reads is the speech model's name, kept on the bot. A user who opens the page on a
phone with no signal sees nothing at all, though the device answered that page five minutes ago.

## Solution

The log's screen is **AI Dictation**, and its sheet's two blocks are **Transcribed** and **Cleaned
up**: the words say what they are, not who did what. A row names the model that actually heard it —
the local model's name where the take never left the host, the provider's own model where it did, and
nothing where the host cannot name one.

**Cleanup** runs only for a take its host heard. A take that left the host is transcribed once and
those words are what land; the host answers it at level **None**, with `cleaned` false and the two
texts equal, so the sheet draws one block. The bot's level is kept rather than cleared, and reads
again the moment its route is **Local**. The Speech-to-text page draws the cleanup card's three rows
greyed and untappable under one reason line, and the row's own muted line says **Not tidied** in the
same words a take the user set to None reads.

The Speech-to-text page opens on the last answer this device received: every row drawn, every row
muted and untappable until a fresh read replaces it, a page-level loader where nothing was ever read,
and a failed read leaving the cached copy muted under the host's own sentence. The Bots tab's model
line reads from the same cached answer; the mic keeps its own read, because a stale answer there costs
a failed take rather than a dimmed row.

## User Stories

1. As someone opening Settings, I want the screen called **AI Dictation**, so that the name says the words were machine-written rather than typed.
2. As someone reading a finished take, I want its first block labelled **Transcribed**, so that I know those are the model's words and the second block is what landed.
3. As someone whose takes go to a cloud provider, I want the row to name the model that actually transcribed it, so that a provider is never printed beside another provider's model.
4. As someone on a host that cannot name its cloud model, I want the row to say only what it knows, so that no model name is invented.
5. As someone who reads a row weeks later, I want the muted line to keep saying what tidied it and whether that changed anything, so that I can tell a tidied take from an untouched one.
6. As someone whose bot transcribes on a cloud provider, I want Cleanup's rows to say why they are unavailable, so that a dead switch is explained rather than broken.
7. As someone whose bot hears on its own host, I want those rows live exactly as they are today, so that nothing changes for me.
8. As someone who moves a bot back to **Local**, I want my **Cleanup level** still set, so that I do not have to pick it again.
9. As someone reading a take that left the host, I want one block rather than two identical ones, so that nothing implies a cleanup ran.
10. As someone opening the Speech-to-text page, I want the values it last read drawn at once, so that the page is not blank while the host answers.
11. As someone who taps a row before the fresh answer lands, I want nothing written from a value that may be stale, so that a stale level or model never reaches the host.
12. As someone opening that page on a slow host, I want a loader rather than a page of blanks, so that I know something is coming.
13. As someone whose host is away, I want the cached values under the host's own failure, so that I know they may be old rather than silently trusting them.
14. As someone glancing at the Bots tab, I want the model line to be the last one read and drawn muted until it is confirmed, so that the two screens never disagree.
15. As someone who dictates, I want the mic's readiness to stay a live answer, so that a button never invites a take the host will refuse.
16. As someone whose host has never timed its hearing, I want no measurement started while the page is muted, so that a stale block does not put the host to work for nothing.
17. As someone reading a row written before any of this, I want it drawn as it was, so that an older log never reads as broken.

## Implementation Decisions

**The names.** The Settings menu row and the screen it opens are called **AI Dictation**; the URL
segment stays `dictation`, the bot's page stays **Speech-to-text**, and the glossary's **Dictation**
keeps meaning the row. The sheet's blocks are **Transcribed** and **Cleaned up**, and the sheet keeps
its current shape: the two blocks, then one muted line with the bot, the words and the spoken time,
then what tidied the take, then Delete and Copy. No provenance is drawn beside a block.

**What tidied a take** stays the four fields #756 added — the **Cleanup level**, whether the cleanup
changed anything, the **Speech provider** and the model — and the sheet's existing line keeps reading
them. A take that left the host reads **Not tidied · <provider> · <model>**: the same words a take
the user set to None reads, because it is the same state, and the page is where the reason lives.

**The model a row records.** The host answers the model that did the work, not the model a local
decode would have used: the local model's name for a take its host heard on `local` or
`local_command`, and otherwise the resolved provider's own model as the bot's config states it
(`stt.<provider>.model`, or that provider's `model_id` where it spells it so), falling back to that
provider's schema default where the key is unwritten. A provider whose model the host cannot name
records no model at all, so a row's pair is either both true or half-empty and never a provider
beside a model it never ran. A take confirmed by a host too old to answer this still records what
that host answered, and the sheet prints what it has.

**Where the Cleanup rule lives.** In the host, inside the **Confirm**, because that is the only call
that runs **Cleanup** and because a second client confirming the same take must get the same answer.
For a take whose resolved route is a cloud **Speech provider** the host runs no cleanup at all and
answers: the **Transcribed** words as the text, the same string as `heard`, level `none`, `cleaned`
false. It does not clear, rewrite or validate the bot's stored level, and a bot whose route returns
to **Local** is cleaned at the level it kept.

**The take wait stops charging for work that will not run.** The bound a **Confirm** is held to is
the queue plus the cleanup's deadline at the bot's level and, for a cloud take, the upload. A cloud
take's bound drops the cleanup term, so the bar is the queue and the upload only, and the level's
deadline moves a local host's bar exactly as it does today.

**What the page draws.** The Speech-to-text page draws the **Cleanup level** row, the cleanup model
row and the **Hearing prompt** switch greyed and untappable while the bot's route is a cloud provider,
under one reason line: *Cleanup is only available with local models.* The rows are greyed rather than
hidden, so the settings a reader can see are the settings the bot has, and a host that advertises no
**Cleanup level** feature keeps the page it has today.

**The page's last answer.** The whole speech payload is cached on the device, per bot, keyed by the
connection it came from, and written on every successful read and every successful write. It is this
device's own copy and is not synced. The page draws it immediately with every row muted and
untappable; the fresh read replaces it and unlocks the page in one step. With nothing cached the page
draws a page-level loader; with a cached copy and a failed read it stays muted under the host's own
sentence, and the reason a row is muted is that no fresh answer has landed. The Bots tab's **On ·
model** line reads the cached model and draws it muted until a fresh read confirms it. The mic keeps
its own `info` read and the cache it already keeps, because there a stale answer costs a failed take.
No hearing measurement is offered or started while the page is muted.

**Older rows and older hosts.** A row written before this change keeps its four fields empty and
draws no provenance line. A host answering without the model field leaves the model empty. Nothing
is refused, and nothing is invented.

## Testing Decisions

The seams the work is tested at, highest first, all of them existing: the **Confirm**'s answer (the
plugin's dictation suite already pins its fields and its refusals), and the two app surfaces that
render it — the **AI Dictation** screen's sheet and the Speech-to-text page — both of which already
have component cases. No new seam is proposed.

- The host's answer: a local take's cleanup as today; a cloud take answering level `none`, `cleaned`
  false and `heard` equal to the text, with the bot's stored level left where it was; the Confirm's
  bound for a cloud take carrying no cleanup term and a local take's carrying it; a provider whose
  model is written, one whose model is the schema default, and one the host cannot name answering no
  model. Prior art: the plugin's dictation suite, which already covers the payload's fields.
- The row: the four fields round-tripping through the host's record and the device's mirror, a row
  written before them reading empty, and the host's copy winning where it has something the device
  lacks. Prior art: the mirror cases alongside the dictation log's.
- The sheet: **Transcribed** and **Cleaned up** as its labels, one block where the texts are equal, a
  `none` take reading **Not tidied** rather than "found nothing to change", and a row with no model
  printing only a provider. Prior art: the screen's own component cases.
- The page: the cached copy drawn with every row muted and untappable before the read lands, the
  page-level loader where nothing is cached, the muted copy kept under a failed read's banner, the
  clean-up card greyed with its reason for a cloud route, and the Bots line reading the cache. Prior
  art: the page's component cases and the host-speech cases.

Good tests here assert what a reader sees and what the wire carries — a block's label, a line's words,
a payload's fields, a row's stored value — never the order of a render or the shape of a hook.

## Out of Scope

- Storing the cleanup's own provider and model. The level and whether anything changed are what the
  sheet needs; which model tidied a take stays unrecorded (#756's four fields are the whole of it).
- A Stats tab broken down by provider, model or level.
- Any change to the sheet's layout beyond its labels, or to the History list's rows.
- The mic's bar, its wait and its readiness: unchanged, including the `info` read it keeps.
- The hearing measurement itself (#768), beyond not offering it while the page is muted.
- Cleaning up a take heard by another client's cloud provider, or any second client of this wire.

## Further Notes

The four fields this spec's line reads are #756's, and its own text says the model is "behind hearing
and tidying it" — the intent was always the transcriber's. This spec fixes that half: what the host
answers and what the sheet prints.

Version skew runs one way. A host on an older plugin answers the local model's name for a cloud take
and the app prints it; the fix needs both sides. The gate is the app's own release, so a row can say
`groq · base` for as long as that pairing exists — which is why the sheet prints the pair it was given
rather than reconstructing one from the settings.

The local-only rule reverses a clause of ADR 0069, which leaned on the cleanup to carry the bot's
**Vocabulary** and the chat's names where a cloud **Hearing prompt** is never sent. A cloud take's
misheard name now stays misheard; ADR 0082 records that cost and why it is accepted.

## Tickets

- [ ] #801 — feat(dictation): the log's screen is AI Dictation, and its blocks Transcribed
- [ ] #802 — fix(dictation): a row names the model that heard it
- [ ] #803 — feat(dictation): the Speech-to-text page opens on the last answer it read
- [ ] #804 — feat(dictation): Cleanup is only for a take this host transcribed

## Build order

The four slices share no blocking edge and each is demoable alone, so they open in parallel. A reader
who wants one at a time works them in the order above: the two names first because they touch the two
surfaces everything else draws in, the row's model next because it is one field's truth, the page's
cached answer after it because it changes when the page may be tapped, and the Cleanup rule last
because it is the only one that changes what a take does.

## Risks

- **A cache drawn louder than it is.** The cached values are muted and untappable by design, but a
  muted row still reads as a fact. The reason a row is muted is the absence of a fresh answer, and the
  banner is the host's own sentence, so the failure mode is a page that looks older than it feels.
- **Not tidied reading as a choice.** A cloud take and a take the user set to None read identically on
  the row. That is deliberate — one state, one word — and the page's reason line is the only place the
  difference is explained, so a user who never opens that page may read the rule as their own pick.
- **A pair recorded by an older host.** Until both sides carry the fix, a cloud row can read
  `groq · base`. The sheet prints what it was given rather than recomputing it, so the wrong pair is
  visible rather than hidden — the alternative would let the app invent a model the host never named.
- **A mute that never lifts.** A host answering every read with a failure keeps the cached copy muted
  behind its own sentence, which is honest but indefinite; a bot this device never read stays on the
  page-level loader until the read's own timeout turns it into that failure.
