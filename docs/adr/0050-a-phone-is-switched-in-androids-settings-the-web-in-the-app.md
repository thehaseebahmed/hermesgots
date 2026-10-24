# A phone's push is switched in Android's own settings, and the web's in the app

Every push a device wanted was decided twice. The app kept sixteen switches — the categories — in
`pushCategories`, and each category's channel went to Android wearing the same name, so Android's own
notification settings held a second copy of the same sixteen decisions. The app's copy was the one the
registry obeyed, so a category switched off meant no push was sent at all; the phone's copy was the
one that decided whether it showed. Nothing kept them in step, and the screen a user reaches by
long-pressing the app icon was the one the app could neither read nor write. That screen also cannot
group: Android lists channels flat, so a name has to carry its own feature, and the old ones repeated
each other — two *Run failed*, two *Run finished*, and three failures that never said what failed.

The switch now belongs to whoever owns the device's notifications. On Android the **Notification
settings** row opens the system's own screen for the app — the master switch, then every channel with
its own on/off, sound and peek setting — and the app offers no list of its own there at all. On the
web the row opens the app's list, unchanged in shape, because the web has no channels and that list
is the only switch there is. The Android app reads the phone back instead of asking: at launch and on
every resume it reads which channels exist and what importance each holds, and registers only the ones
still allowed — importance *none* being the user's no — with an empty list when notifications are off
altogether. Coming back from the system screen is a resume, so a channel switched off there reaches the
registry on the way back into the app. A blocked channel therefore costs no push, which is the one
thing the old second switch was ever good for.

The sixteen kinds stay sixteen channels. Each is named for the event and reads as *Feature: event* in
Android's list (*Code: Pull request merged*) because that list has no headers, and as the bare event
under the app's feature heading on the web. Only what waits on the user peeks: the four categories
carrying a question, an approval, a plan or a brief are made at importance 4, every failure and every
completion at 3, and a merged pull request — the quietest news there is — at 2. That importance is the
app's first word only. Android hands the decision to the user from their first edit, and nothing in
the app may overwrite it.

A channel exists only once the app has made it, and Android keeps it in the list afterwards. So the
app makes channels for the features this device can see — Meetings' two only once the experiment is on
— makes the test notification's on the tap that sends one rather than at every launch, and deletes the
*Test notification* channel that an earlier build made for everybody.

## Considered options

- **Three channels by intent** — needs you, finished, failed — with no per-kind control. Rejected: it
  is the tidier list and importance follows it exactly, but it gives up control a bot's owner really
  uses, such as *pull request checks failing* loud while *pull request merged* is off, or a routine's
  failure told apart from a chat's. Disambiguating names buy the same scannability without the loss.
- **One channel per feature**, five in all. Rejected for the same reason and more so: Chats alone
  would merge a question with a finished reply.
- **Keeping the app's list on Android beside the system screen.** Rejected: the app cannot change a
  channel a user has edited, so the two lists can disagree with no way to reconcile them, and a switch
  reading on while the phone drops the push is worse than no switch at all.
- **Sending every push and letting Android drop what it drops.** Rejected in favour of reading the
  channels back at resume: the reads already happen for the permission, and carrying them into the
  registration is what stops a muted channel costing a push.
- **Deleting the device from the registry when the phone's notifications are off.** Rejected: the
  device is not gone and the user did not turn this app's switch off. An empty category list says the
  same thing without forgetting either.
- **Letting the test push take Android's default channel.** Rejected on inspection: that default is a
  fallback channel Android creates and names *Miscellaneous*, so the row does not disappear, it turns
  into one that hides a real channel.

## Consequences

- A channel's name and importance become part of the phone's record. Renaming updates it on the next
  launch; changing its importance after a user has touched it does not take, so a category's default
  is fixed the day a device makes its channel.
- Every Android install is re-registered once with its live channel list on the first resume after
  this ships. The registry filters by the categories a device last sent, so a phone holding a subset
  would keep dropping everything the app no longer asks about; one that never sent any falls back to
  `chat_input` and `code_input` alone.
- The app's `pushCategories` becomes a web-only fact. A stored value left on a phone is dead weight
  and costs nothing.
- The in-app list keeps its per-feature switch: six Code categories turned off one at a time is the
  only alternative the web has to a bulk control.
- Android's screen is reached through a third small native plugin beside `ShareTargetPlugin` and
  `OpenImagePlugin`; nothing about it reaches the web build.
