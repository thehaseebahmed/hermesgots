# A room's row draws its members, four at a time

A chat's row leads with the bot that answers it. A room has two to six members, and leading with the one
that happens to answer says the wrong thing: the row is a place several bots are in, and its second line
already lists their names. A list of names is slow to scan; the row's first slot is where the eye lands.

**So a room's row draws its members' own pictures**, overlapped by 8px in the order the Host seats them,
each picture above the one it covers so the cluster reads left to right. The cluster stops at four: a
fifth member and beyond become a `+N` chip in the row's muted tone. A rail draws one picture — the member
the row is most likely to answer as — because a 44px rail has a slot, not a width.

**What follows, and is accepted.** The pictures are decoration beside the row's words: they are hidden
from a screen reader, which gets the room's name and its members from the row's own line, so a cluster
never becomes a list of unlabelled images. A member whose bot this device does not hold has no picture:
it is counted in the `+N` rather than drawn as a gap or a placeholder face, so the count can say more
than the cluster shows for a reason other than length. And the cluster is bounded rather than scrolled or
wrapped — four is a rule, not a measurement of the row's width — so a room of six and a room of four look
different at a glance and neither grows the row taller.

## Considered and rejected

- **The answerer's picture, with a `+3` badge.** One face says "this is a chat with that bot", which is
  the sentence a room's row must not say.
- **A micro-grid of faces on the row's second line.** It competes with the members' names, and a 9px
  face is a coloured dot: it loses the one thing a picture is for.
- **A ring or a backing disc per face.** The bots are drawn as their art everywhere else in the app; a
  circle behind a character that is not round adds a second shape to explain, and the pictures' own
  transparency already separates them.
