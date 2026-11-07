# A bot's Main and its thread share the pane, and a close is a forget

ADR 0034 made Main the pane at `xl`, with the open thread as the item beside it at the list lane's
width — 412px for Main, the rest for the thread — and a thread once opened reopened beside Main
forever. On a laptop that reads as a cramped Main and a lane that cannot be shut, so the bot's lane
alone now splits evenly: half of what the sidebar leaves each, a separator that drags the share and
remembers it on the device, and a collapse chevron in the thread's header whose close drops the
remembered id, so the next visit and the next launch open Main alone. Only the bot's lane takes the
split — Code, the projects, the meetings, research and the apps keep their list lane — and
`PaneTransition` keeps fading an item swapped for another, because a lane closing is the shell's
exit, not a swap.

**Considered options.** A fixed pixel split (breaks the day the sidebar collapses, and is wrong at
every width but the one it was measured at); a bot-only layout component beside `Panes` (two layouts
to keep in step); a `?aside=none` in the address (layout leaking into the URL, and the address must
stay on Main after a close); remembering the closed thread and reopening it on the next launch (the
behaviour the change exists to remove); one share per bot rather than one per device (a reading
comfort of the screen, not of the bot).

**Consequences.** At 1280 the halves are 480 and the thread loses 68px against the 548 it had, so
the even split is a relief from 1440 up and a draw at 1280; a reader who wants a different split has
to find the separator. A bot with no threads keeps the 412px rail that says so, so the lane's
arithmetic is the split's only when it holds a thread. Two assertions that pinned the thread's
header as control-less — one component, one browser flow — reverse with this decision.
