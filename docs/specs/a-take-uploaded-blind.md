# A take is uploaded blind and answered in one call

Status: ready for a human to read. Design: [ADR 0074](../adr/0074-a-take-is-the-hosts-and-one-call-answers-its-words.md), which supersedes ADR 0038's clauses on how a take's Pieces are orchestrated and tidied and ADR 0069's held-buffer clause. Its tickets are #753, #754, #755, #756 and #757.

## Problem Statement

Dictation is both slow and unreliable, and the reason is where the work sits. The app cuts the recording
into Pieces, sends each one as a request of its own, is answered with that Piece's words, decides when a
take has waited long enough, and then sends the joined text to a second route to be tidied. The bot's
host is told almost nothing about the take: a Piece from the middle of one and a Piece from the middle
of another are told apart by a pair of query flags, and a cloud take's audio sits in a buffer keyed by
profile.

Everything that needs the whole take is therefore done by the thing that cannot hear audio. The app
holds one clock for the Pieces and the Cleanup, so a Stop at **High** — where the host bounds its own
Cleanup at 12 s against the app's 12 s Stop — can never fit the cleanup it asked for, and the host pays
for a model call whose answer is then thrown away. Pieces drain one request after another behind the
bot's dictation lock, so a slow host's Pieces queue while the user is still talking. A cloud take left
alone for more than a minute loses what was said before that point without saying so. And a take that
dies mid-drain lands half a sentence while keeping the rest for a Retry that then re-uploads the whole
thing through a second path.

## Solution

The app uploads audio and nothing else. A Piece is still cut at a pause or at its length cap, because
only the device holds the microphone, but it goes up as audio carrying a **Take id** and its index, and
the host answers it with no words at all.

The bot's host owns the take from there: it hears each Piece as it lands, holds the take under the app's
id, and answers **one** call — the **Confirm** — with the words that landed, the words as **Heard**, how
long the take took to say, and the level, `cleaned`, provider and model behind them. The Confirm is the
only call that carries words and the only one that tidies.

A take lands whole or not at all. Send and Stop both hold the bar for the one number the host states,
and a take that cannot be finished keeps its audio for a Retry, which sends it again under a fresh Take
id. Cancel takes the audio off the host at once instead of waiting for it to expire.

## User Stories

1. As someone dictating, I want my words to land in one piece when they land at all, so that I never read half a sentence that is really the first half of one.
2. As someone dictating a long thought, I want the app to keep uploading while I talk, so that stopping does not cost the length of the take again.
3. As someone on a slow host, I want the bar to wait as long as the host itself says its work can take, so that the wait I see is the host's real bound rather than a guess made on the device.
4. As someone whose take could not be finished, I want my audio kept and a Retry that sends it again, so that a bad minute does not cost me the sentence.
5. As someone dictating, I want Cancel to take my audio off the bot's host immediately, so that the recording does not sit there until a window passes.
6. As someone pressing Send, I want the same wait as pressing Stop, so that the button I press does not decide whether my take survives.
7. As someone whose Cleanup level is High, I want a Stop to have time for its cleanup, so that the level I paid for is the level that runs.
8. As someone reading the dictation's row, I want to see which level tidied it and whether the cleanup changed anything, so that the two texts I am looking at can be read right.
9. As someone reading the row, I want to see which provider and model heard and tidied the take, so that "which model was that" stops being unanswerable.
10. As someone on a host whose speech leaves the machine, I want that take to be uploaded once, whole, when I stop, so that my audio is not sent in many small pieces through the take.
11. As someone on a local host, I want each Piece heard as it arrives and its audio dropped at once, so that the take's audio never outlives the words it became.
12. As someone pressing Cancel on a take that has already left the device, I want nothing to land, so that a cancelled take cannot arrive late and write itself into the composer.
13. As someone whose app lost the take, I want Retry to send what the device still holds, so that a dropped connection is recoverable without re-recording.
14. As someone with a bot that has never been configured, I want the same Cleanup level, Hearing prompt and Vocabulary behaviour as today, so that this change moves the workflow and nothing about how a take reads.
15. As someone whose plugin is older than this app, I want to be told so rather than have takes fail quietly, so that the upgrade is named where the bot's row already warns about plugin versions.
16. As someone testing against the mock, I want the mock to answer in the same two shapes, so that the flows prove this wire rather than a fiction.
17. As a maintainer, I want one place that answers a take's words, so that no second path can disagree about what was heard.
18. As a maintainer, I want the client to stop copying the host's budgets, so that a fifth Cleanup level or a changed deadline is not a two-repo edit.
19. As a maintainer, I want the take's audio held only where the provider needs it whole, so that the memory a host spends on dictation is bounded by one take and one id.
20. As a reviewer, I want the old routes and flags deleted in the same change that lands the new wire, so that nothing is left green for a caller that cannot exist.
21. As a reviewer, I want the mock's dictation contract to move with the plugin's, so that the app's tests cannot pass against the old shape.
22. As a reader of the codebase, I want the ADR and the glossary to say that the take is the host's now, so that the next change to dictation does not inherit the device's orchestration.

