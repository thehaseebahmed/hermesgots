# A child screen's bar is one component in two forms

A chat's top bar has been a component for a while — `ChatHeader`, drawn by the chat, a room, a
routine's run, the new room, a blank pane, a project and a canvas — while the screens a bot opens
kept their own: the chat list hand-wrote a `<header>` with a drawer control, the bot's picture, its
name as the `h1` and the routine icon, and the routines page hand-wrote another with a back control
and a Refresh. Three bars, three rows, and three answers to the same questions, so they drifted
exactly where nobody was looking: the chat's controls are frosted outline circles, while the list's
Routines link and the routines page's Refresh were bare muted glyphs.

**So one component draws every child screen's bar, in two forms.** What actually differs between the
screens is whether content scrolls under the bar: a list scrolls its own rows and needs the bar pinned
in that flow, opaque, so its first row is never covered; a thread draws under a gradient with a
floating bar, which is the app's look for a conversation. So the bar has a **pinned** form and a
**floating** one, and one row inside either: the leading control, the title, the line under it, the
actions, and a slot under the row for what a screen pins with it — the routines page's four state
chips. Every icon control on it wears the **frosted outline circle**, which is the look the chat's
back and `…` already had.

**Consistency is bought in the row, not in the type.** The pinned form's title stays the screen's
`h1` at the list's step, and the floating form's stays the small label a conversation wears, because a
list's whole content is named by its bar while a thread's is named by the thread. The bar is the same
bar — slots, order, control, 44px — and the heading is the screen's own.

**What it supersedes.** The hand-written headers in `routes/bot-chats.tsx` and `routes/routines.tsx`,
and the sentence in [ADR 0139](0139-a-bots-routines-are-its-own-screen.md) that the routines page's bar
is "the chat list's bar, control for control": the two are now the same component rather than two
copies kept in step by hand.

## Considered options

- **One surface for both.** A single arrangement would cost the list its sticky place or the chat its
  gradient, and the gradient is the app's look for a conversation.
- **Three headers aligned by hand.** That is what drifted in the first place; the next change to the row
  would land in two places or not at all.
- **Shrinking a thread's title to a list's step, or growing a list's to a thread's.** A heading's size is
  about what names the screen, not about which bar draws it.
- **A slot for anything a screen likes.** One slot, used by the chips the routines page pins; a second
  caller decides what a second slot is for.

## Consequences

- A change to the bar's row lands on seven screens at once. `pnpm e2e screens`, `panes` and `canvas` are
  what catch a bar that moved on a screen the change did not mean to touch.
- The chat list's band no longer needs the two header-height variables it set by hand, since it draws no
  sticky heading to read them.
- A reader comparing a list's heading with a chat's label sees two sizes. That is the screens' decision,
  not the bar's, and the next person to touch this should read it as such.
- The bar keeps its name and its path (`components/chat/chat-header.tsx`, `ChatHeader`): it is the app's
  bar now, but a rename across ten imports buys a name rather than behaviour, and can wait for a change
  that touches those files anyway.
