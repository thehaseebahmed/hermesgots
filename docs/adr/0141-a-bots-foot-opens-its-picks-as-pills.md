# A bot's foot opens its picks as pills, not the app's pop-up

**Amended by [ADR 0145](0145-a-bots-list-searches-in-its-bar.md)** from the laptop width up: the foot
draws no search there, and the field stands in the bar above the list's filter pills. Below that width
this ADR's foot is unchanged.

The app's pop-up is the sheet a one-tap pick opens from a button — a Material bottom sheet below
1024px, a menu beside its anchor from there, decided with Haseeb on 2026-10-16 and drawn by
`components/popup.tsx` — and a bot's chat list used it for the two things its foot can start: New chat
and New room. That is a drag handle, a scrim, a title and a second surface over the list, spent on two
rows that never change and never grow, and on a phone it costs a tap to open and a second to dismiss.
The list's search control sits beside it at the foot, where the thumb is; its pick was the one thing on
that bar that went somewhere else.

**So the foot's button is the pick.** Tapping it swaps its face from `+` to an X, reads `Close` while it
is open, and raises the two actions as pills stacked above it — one line each, icon and label, New chat
nearest the thumb and New room above it where the Host advertises one. The pills stay mounted and inert
while closed, so their rise and its quiet fade both play.
A press outside closes them, caught by a press-catcher the foot lays behind the stack, and so does
Escape and the button itself; every way out returns focus to the button. The picks' own stack carries
`data-toast-above` while it is up, so a toast raised on this screen clears the pills as well as the
button rather than landing under them. The field takes the circle's place in a single frame: the row
keeps one height, so nothing above the foot moves when it opens.

**The button holds the foot's whole state.** Closed, picks or search: the accent `+`; the accent X while
the picks are up; the muted X, reading `Close search`, while a search holds the foot. One control, one
slot, one focus target — nothing is ever stacked in it, and the state is one value rather than two
booleans that could both be true.

**This is the app's one exception, and it is the foot's alone.** Every other pick made from a button —
the composer's `+`, a model field, a new session's project — keeps the pop-up, because those picks have
rows that grow, search or scroll. The foot's has two rows of fixed shape in the one place a thumb
already rests.

## Considered options

- **Keeping the pop-up and only restyling its rows.** The sheet's chrome, its scrim and its dismissal
  are most of what the two taps cost; the rows were never the problem.
- **A menu anchored above the button at every width**, as the pop-up already becomes from 1024px. A menu
  over the list is a second floating surface at a thumb's reach with its own edge and shadow; two pills
  are the same two rows without it.
- **A `+` that morphs into the pick's surface.** Nothing morphs: the picks are two controls of their own
  standing above the button, and the button stays a button.
- **Moving search to the bar as well**, since the foot would then hold one control. The ask puts the
  search in the foot, and a field that moves to the header on a laptop would be a second place to look
  for it.

## Consequences

- The app now has two answers to "a pick opened from a button": the pop-up, and this one. The pop-up
  stays the rule everywhere else, and `AGENTS.md`'s map of `routes/bot-chats.tsx` says where the
  exception is.
- The foot's button is named `New` while closed and `Close` while open, so the label a test or a screen
  reader finds depends on the state — the flows that walk this screen click `New`, then the pill.
- The pills hang over the list's last rows while they are up. The foot keeps its sticky place in the
  scroll, so the last row is reachable once they close, but a cluster opened on a full list covers a row
  or two.
- Search's ways out are Escape and the grey X alone. A press outside does not close the field, because
  the reader is typing in it and a stray tap must not take the keyboard away.
