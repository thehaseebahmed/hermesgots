# A Bubble dictates into whatever app the phone is showing

Status: built on the branch. Design: [ADR 0103](../adr/0103-the-bubble-is-a-window-another-app-is-typed-into.md)
for the door, [ADR 0104](../adr/0104-a-take-can-be-heard-with-gots-closed.md) for the take that runs with
the app closed.

## Problem Statement

A take can only start in Gots. The recorder is the WebView's, the words land in the composer, and the
take dies with the screen that started it — so speaking into the message box you are actually looking
at means leaving the app, dictating, copying, and pasting. Everything that makes this app's dictation
worth using already exists on the host: the bot's speech model, its Cleanup level, its vocabulary.
What is missing is a way to reach it from outside the app.

Three things do not answer it. The voice bar is inside a composer, and there is no composer in another
app. The share sheet reaches only apps that declare a share target, and never a focused field. And the
phone's own keyboard microphone is not the bot's: it hears with the phone's engine, tidies with
nothing, and knows none of the bot's names.

## Solution

A **Bubble**: one mark that stays on the phone's screen while another app is in front. Tap it and a
take starts; talk; tap again and the take ends. The bot's host hears it, its Cleanup runs at the bot's
level, and the words are typed into the field that app has focused. Gots does not have to be open.

It is switched on from **Settings › AI Dictation › Overview**, which is the first tab and the one the
screen opens on (History, then Bots follow it). Two card groups sit above the totals — **Bubble**, and
**Stats** for the totals themselves:

- **Bubble** — a switch, and the tap that throws it.
- **Bot** — the name of the bot this phone dictates to; the tap opens a list of the linked bots, each
  row that bot's own picture, its name and the provider and model its takes are heard by, in the order
  the Bots tab lists them. The pick moves the app's own selection with it.

The two grants the Bubble needs are the phone's, so they are not settings of the app's and get no rows.
The tap that switches the Bubble on walks the user through them instead: the phone's own screen for
drawing over other apps, then its accessibility list, each one asked for only after the user comes back
with the last. A grant refused is one toast saying why there is no Bubble — *Without drawing over other
apps there is no Bubble to tap* or *Without the accessibility service the Bubble cannot type* — and
nothing starts on half of them. A phone that already has both starts the Bubble at the first tap.

A grant taken away later takes the Bubble with it: the mark drops itself and the switch goes back to
*Off*, with no error to read and nothing left on screen.

Idle, the mark is a 48 dp circle inset 20 dp from the screen's right edge — the size and the gap the
marks that do this job on Android are read at, so the line of text it floats over still reads under it
— draggable and snapping to the nearest edge at the same gap, and it is only on screen while the
phone's keyboard is up — that is the state a person dictates in. A phone that changes shape under it
keeps it on that edge: unfolded to a bigger screen, or turned, the mark is put back at the gap it
keeps, on the side it was docked to and at the share of the height it was left at, rather than left
standing where those pixels used to be. It grows out of that edge as the keyboard brings it and
shrinks back into it as the keyboard goes, so the mark that comes with the keyboard reads as the same
control each time. A take and the five seconds after it
are the exception: the keyboard can be dismissed while the user is talking, and a mark that vanished
mid-take would take the way to stop it with it. The pill
grows away from the edge the mark is docked to and collapses back onto the same corner; its background
is a 70% shade so the app underneath stays readable. A take turns it into a pill: close, a level meter,
done — the meter is its full width from the first frame, drawing silence as dots and speech as bars so the
two read apart at a glance. Every slot is a bar at the height its loudness earns — silence is a dot,
not a gap — and the room is scaled by the meter rather than by the recorder, because a
reading the view has to undo is a scale in two places: a level is read against the quietest the room
has been heard and drawn as its distance above it, so a quiet speaker in a quiet room moves the meter
as far as a loud one in a noisy room. The take's last words are sent whatever the
meter made of them: a quiet tail is still the user's. While the host is hearing the take the pill is a spinner and nothing else,
exactly as wide as the spinner: the wait is one thing to look at rather than a cross beside a loader.
A tap still gives the take back — a wait is out of the app's hands, not out of the user's, and a host
can take minutes over a Confirm. The meter is read out every 100 ms, which is the reading a person
sees; the cut behind it is confirmed on the page's own 50 ms tick. A take stops
itself at ten minutes. The screen is held awake for as long as a take runs. Nothing that goes wrong is
drawn on the mark — it is a Toast, where the phone already says things — and the mark stays for half a
minute after one, so the retry is a tap rather than a hunt. A take started with no field focused is not
refused: the field is read at the end, and a take that finds none has its words kept and is said to be
saved in Gots, in the phone's own words for why it could not be typed.

Dragging the mark onto the bin that appears at the bottom of the screen turns the Bubble off — the
switch in the app says *Off* and only that switch brings it back. The bin is the mark's own shade and
its own cross, not a warning: it turns red only while the mark itself is over it, which is the same
overlap the drop reads.

## User Stories

1. As someone replying in another app, I want to dictate into the field I am looking at, so that I
   never leave the conversation to write in Gots and copy it back.