## Implementation Decisions

**The wire is a take's three verbs.** A Piece arrives at `POST dictation/{take}/piece` with `index` in the query, the bot's `vocabulary` repeated once per word and the `hint` as today; it is answered 202 with the take's id and the index it recorded, and never with text. The take ends at `POST dictation/{take}/confirm`, whose body names `pieces`, the count the app sent. A cancelled take is `DELETE dictation/{take}`. `POST dictation`'s text answer, `POST dictation/cleanup`, and the `first` and `last` flags are deleted rather than kept beside these.

**The Take id is the app's.** A uuid minted when the recording starts, sent on every Upload and on the Confirm, and replaced by a fresh one when a Retry begins. The host keys its take registry on the profile and that id, so one bot's take can never absorb another's Piece, and a Piece from a dead take can never join its replacement. One take at a time per bot stays as it is, and so does the device's own take lock.

**The host hears each Piece as it lands.** A per-take worker, off the request path, decodes Pieces in arrival order and appends their words; the Upload's answer waits for none of it. A host resolving a local backend decodes and drops the audio at once. A host resolving a cloud provider holds the take's audio and uploads the whole of it at the Confirm, and still sends no Hearing prompt — ADR 0069's provider rule and ADR 0067's default are untouched.

**The take's state is memory with a stated end.** The registry entry holds the take's words, the Pieces it is missing, and when it was last touched. It expires two minutes after the last Piece arrives, and Cancel deletes it rather than leaving it to that window. A take that expires mid-flight leaves the app to Retry under a new id; a host restart does the same.

**The Confirm is the one answer.** It drains the take's queue, runs Cleanup at the bot's level, and answers `text`, `heard`, `ms` (the words' duration, which the host now knows because the app sends each Piece's own duration with it), `level`, `cleaned`, `provider` and `model`. A Confirm naming more Pieces than the host holds is refused with 409 and the indexes it is missing; the app re-sends those Pieces once and confirms again, and a second refusal fails the take. This recovery is the only path with a second Confirm.

**A take lands whole or not at all.** No Upload carries words, so there is no partial text to land. The bar holds, on both Send and Stop, for `info.dictation.wait_ms` — the longest the host's own queue and its Cleanup at the bot's level can take between the Confirm arriving and its answer leaving, computed where those two live so that a new level or a slower provider moves it without an app release. Past it the app aborts the Confirm and fails the take, naming what the host said or that it did not answer; the audio the device holds is what Retry re-sends. The old `SEND_WAIT_MS`, `STOP_WAIT_MS` and `TIDY_MS` constants, and the drain that waited on words, are deleted.

**The dictation row keeps what tidied it.** The device row and the host's mirror both grow `level`, `cleaned`, `provider` and `model` beside the two texts, which is a migration on the host's dictation store and a new shape in its records. The sheet names the level, says whether the cleanup changed anything, and names the provider and model, so the case the two texts cannot tell apart — cleaned and unchanged against never cleaned — is answerable from the row.

**The mock speaks the new wire, and the plugin's own take tests use it too.** The mock's dictation route grows the three verbs with the same answers, including the 409 and its indexes, so the app's flows exercise the contract that ships. The plugin's dictation tests drive the registry directly: keying by id, arrival order, expiry, cancel, and the Confirm's payload.

**The version gate moves with the wire.** A plugin older than this app cannot answer the Confirm, so `MIN_PLUGIN_VERSION` rises with the plugin's own version, and the bot's row keeps saying what an out-of-date plugin means.

## Testing Decisions

