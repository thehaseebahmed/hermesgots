# A push leaves the tray when the screen it is about is opened

A push is news about one thing — a thread, a room, a research mission, a meeting — and the app is
where that news is answered. It used to answer all of it at once: `clearNotifications()` closed every
notification the device was showing, and ran on launch, on Android's `resume` and on the web's
`visibilitychange`. Opening the app for one thread therefore took away the pushes about every other
thread, routine and mission the user had not read yet, so the tray said less the more the app was
opened. **The app now dismisses a push when the screen it is about is opened, and dismisses nothing
else on arrival.**

A chat's screen answers the thread it draws: the Hermes session its row runs in or, for a room, the
room's own id, which is what the Host pushes a room under. A research mission's screen and a
meeting's screen — and a meeting's topic screen, which is that meeting's notes — answer the ids
their pushes name. A push about a routine's last run or a project that couldn't be set up names a job
or a project that no screen opens, so the tap that came from it is what answers it: its tag names
that id, but only the tap says the user answered. Nothing reads the tray for its own sake on launch,
on `resume` or on focus: only the screen on display answers, and a launch lands on the chat the app
opens to.

The identity is one both surfaces already write. A push is tagged `<group>:<subject>` — the session
or the kind on the web (`public/push-sw.js`), the category on Android (`netlify/lib/fcm.ts`) — and
the web's notification carries its session in its data as well, so the app reads the subject off the
data first and off the tag's last segment after it. Android's `getDeliveredNotifications()` lists the
tray with that tag, and `removeDeliveredNotifications()` cancels exactly the entries handed to it, so
a dismissal needs no new field in the payload, the registry or the phone.

## Considered and rejected

- **Keeping the clear on arrival, and only for what the app cannot open.** A routine's failure and a
  project's failure do linger until tapped, and telling them apart from a push about a session would
  mean matching kinds — a second rule for the sake of tidiness the user did not ask for.
- **Matching by kind.** The routines and projects lists could then answer their failures, but a kind
  is not what a screen shows: two kinds share the chat screen, and one covers every thread.
- **Dismissing from the chat list.** A row is not the thread's screen. A chat listed as unread while
  the reader looks at the list is still news, and the row is read far more often than a thread is
  opened.
- **A new field naming the chat's row, rather than the session.** The session is what the plugin
  knows and what every push already carries; a chat id would have to be resolved on the host, which
  holds no rows of the app's.

## Consequences

- **A push about nothing openable stays in the tray until it is tapped**, where opening the app used
  to wipe it. That is the rule the change is asked for, and it is the one place the tray is less tidy
  than it was.
- **An APK whose plugin predates `getDeliveredNotifications()`** keeps its tray: the call throws and
  the dismissal is swallowed, which is no dismissal rather than the wrong one.
- **A push that arrives while the app is hidden on the thread it is about** is dismissed when the app
  comes back to that screen, since the hook runs again on `visibilitychange` and a hidden screen
  answers nothing. The plugin skips a device whose stream is open, so only a hidden app can be
  reached that way.
- **The phone's branch is pinned, not run.** The component tier has no Android, so
  `getDeliveredNotifications()` and `removeDeliveredNotifications()` are held by a source-text test
  (`app/scripts/test-push-tray.mjs`) — the fallback ADR 0019 allows where driving the phone is the
  only way to see it.
