# An app is a record of pages, and a page's source is replaced whole

**Superseded by [ADR 0113](0113-a-canvas-is-its-bots-record-edited-only-through-its-own-session.md)** (2026-11-07): Apps are replaced by canvases (#920).

An app is not one document. A Home Assistant dashboard is a home page, a room, an energy trend; a
GTD app is what is due, what is next. One `openui-lang` document per app would either grow past what
a model can rewrite reliably or force every change through a small patch syntax the language does not
have to spare.

So an app is a record of **pages**, each page one `openui-lang` source with its own `# id:`, and one
page is the **root** the app opens on. That keeps the document small enough to be replaced whole,
which is the rule that matters: a change replaces one page's entire source and never merges.

The merge was the obvious alternative, because a chat already has it. But the patch this repo folds
is `mergeStatements` by *statement name*, not by interface id — a change that omits a card leaves
that card standing. Removal would need syntax the model must be taught, and a wrong merge is a
dashboard that keeps a light nobody wants. Whole-document replacement makes removal free: you do not
write the card. It also means a change is always reviewable as a diff of one page, and a page the
model mangles cannot half-land, because the answer either parses as one source or it is not written.

An app's identity is the record's, and the `# id:` line carries the page's, so a saved document is
self-describing — which is the property an export, or a share two devices exchange, would need
later.

## Considered options

- **One document per app, merged by patch.** The chat's own shape, and cheapest for a large app. Not
  taken: removal becomes a new syntax, and a stale statement survives a patch silently.
- **One document per app, replaced whole.** Simple, and refused for a different reason — a dashboard
  with six views is one source large enough that every small edit pays for all of it, and a model
  rewriting a long source drifts.
- **A rendered tree stored per page.** Rejected for the reason ADR 0031 gives about the reply: a
  stored tree freezes a version of the component library into the record.
- **Pages as a document tree with a layout of its own.** A page container that positions child
  documents. Rejected as a second rendering language beside the one the library already is.

## Consequences

- **A change touches exactly one page,** and a build may return several at once — a build is the
  only run that creates more than one.
- **A chat reply cannot change a saved app.** An interface's id namespace is its thread's; an app is
  changed on its own surface, in its own prompt. A stray reused id must not rewrite a dashboard.
- **Identity is re-decided here, not inherited.** The fold that resolves a thread's patches is
  defined over one conversation's blocks, so an app — a second transcript — decides its own identity
  rule, and this record is it.
- **The scope line it moves.** The spec that introduced interfaces in the chat says "no second chat
  shell, no new screen, no new storage". A saved app on a screen of its own supersedes that sentence,
  which its own spec amends in one line; no ADR is reversed to get there, because that line was a
  scope note for one feature rather than a rule about generated surfaces.