2. As someone with a bot whose speech model and Cleanup level I tuned, I want the Bubble to use that
   bot, so that what lands in another app reads like what lands in the composer.
3. As someone with several bots, I want to say which one the Bubble uses, so that a work bot's
   vocabulary does not hear a personal message.
4. As someone whose phone has not granted drawing over other apps, I want the tap to take me to the
   screen that gives it and to tell me why there is no Bubble when I refuse, so that a switch that
   cannot work explains itself instead of doing nothing.
5. As someone whose words could not be typed into a field, I want to be told and to keep the words,
   so that a take is never silently lost.
6. As someone whose Memento app is already dictating to that bot, I want the Bubble to say so, so that
   I know why it refused rather than thinking it is broken.
7. As a maintainer, I want the Bubble to speak the routes the app already speaks, so that there is one
   take, one Confirm and one Cleanup, and no second way for words to be made.
8. As someone who switches accessibility off while the Bubble is running, I want the mark to go away by
   itself, so that I am never left tapping a control the phone has already stopped working.

## Implementation Decisions

**The insertion is an accessibility service's, and the mark is its own window.** `MementoAccessibilityService`
reads the focused editable node, sets its text to *before the selection + the words + after it*, and
falls back to clipboard-and-paste with the previous clipboard restored and the transcript marked
sensitive. `SYSTEM_ALERT_WINDOW` draws the Bubble; the accessibility grant types. Two grants because
they fail separately, and the activation asks for each in turn rather than offering a row for either.

**A grant that goes takes the Bubble with it.** `BubbleService` looks at both grants every 1.5 s while
the mark is up, and the accessibility service stands the Bubble down the moment the phone unbinds it.
Either way the mark is removed, the switch is written off, and the service stops: no pill message,
because there is no mark left to put one in.

**The mark is docked to an edge, not to a pixel.** The window is placed with `TOP or START` gravity at
an absolute offset, and a window keeps that offset whatever the screen does — so a phone unfolded to a
wider screen would leave the mark standing away from the glass, in the middle of the room it now has.
The service therefore keeps the two choices beside the window: the side the mark is docked to (the one
it was dropped on, or the right by default) and the share of the height it was left at.
`snap` writes both when a drag lands, to the service and to the Bubble's preferences, so a restart or an
app update puts the mark back where it was left; `onConfigurationChanged` re-places the window from
them — the same 20 dp gap, the same share of the band the mark may be dropped in — so a drag, a fold
and a restart use one rule. A screen that changed its own density gets a new face drawn rather than a window it has
outgrown, since every part of it is measured in dp when it is built. The mark grows out of its edge on
the way in and shrinks back into it on the way out (113 ms, then 80 ms, pivoted on that edge): a change
of whether the mark is drawn, not of what it shows, so it plays once per appearance and a phone set to
no animations plays it as a jump.

**The mark is shown for the keyboard, not for an app.** Only the accessibility service can see another
app's windows, so it reads the phone's own interactive-window list and the service shows or hides the
mark on that answer. The read is a binder call per window on screen, and it is made for the Bubble
alone: with no mark running the service reads nothing, and a burst of window changes — an app switch,
a keyboard opening — is answered once, a moment after the burst ends, rather than once per event. A take suspends the rule — the keyboard can be
dismissed while the user is talking — and the mark is held for five seconds after the take ends,
counted from its end rather than from the keyboard's.

**A take is heard by a Kotlin recorder inside a microphone foreground service.** `BubbleService` holds
the microphone for as long as the Bubble is on, with its own low-importance notification channel and a
*Turn off* action. `BubbleRecorder` reads `AudioRecord` at 16 kHz mono, cuts Pieces on the page's rule
(a 1.2 s floor, a 350 ms confirmed pause under a learned floor, a 25 s cap) at the page's own 50 ms
tick, and writes each Piece as a self-contained WAV, because the host probes each file's container and
never remuxes. The rule lives in the page and is compiled into the phone, so the numbers are compared
rather than shared: `bench/dictation/cut.py` reads `BubbleRecorder.kt` as well as `dictation.ts` and
fails the bench when either moves alone. Four Pieces at most are ever on their way; a host slower than
that fails the take instead of letting a queue of audio build up in memory.

**The wire is the app's, unchanged.** Each Piece is a `POST …/dictation/{take}/piece` with `index`,
`ms` and the bot's `vocabulary` repeated, as raw bytes with a real `Content-Type`; the end is one
`…/confirm` with `{pieces:N}`; a take abandoned goes to `DELETE`. A Piece is tried three times when the
host does not answer at all, and the answer is read out so the connection is reused, because a phone
loses a request to a lift and one lost POST should not cost the take. No `hint` is sent: on the app's
own wire it is the chat's title, project and repos, and the Bubble has no chat to describe. The same
cut-and-upload runs whatever provider the host resolves — nothing on the phone asks whether a take
leaves the host.

