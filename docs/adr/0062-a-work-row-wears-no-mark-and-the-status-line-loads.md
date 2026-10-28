# A work row wears no mark and the status line loads

ADR 0061 took the spinner off every row a reply draws and gave the row's own words the movement
instead: a wave on a thought row's label, on the tool group's row while a call ran, and a typed
label on the status line under the reply. It put the wave in the right place — the words that say
what the work is doing — and it took the line under the reply one step too far, where a sentence
that types itself is a sentence the reader waits for. A status line is not a thing being written; it
is a caption to what the reply is doing, and a caption does not spell itself out.

Three further things about the same block are decided here with it, because each is a mark or a
space a reply's work rows wear, and they are only worth deciding together.

**A work row wears no mark.** The tool group drew a red X before its label when one of its calls had
failed — the only mark any work row wore, and the only prefix icon the thread had. It goes. A
failure is already said twice without it: the row's accessible name gains a word for it ("a call
failed", or how many did), and the reason stands under the label in the same red. An icon at the head
of a row says *this row is special* before it says which row; the thread reads as one passage of
work, and the row that failed reads as that passage with a line under it. `WorkRow` loses its
`before` slot with it, so no row can regain a prefix by accident.

**A failure's reason stands flush under its label.** ADR 0058 dented the reason by the icon slot so
it lined up under the words rather than under the mark. With the mark gone there is nothing to line
up past: `WORK_LABEL_DENT` goes, and the reason takes a negative top margin that eats the half of
the row's 29px box its centred label leaves under itself, so the label and its reason read one under
the other with their own line boxes as the only spacing. The row keeps its 29px.

**The status line turns a loader again, in the accent colour.** The spinner returns, on that one row
only, beside words that stand whole. The row and its loader take `--primary` — the colour this
project calls the accent and gives its own live marks. While the turn waits on the reader it is not
at work, so the row keeps its words and drops the loader, standing muted as a caption does. The wave
stays exactly where 0061 put it, on the labels of the thought row and the tool group, which is what
makes one row loading while the rest move their own words a distinction rather than an accident.

**A subagent's line is blue, wherever it lands.** The count of subagents a session has at work rides
beside the status words while the reply is live and stands alone at the thread's foot when it is
not. It is delegated work rather than the reply's own, so it takes `--info`, the app's blue — the
colour of the thread that has a moved message now — with its spinner in the same blue, so the line
never changes colour by the place it lands.

## Considered options

- **Keep the typing and lean it further** — a faster clock, fewer dots. Rejected: the reader waits
  for a sentence they could have read outright, on every label the turn passes through, and the wait
  is longest in the case the app is built for, a phone, where those words are the only signal there
  is.
- **The loader on every row again** — the state before 0061. Rejected: three rings turning inside
  one reply is the noise 0061 was right about. One row loading while the rest move their own words
  says more than three rings saying the same thing.
- **A red dot, a coloured label or a struck-through row** instead of the X. Rejected: an element that
  appears only on failure is still a mark worn by a row. The reason line and the row's own name say
  it in words, which is what a reader needs.
- **Fold the reason into the row as a second line** — one text block, one tap target. Rejected: the
  row's sheet is the list of calls, and a reason written inside the label would be part of the
  button's own name rather than read after it.
- **Leave the reason on its own line, at the dent.** Rejected: with no mark to clear, the dent hangs
  the reason 24px past the words it explains.

## Consequences

- The rules that existed only to time a typed line — `src/lib/typing.ts`, `TypedLine`, their unit and
  component tests — are deleted rather than left unused, and `scripts/test-typing.mjs`'s cases go
  with them. `test-thinking-line.tsx` asserts the line instead: whole words, a loader beside them,
  the accent colour while the turn works, and the muted line with no loader while it waits.
- `thinking-line`'s e2e leg no longer measures a held box, because there is no typing left to hold
  still: it asserts the words land whole with a loader beside them, and reports the colour the line
  works in.
- ADR 0061's wave stands; its status-line sentence does not. ADR 0058's dent sentence goes for the
  same reason its dent did.
- A reply's own word-by-word reveal (`useReveal`) is untouched: that is the reply arriving, not a
  caption re-spelling itself.
