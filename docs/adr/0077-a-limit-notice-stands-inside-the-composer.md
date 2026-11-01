# A limit notice stands inside the composer, on its colour and its words

**Supersedes in part [ADR 0007](0007-the-limit-notice-answers-for-the-account.md)**, whose argument
stands whole: the notice answers for the account and not for one window, the balance rule picks
before the tightest window, the sheet states every window it is given, and the dismissal is keyed on
the window's state. Two of its sentences are about where the notice is drawn and what it carries, and
those are what move — "the warning earns its place above the composer of a chat that has turns to
send", and, rejecting a banner that printed every window, "the banner is one line above the composer,
and the sheet is where windows are read".

An account's limit is a fact about the box the next message is written in: it says what that box can
do, not what the screen is about. Standing above the box it was a third row in the column — beside the
pills, arriving between them and the composer — and it pushed the composer down each time the account
moved. It now draws on the composer's own top edge, inside its rounded shell, above the text: the
composer's word about its next turn, where a field's own error sits on the field rather than above it.

**It carries no icon.** The triangle was the only saturated mark the notice had: the plate is a 10%
tint and a 16px icon on it out-read the line beside it. With the icon gone the first line wears the
tone itself, through two tokens (`--warning-ink`, `--destructive-ink`) that are the tone darkened
enough to read on its own plate — 5.25:1 and 5.06:1 in the light, where `--warning` on that plate
measures 2.55:1 and `--destructive` 4.01:1 — and the plain tones in the dark, where both already pass
(6.95:1 and 5.59:1). The reset line under it stays muted, as it was. `Banner` keeps its icon by
default and takes `icon={false}` for a notice that stands inside a container the reader is already
in: the words say the state, and the tone is the emphasis that is left.

**The geometry is the shell's.** It is inset 8px inside the 28px the composer's box is rounded by, on
a 20px radius of its own, so the two corners stay concentric; its text lands on the same 20px as the
placeholder; and it reserves room on the right for both controls, `View usage` and the dismiss, which
are told `type="button"` because they now live inside the composer's form.

**It draws only where the composer does.** A card that holds the composer's place — an approval, a
question, a session's plan waiting, a blocked or a finished session — draws no notice, where before
the notice was drawn above it. The warning is about the next message, and those cards are not a
message field; the header's Context ring and the usage sheet still answer for the account in every one
of those states.

**The two components fold into one.** `LimitBanner` is gone: `LimitNotice` was already the half that
holds the account's state and the dismissal, and the term the glossary fixes is *limit notice*, with
*limit banner* and *alert* on its `_Avoid_` list — a name the code carried anyway. The notice is still
an `Alert` (`data-slot=alert`), so the flow that finds it and the sheet's own `Banner` are untouched.

## Considered options

- **Leave it above the box.** The smallest change, and the placement ADR 0007 describes. Rejected: the
  notice is a fact about the composer and reads as an element of its own in the column, taking a row
  above the pills and the box every time the account moves.
- **Inside, flush with the box's top edge.** The plate then runs the shell's width and its corners
  belong to the shell, which reads as a header on the composer rather than a notice in it, and squares
  the corner the inset keeps.
- **Keep the icon at a smaller size.** Rejected: it was the icon that made the notice read at all on a
  10% tint, so a smaller one is decoration holding the place of a signal, and the line already names
  the state.
- **Keep the notice above the box while a card holds the composer's place.** Rejected: one notice in
  two placements, and a flow that has to drive both.

## Consequences

- The dismissal key, the balance rule and the sheet are unchanged: this ADR moves where the notice is
  drawn and what it draws, not what it decides.
- The tone is now carried by a line of text, so the two ink tokens are part of the design: a tone
  added beside them needs its own ink, measured on that tone's own plate.
- A chat whose composer is replaced by a card says nothing about the account above the card. The
  header's Context ring (where the window is wide enough for it) and the usage sheet are where that
  state is read then.