**The phone keeps one bot.** The Bubble's own, kept the first time the app mirrors one and changed only in Bubble settings, so opening another bot's chat never moves it; while that bot is disabled or gone the selected bot answers, and nothing is written. `BubblePlugin.configure` writes the Bubble's own bot's plugin root, key, name,
vocabulary and the host's own `wait_ms` into the phone's preferences; `useBubbleMirror` in the app shell
rewrites it whenever the Bubble's bot, that bot's connection, or that host's own answer moves —
it asks the host for the last of those itself, because the phone would otherwise hold the fallback for
as long as the app stayed open, and give up on a cloud bot's take while the host was still hearing it.
The Confirm is bounded by the host's number plus five seconds where there is one, and by 45 s where no
host has said; *no host has been asked* is `-1`, never a zero that reads like an answer. A mirror that
fails is tried again and said in the log: a phone left on the last bot it was told about would dictate
to another host, with another key and another vocabulary.

**Only a missing bot or a missing grant refuses a take.** No mirrored bot says *Choose a bot in Gots*,
and accessibility off says *Turn on accessibility to insert text*; a field is not needed to start, only
to land. A host that answers the first Piece with its own `409` is reported in its own
words, and a Confirm that fails deletes the take rather than leaving the bot holding it until the
host's silence sweep arrives.

**A take the phone cannot type is kept, not dropped.** `BubbleConfig.keep` writes the whole answer —
words, what was heard, the span, the level, the provider and model, the bot's own id and an id for the
take — into the phone's preferences. `BubblePlugin.takeaways` reads them and drops nothing, and the phone
keeps the last twenty, so a twenty-first take arriving before the page wrote any pushes the oldest out; `collectTakeaways` writes each as a **Dictation** under the bot that heard it and then quotes
back the ids it wrote, which is the only thing the phone forgets. A row that failed stays on the phone
and is handed over again rather than being lost behind a toast that already promised it. That toast is
what the handover is standing on.

**Every take is a Dictation, typed or not.** A take that lands in another app's field posts its own row
to its bot's log the moment its Confirm answers (ADR 0107), under the id the phone mints for it, so
**Settings › AI Dictation › History** holds the Bubble's takes beside the composer's. A post that does
not land leaves the take in the same handover a take with no field uses, and the page writes it — under
that same id — the next time the app is opened.

**The app's selection is the Bubble's bot.** Picking a bot on the Overview writes `activeProfileId`,
the same field the rest of the app reads, so the two can never disagree about which bot is selected.

## Testing Decisions

A good test here asserts the screen's answers against the phone's, not the phone's behaviour: the
rows are drawn from what the plugin reports, a tap calls the one plugin method that changes it, and a
build without the plugin draws none of it.

`app/scripts/test-bubble-takeaways.tsx` pins the handover itself: a kept take becomes one **Dictation**
under the bot that heard it, a take for a bot this device no longer has is dropped rather than
attributed to another, and the phone is only left holding what was not written.
`app/scripts/test-dictation-overview.tsx` mounts the screen on the fake Android bridge and pins the two
rows, that the grant rows are gone, the walk-through itself (the draw-over screen first, the
accessibility screen only after the page comes back with the first granted, the service started only
once both stand), each refusal as its one toast with nothing started, and picking a bot both moving
`activeProfileId` and calling `configure`. `app/scripts/test-dictation-overview-browser.tsx` drops the
plugin's header before the app is imported and asserts the card is absent while the totals stay.
`app/scripts/test-dictation-screen.tsx` was updated to the new tab order and opens History explicitly.

Deliberately skipped: anything that would assert the Kotlin. There is no emulator and no device in this
environment, so the recorder's cut, the insertion's behaviour in a real field, the grant watch and the
foreground service's start are verified by hand on a phone and not by a test that would only prove the
fake.

## Out of Scope

- Live words while the user talks, in the Bubble or anywhere else: the host answers a take once, at
  its end, which is the app's own rule.
- **Stop to text** for the Bubble's own end. The number stays defined where it was, ending in the
  composer.
- Choosing a bot from the Bubble itself, a long-press menu, snoozing, and shrinking to a dot: the
  mark stays one size and one gesture, and the bot is chosen on the Overview.
- The keyboard path (an input method), iOS, and a Play Store listing.
- Per-app suppression rules — password fields, banking apps — beyond what a field that refuses
  insertion already gives.

## Further Notes

A retry after an error needs nothing of the Bubble when the bot's speech provider changes in the app: a
retry is a new take, and a take's provider and model are resolved on the host when its first Piece
lands, so the next tap is heard by whatever the bot now says.

A Bubble take is heard by the bot's host, tidied at its Cleanup level and written into **History** like
the composer's own (ADR 0107), so the two read alike on the Dictation screen; a bot whose host resolves
a cloud provider lands its words untidied, exactly as the app's own take does, because Cleanup runs only
for a take its host transcribed.

The Bubble needs two grants the app never asked for before, and both are the phone's: drawing over
other apps, and the accessibility service. A phone with neither is walked through them on the tap that
switches the Bubble on — one screen, then the next, each read as the user comes back — and a refusal is
one toast naming the grant that is missing. Switching either off later takes the mark away and puts the
switch back to *Off* by itself.
