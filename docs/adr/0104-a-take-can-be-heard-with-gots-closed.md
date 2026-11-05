# A take can be heard with Gots closed

A take is the host's: the device cuts it into Pieces, uploads each as it closes, and one Confirm
answers the words. Nothing in that belongs to the composer — but everything that runs it does. The
recorder is `getUserMedia` plus a `MediaRecorder` in the WebView, its Pieces are uploaded by the
page, and the take is dropped when the screen that started it unmounts. A Bubble that only exists
while another app is in front therefore cannot borrow any of it.

**So the Bubble carries its own recorder, in Kotlin, and speaks the same wire.** `AudioRecord` at
16 kHz mono, cut on the page's own rule — a short floor, a confirmed pause, a length cap — with each
Piece written as a self-contained WAV, uploaded as it closes with its index, its span and the bot's
vocabulary, and one Confirm at the end. The cut is confirmed on the page's own 50 ms tick; the level
meter is read out every 100 ms, because a reading per frame scrolled the bars twice as fast and read
quieter than the room was. No route is added to the plugin, no setting is added to the
host, and the words arrive on the same call the app's bar waits on. No `hint` is sent: on the page's
own wire that parameter is the chat's title, project and repos, and a Bubble take has no chat to
describe — sending the bot's name in its place would spend the decode prompt's window on a word the
user is not saying.

**The cut is copied, and it is the accuracy story.** A Piece ends where the speaker paused, so one
thought is heard as one Piece; the cap exists so a room that never falls quiet still closes one, and
it stays under the host's own queue allowance because a Piece is also the tail a Stop waits for. The
numbers live in three places — the bench's policy, the page's constants, and this recorder — and the
check that holds them together reads both files: `app_rule_problems` in `bench/dictation/cut.py` is
handed `BubbleRecorder.kt` as well as `dictation.ts`, and compares the tick as a span (samples over
the rate) because the phone counts samples where the page counts milliseconds.

**What crosses to the phone is one bot.** Its plugin root (profile path and all), its key, its name,
its vocabulary, and the host's own Confirm bound, written whenever this device's selection moves. The
page is the only side that knows any of it, and a service that waited for the page to be alive could
not start a take at all.

## Considered options

- **Keep the WebView's recorder, held alive in the background by a microphone foreground service.** No
  second recorder to write. Rejected on three counts: the page's take is dropped when its screen
  unmounts, what a backgrounded WebView does to a live `getUserMedia` stream is undocumented and
  untested in this tree, and the take's ending assumes a mounted composer to land into.
- **One Piece for the whole take, uploaded at Stop.** Simpler, and one container means no concatenation
  on the cloud path. Rejected on the host's arithmetic: the Confirm's drain is a flat 30 s at every
  Cleanup level, so a 60-second Piece needs the host to decode faster than 0.5× real time, and the
  page's 25-second cap exists for exactly that reason.
- **A new host route that takes a whole recording and answers words.** Rejected twice over: the four
  existing routes already carry a take without a session, and nothing on the host can insert text on
  the phone, so the route would buy nothing the Confirm does not already.
- **Mirror every bot and let the phone pick one.** Rejected for scope: the choice is this device's
  selection, made in one place, and the phone needs exactly one credential block.
- **Ask the host on the first tap instead of mirroring.** Rejected: the service cannot know a bot's key
  or how a multiplexed host spells its profile, and a phone that could not reach the host would have
  nothing to say about why the tap did nothing.

## Consequences

- A third copy of the cut constants, and the first the compiler cannot share. `app_rule_problems`
  holds the bench, the page and the phone together by reading both files, so a number that moves in
  one alone fails the bench; the copies agree because they are compared, not because they are one.
- A take heard from the Bubble uploads WAV — about 32 KB/s against the page's 3 KB/s opus. Acceptable
  for takes measured in seconds, and the reason a long one is not a use case this first landing takes.
- One take at a time per bot is the host's rule, unchanged: the app and the Bubble collide on it, and
  the host's own `409` sentence is what the Bubble shows.
- A Bubble take posts the **Dictation** row it is, written by the phone itself just after its Confirm
  answers (ADR 0107): History is every take its bot heard, not only the ones that landed in the app's
  own composer. A take the phone could not type is still kept for the page as well, because the toast
  that promises the take is saved has to be telling the truth.
- A foreground service of the microphone type runs for as long as the Bubble is switched on, with its
  own notification channel; the device itself is opened for a take and released when it ends. That is
  the price of a microphone Android will hand over on a tap, and it is why the notification is
  permanent while the mark is.
