# A toast is the phone's own inside the app

The app says a great many things in passing: a save that failed, a key that was removed, a canvas
that was deleted, a log that was copied. Until now each of those was the page's sonner toaster drawing
a notice over the WebView inside the Android app, and a toast in the browser everywhere else. The app
already had one path that did it properly — the share sheet's refusals went through `lib/tell`, which
calls the `Toast` plugin on a phone — and the rest were left as "a decision of their own".

**So a toast is the phone's own toast inside the Android app, and the toaster on the web.** Android's
toast floats above whatever the page has open, including a sheet the page drew, and reads to
assistive tech as the platform's own announcement; a WebView notice is the page pretending to be the
system, and on a phone that is a lie the reader can feel. `lib/tell` is the one seam, and every toast
in `src/` asks it: `scripts/test-toast-seam.mjs` fails when anything else names sonner, so a new
screen cannot quietly go back to drawing its own.

**The trade is the tone, and the note is how it is paid.** Sonner draws four tones — an octagon for an
error, a check for a success, an i for an info, nothing for a plain message — and the phone's toast
draws none of them: it is a sentence, near the foot of the screen, and it ellipsizes when the sentence
is long. Eight messages in the app were already tone-less (a log copied, a note copied, "Copied", the
exit toast), and they keep their look on the web through `tell.note`, which is sonner's plain message
and a short toast on the phone. Only an error is long by default, as it already was, because the words
that matter most are the ones worth holding up — and a note may ask to be held, which is how the exit
toast keeps the length its own words need.

**The exit toast gave up its timing rather than the phone's toast.** "Press back again to exit" used
to be a sonner toast with a two-second life and an id the second press dismissed, so the toast asked
for exactly the press the app would still take. A phone's toast cannot be timed or dismissed, so the
seam holds one span, `TELL_LONG_MS` — Android's long toast, and the duration the page's toaster is
given for the same words — and `EXIT_WINDOW` reads that same number, so the window never closes while
the notice is still up. It can run the other way: a toast that starts late, queued behind another on a
phone or waiting on the page's own paint, stands for a moment after the window has closed, and then a
press asks again instead of leaving. That is the direction to fail in, since no press ever leaves the
app unannounced. What is lost is the toaster's dismiss: nothing can take the notice away now, so it
stands out its span — including after the app has gone.

**Words with nothing in them draw nothing.** A caller that passes an empty message — an `Error` with
no text is the reachable one — used to get an empty box from the toaster, and the plugin refused the
toast outright. The seam now says nothing at all on both roads, which is the one change a web reader
can see.

**Two things stay as they were.** The toaster is still mounted inside the Android app, because an APK
built before the `Toast` plugin has no toast to show and `tell` falls back to the page rather than
leaving the message unsaid — and the same fallback is what keeps the placement rule (`placeToasts`,
`--toast-bottom`) installed on a phone: it is the web toaster's rule, but a phone still draws through
that toaster the moment its bridge refuses, and a fallback toast landed over a composer would be
worse than a layout read nobody sees.
