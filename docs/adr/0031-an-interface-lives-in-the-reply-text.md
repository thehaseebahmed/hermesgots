# An interface lives in the reply's text

A reply that carries an interface has to survive everything a reply survives: a dropped stream, a
reload, another device, sync, an import from the host, a model that comes back tomorrow. So the
interface is not a message kind and not a stored tree. It is a fenced `openui-lang` block inside the
reply's own text, and what the thread draws is a fold over those blocks.

`media-tags.ts` already ships this shape: something the model writes inline, split out by a pure rule
before the text reaches the markdown renderer. The block rule inherits every property that made that
one work. The transcript stays the only store, so `db.ts` does not move and neither does sync or
history. The fallback is free, because the markdown renderer already draws an unknown fence as code,
so an interface that cannot be drawn is exactly the text the model sent. And a reply that arrives
half-finished is simply a block with no closing fence yet.

A reply may carry several interfaces, in the order they appear. A block whose first-line comment
names an id an earlier interface already carries is a **patch**: it changes that interface, draws in
that interface's place, and draws nothing of its own. A patch whose id is in no thread draws as code,
the same as any other block that cannot be drawn. An interface with no id can never be patched.

Because a later reply can change an earlier interface, the thread is no longer drawn row by row. A
fold over a conversation's blocks decides what each interface-bearing message draws, and a row
memoises on its resolved source rather than on its own text.

## Considered options

- **A message kind with its own Dexie table.** A `generated` role, a rendered tree per row, a schema
  version. Rejected on three counts: the tree is a rendering of a source that a later version of the
  library can draw differently, so storing it freezes an app version into the transcript; every reader
  of message content would need to learn a second shape (search, sync, merge, import, the title
  reader); and a model's own text would be split away from the block that came out of it, so a
  fallback would have nothing to show.
- **Rendering from the renderer's own message protocol.** `buildMessage` and `parseMessage` can carry
  context and content sections, which would keep the tree out of our text. Rejected because a reply is
  markdown with tools, media and thinking interleaved, and adopting the protocol would take the whole
  reply's text away from the renderer that already draws it.
- **Patches appended rather than applied in place.** Drawing the changed interface where the patch
  arrives would make the thread a record of every version. Rejected as the noisier reading on a phone:
  a three-step refinement of one card becomes four cards to scroll past.

## Consequences

- **The thread is a fold, and a row is memoised on its resolved source.** A late reply changes an
  earlier row, so the fold runs over a conversation's interface-bearing messages only, and the browser
  flow has to show that a patch arriving while the reader is scrolled up does not move their place.
- **An interface's identity is one comment line, and identity is what a patch addresses.** Reusing an
  id by accident patches rather than adds, which is the same rule working as designed; the generated
  prompt asks for a fresh id per new interface.
- **A failure is always visible as the model's own text.** Unknown component, failed validation, a
  patch naming nothing: each draws the fence as code. Nothing is swallowed and nothing is half-drawn.
- **Sync and history need no work.** A chat imported from a host, or synced from another device, draws
  the same interfaces because it carries the same text. An old app shows a block as code, which is
  what it would have shown anyway.
- **A stream that ends early leaves a block with no close.** It draws as code for the rest of the
  thread's life, and the next reply can still patch the interface it never finished.
