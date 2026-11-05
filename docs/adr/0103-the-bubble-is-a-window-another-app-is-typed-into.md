# The Bubble is a window another app is typed into

Speech-to-text today ends in Gots's own composer: the words are React state on the textarea that
started the take, and there is no path from a take to any other app's field. Wanting to dictate into
the message box you are looking at means leaving the app, which is the whole of what the Bubble is
for. So the phone gets one control that stays on the screen while another app is in front, and the
words are typed into whatever field that app has focused.

**The door is an accessibility service.** Only it can read the focused field of another app and put
text in it, and the shipping products that do this on Android (Wispr Flow, Google's Voice Access)
ship the same way; the open-source ones that avoid the permission are keyboards instead. The service
declares both of its jobs in its own description: the focused field, which the words are set into when
a take ends, and the phone's interactive-window list, which is how the keyboard being up is read. It
reads nothing else, and the window list is read for the Bubble alone — with no mark running there is
nothing to tell.

**The mark is a window of its own**, drawn by the service that keeps the microphone rather than by
the accessibility service — `TYPE_APPLICATION_OVERLAY`, so the phone's draw-over grant is asked for
separately from its accessibility toggle. Two grants for two jobs, and each failure names itself: the
tap that switches the Bubble on asks for one, waits to be come back to, asks for the next, and says in
one toast why there is no Bubble when either is refused. One grant for both would make a mark that
never appears and a field that never fills the same sentence, which is the state a user is most likely
to be in.

**A grant that is taken away takes the Bubble with it.** Neither grant tells an app anything when it
goes, so the mark watches both — the accessibility service's own unbinding, and the draw-over grant
every second and a half — and drops itself, leaving the switch off, rather than staying on screen as a
control that can only fail.

**The mark is shown for the keyboard.** It is on screen while the phone's keyboard is up — the state a
person dictates in, and one only the accessibility service can read, from the phone's interactive-window
list — with a take and the five seconds after it exempt, because the keyboard can be dismissed mid-take
and the way to stop the take must not go with it. A mark that stayed over a screen with nothing to type
into would be a control with no possible outcome.

**Insertion is best-effort and is never retried.** The words are set into the field at the cursor —
the field's existing text before the selection, the words, then the text after it — and the action's
own answer decides whether to fall back. The fallback is the clipboard and a paste, with the transcript
marked sensitive because it is the user's own words, and with the previous clipboard put back where the
phone lets this app read it — where it does not, the transcript is cleared instead, so a dictation is
never the thing the next paste offers.
A field that reports failure and has in fact taken the text is a documented shape in this ecosystem,
so a blind second attempt is how one sentence becomes two.

## Considered options

- **An input method (a keyboard).** The cheapest in permissions — no runtime prompt, no accessibility
  toggle — and the most reliable insertion, because a keyboard commits text to the field it is
  attached to. Rejected because it replaces the user's keyboard, and because a keyboard has no mark
  on the screen: the whole ask is a control that floats over another app.
- **A bubble alone, with the words left on the clipboard.** One grant, and no accessibility service at
  all; the user pastes. Rejected as the product — a paste per take is not dictation — but kept
  exactly as it is as the failure path, which is why the fallback is not a second-class path.
- **`TYPE_ACCESSIBILITY_OVERLAY`, the window an accessibility service owns.** One grant instead of
  two, and one system screen instead of two. Rejected because the two grants fail for different
  reasons and are given on different screens, so a single toast could not say which one is missing —
  and because the draw-over grant is the only one the phone can take away with no callback at all
  (`onUnbind` is the accessibility service's own), which is why the shipped watch polls one and is
  told about the other.
- **The share sheet.** Already wired in this app and needs no permission, but it reaches only apps
  that declare a share target, through that app's own compose flow, and never the field in front.
- **Typing key events into the focused field.** Rejected: it would have to invent a keyboard layout,
  lose every non-ASCII character and fight every field's own input filter, to produce text the field
  could have been handed directly.

## Consequences

- Two grants, both the phone's, both switched on outside the app. The app can only read them and send
  the user to the screen that gives them.
- The service reads the focused field and the phone's window list, and nothing else; both are named
  in the description the accessibility list shows, which is the only reading the design is entitled
  to.
- Insertion can fail on fields that refuse `ACTION_SET_TEXT` — WebView editors are the well-documented
  case — and the Bubble says so rather than losing the words silently.
- A take's words arriving in another app is a second device-side end for **Stop to text**, which the
  dictation ADR defines as ending in the composer. That measurement is not changed here: the Bubble's
  own end is out of scope for the first landing, and the ADR that defines the number still holds for
  the app's bar.
- Gots is distributed as a signed APK, not through Play, so the accessibility policy that governs a
  listed app is not the gate here; the phone's own settings are.
