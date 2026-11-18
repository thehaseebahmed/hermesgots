# A chat and a list stand on their header's edge

A chat's header row and its cards were the 672px box with their 16px gutters outside it, while a
reply's text was 640px with a second 16px gutter inside that box (ADR 0114). The list screens did
the same: their header stood on the 672px box and their body was `max-w-2xl px-4`, so their rows
started 16px inside it. On a phone the two never parted, since the pane is narrower than the box and
everything takes the pane's own 16px gutter; but once the pane was wider than the box, the words and
the rows started 16px in from the header's back button and stopped 16px short of its far edge. At
1920px the back button stood at 990px and a reply's text at 1001–1641px. A chat's thread also
centred on the pane less its scrollbar, which reserved its gutter on one edge only, so the whole
thread stood 5px left of the header.

**Decision.** One column: a 672px box with its gutters outside it. `COLUMN` is that box for a chat's
header, text and cards alike, and `PAGE_BODY` is a list screen's body — `max-w-[704px] px-4`, the
box with its gutters outside — so a list's rows start on its header's pixel. Where the chat's pane
holds the box with room for a thin scrollbar each side (724px), the thread's scrollbar gutter is
balanced on both edges, so the thread centres on the pane as the header does.

**Considered options.** Narrowing the header to 640px, which kept ADR 0114's measure but left the
cards 16px past the header on either side and the chat no wider; leaving it, which is what a reader
noticed.

**Consequences.** A chat's words widen from 640px to 672px — about 85 to 90 characters a line at
15px — and so do the list screens' rows, so the two still match each other. A card no longer frames
the text with a 16px gutter on a wide pane: it stands on the same edge, as it always did on a phone.
Between a 704px and a 724px pane, with a classic scrollbar, the header caps while the thread still
fills, so the two part by up to half a scrollbar; an overlay scrollbar (a phone, macOS) takes no
width and they meet exactly. The card-widths flow measures the header's edge against a reply's text
and card at 390, 1024, 1440 and 1920px, and a bot's chat list rows against its header at 390 and
1920px. This amends ADR 0114's numbers and ADR 0047's frame; ADR 0047's rule — a card fills its
container and never passes the box — stands.
