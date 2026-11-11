# A list over a chat marks no row

A row carries one mark that says *this is the one drawn here*: the muted fill and `aria-current="page"`
a pane gives the item it has open beside the list. A bot's list drew it wherever a chat named itself —
and a chat's own control pushes the list over itself, naming the chat it covers. So the list a reader
opened from a chat showed that chat as the current row, grey and marked, for a chat they had just left
and that was not open anywhere beside the list. The list's own back control still says "Back to chat",
because that is where it goes; the row said the chat was the list's subject, which it was not.

**So only the pane marks.** A screen's list — the app's entry, or the one a chat pushed — draws every
row at rest, and nothing of it reads as current. The pane beside a chat goes on marking the row that is
genuinely open next to it, which is what the mark is for.

## Considered options

- **Keep the mark, and call it "the chat you came from".** A mark that means something other than the
  one its fill, its `aria-current` and the pane's use all say is a second meaning for one signal, and a
  reader cannot tell which they are looking at.
- **Drop `OPENED_CHAT` from the link and the row's state with it.** The state is still what tells the
  pushed list that its back leads to a chat rather than out of the app, so the control keeps its words;
  only the row's mark goes.
