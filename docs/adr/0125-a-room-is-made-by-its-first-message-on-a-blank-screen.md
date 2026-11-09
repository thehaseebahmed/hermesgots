# A room is made by its first message, on a blank screen

Starting a chat and starting a room are the same act to the person doing it, so the app starts both the
same way: an address that is not a thing yet, a composer, and nothing else. A chat's blank screen already
exists (ADR 0096) — its first turn is what creates the session. A room had the opposite shape: a sheet in
the sidebar asked for the room's name and its bots, pressed Create, and the Host made a room before
anybody had said anything into it.

**So New room opens a blank room at `/new-room`**, and nothing about it is a record: no row, no Host call,
no name typed. Its seats are picked in a pill above the composer — the bots of one Host, two at least and
six at most — and the room is made on the first send. That send creates the room on the Host, writes the
row the Host answers, moves the address to `/c/<id>`, and hands the message over to the room's screen,
which sends it as the room's first turn.

**Its name is its seats until the Host names it otherwise.** The create call needs a name, and the person
has not given one: the seats' own names, in the order they were picked, are what the row is called. A
rename through the room's menu replaces it, and so does a name the Host gives the room later — the room's
name is the Host's (ADR 0122), so whatever the Host's record says is what the app draws.

**What follows, and is accepted.** A room opened and left costs the Host nothing and leaves no row: the
"abandoned creates" the sheet could produce do not exist. A room's seats cannot be changed after it is
made — the Host declares no method that edits a roster (ADR 0124) — so picking them before the first
message is the only chance, and the pill says so where they are picked. And the create and the message
are two calls: a create that lands and a send that fails leaves an empty room on the Host, which the room's
own screen then shows, with the message still in its field to retry.

## Considered and rejected

- **The name field stays, the seats move to the composer.** A blank screen with a required text field is
  not blank, and a derived name is one fewer thing to fill in before the first message.
- **A sheet without the name, opened by the first send.** Then the user types, presses Send, and is asked
  a question: the message would have to wait on a sheet, which is the "send that does nothing yet" a
  blank chat already avoids.
- **`/new-room` with a picker the app draws itself.** A tab or a mode in the composer would have to be
  maintained beside the seat list a room's screen already knows how to draw.
