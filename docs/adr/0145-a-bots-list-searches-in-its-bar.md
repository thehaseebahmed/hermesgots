# A bot's list searches in its bar from the laptop width up, and its pills filter its rows

A bot's chat list kept its search at the foot, in a circle beside the New pick, and ADR 0141 refused
moving it to the bar on the ground that a field in the header would be a second place to look for one
field. Haseeb asked for the bar's field at a laptop's width on 2026-11-11: on a laptop the foot's circle
is a tap spent on a field that has room to be there always, and the list has no rows to protect from it.
**So from 1280px up — the app's `useXLarge`, its own name for a laptop — the foot draws no search at
all, and the field stands in the bar's pinned slot, above the filter pills; below that width the foot's
circle and its field are exactly what they were.** The screen decides which of the two exists and tells
the foot whether it offers a search at all, so `#chats-search` is never in the tree twice. The words a
reader typed belong to the screen rather than to either field, so the move itself clears nothing — but a
crossing that also hands the list to the shell's pane mounts the list afresh, and a half-typed search
goes with that mount, which is what widening a window at this address already did.

**The pills filter the rows.** All, Unread, Chats, Rooms and Routines stand under the search in the same
pinned slot, at every width, as the app's shared `Chip`s; the one pressed is remembered on this device,
and All is what a device that never chose opens on. The rule deciding what each keeps lives beside the
list's search rule (`lib/chat-list.ts`), which is what keeps a pill, its empty sentence and a row's
unread dot from disagreeing: Unread is the same mark the dot reads, Chats is a row that is neither a
room nor a routine's run, and a pill that keeps nothing says its own sentence rather than the search's
"No chats match."

## Considered options

- **Keeping the search at the foot and only shrinking it.** The ask is a laptop's arrangement, not a
  phone's: at 1280 the list often stands in its 412px lane, where the field costs no rows, and the
  circle is a tap spent for nothing.
- **Both, the circle and the bar's field.** Two places to look for one field is what ADR 0141 refused,
  and both would want the same id and the same words.
- **A container query, so the pane decides from its own width.** It needs a mechanism the app does not
  have, and the ask was about displays rather than lanes; a 412px lane gets the bar's field too, and
  reads.
- **The filter pills in the scroll flow, as Code's list draws its own row of them.** A filter that
  scrolls away is not reachable on the list it filters.

## Consequences

- ADR 0141's search stays the rule below 1280, and its rejection of the move no longer stands above it;
  0141's head names this ADR.
- The list's bar carries three things now — the bot's row, the field at a laptop, the pills — so a
  phone's list loses a pill row of height and a laptop's loses a field's.
- A remembered pill can hide rows that arrive; the pill pressed, always on screen, is the whole
  mitigation.
- Unread is empty on a device that has opened nothing, exactly as its dots are.