- **What a good test asserts here** is what a user gets: a take pressed Stop lands one text, which is the tidied one, without any call carrying words before the Confirm; a take whose Confirm never answers fails and keeps its audio; a Retry sends a fresh Take id; a Cancel leaves nothing held on the host. Not how the registry stores its pieces, and not the shape of the app's queue.
- **The seam is one, and it is the wire**: the app's dictation hook driven against a fake host that answers the three verbs, which is where the ending's tests already stand (`test-dictation-ending.tsx` and its fake). No new seam is needed, and the highest one available is taken deliberately: every behaviour in this change is a call and an answer.
- **App, ending** — the existing ending cases are rewritten over the new wire: a happy take, an Upload that fails and is retried twice before the take fails, a Confirm that misses its bound, a 409 followed by a re-send and a success, a 409 twice, a Retry after a failure (fresh id, all Pieces re-sent), and a Cancel that deletes. Prior art is the same file, which already pins the ended-take fallbacks.
- **App, the row** — the log's two texts, its spoken ms and its four new fields are asserted where the dictation mirror and the Dictation screen are already tested: a row written from a Confirm's answer reads back on the device and is merged with the host's copy without losing the fields.
- **Plugin** — the registry and the Confirm are tested where the dictation route is tested now: state keyed by profile and id, a Piece that arrives after expiry starting nothing, words joined in arrival order, a Confirm naming more Pieces than held answering 409 with the missing indexes, the payload's seven fields, a Cancel that leaves nothing held, and a second take's Piece not joining the first's.
- **Mock and flows** — the mock's dictation answers move to the three verbs, and the browser flow that dictates keeps passing against them; a new assertion covers a take that is refused at the Confirm and recovers.
- **Nothing here needs a device or a real speech provider to be checked**, and that is the point of the seam: the wire is where the behaviour is, and the mock answers it faithfully. What cannot be checked here — the felt speed of a Stop on a real host — is a hands-on note in the ticket that lands the app's side.

## Out of Scope

- Words appearing while the user is still talking: the bar stays a meter (ADR 0038's no-preview rule stands).
- Any change to the Cleanup levels, their rules, their bounds or their prompts.
- Moving the bot's Vocabulary onto the host, and any sync that would come with it.
- A take's own record on the log for anything but the four new fields; no per-Piece history is kept.
- Offline queueing of Uploads, and any resumption of a take after the app is killed.
- Re-sending a take across a host switch, or falling back to another provider when one fails.
- Any change to how a take's words are counted, copied or drawn as two blocks.

## Further Notes

- This closes two findings already recorded in `fixes.md` from the Cleanup-levels review: the Stop that spends one clock on the Pieces and the Cleanup, and the client copying the host's per-level deadline. Both are solved by the host owning the take rather than patched where they were found.
- The trade this spec makes and ADR 0074 accepts: a wedged host now lands nothing where it used to land half the words. The take keeps its audio, and Retry is one tap.
- The glossary gains **Take id**, **Upload**, **Confirm** and **Take wait**, and **Take**, **Piece**, **Heard**, **Cleanup** and **Dictation** are amended in the same commit.
- `info.dictation` gains `wait_ms`; the page that names the provider is unchanged, and so is the Dictation tab's level picker.
- The device caches `info` for five minutes, so a bot whose level just changed can hold a stale bound for up to that long. That is stated in the ADR and is not worth a second read.

## Tickets

- [ ] #753 — A take is held on the host under the app's id
- [ ] #754 — One Confirm answers a take's words
- [ ] #755 — The app uploads a take blind and lands it from one call
- [ ] #756 — A dictation's row says what tidied it
- [ ] #757 — The old dictation wire goes, and the version gate rises

## Build order

1. #753 — the take's registry, its Piece route, the per-take worker, expiry and Cancel. Edge: none.
2. #754 — the Confirm, its 409, the Cleanup inside it, the payload and `wait_ms`. Edge: 1.
3. #755 — the app's Take id, upload queue, Confirm, bound, failure and Retry, over the mock. Edge: 2.
4. #756 — the four new fields on the device row and the host mirror, and what the sheet says. Edge: 3.
5. #757 — the pieces route's text answer and the cleanup route deleted, the client's tidy and replay paths deleted, both versions risen, the mock's old shapes gone. Edge: 3.

## Risks

- **A host that dies mid-take leaves the app holding an id it cannot finish.** The Retry path is the answer, and it must be exercised in the same change that lands the Confirm, or a dead host becomes a lost take.
- **A 409 that names indexes wrongly** sends the app into a re-send loop; the refusal's shape is pinned on both sides of the mock in the same ticket that adds it.
- **`wait_ms` computed too tightly** fails takes the host would have finished, which is worse than a longer bar; it is derived from the queue's allowance plus the level's own deadline, and stated per level.
- **The cloud path holds a whole take in memory** where it used to hold Pieces of it; the same 9 MB cap applies, and a take that exceeds it fails at the Confirm rather than at an Upload.
- **The log's migration** is the one change here that touches stored rows. Its four fields are added with defaults, and a row written before it reads as a take whose cleanup was not recorded.
