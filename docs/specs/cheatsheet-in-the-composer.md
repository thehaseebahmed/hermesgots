# A Cheatsheet of Gots's key shortcuts opens from the composer

Status: grilled 2026-10-24, every decision settled and recorded in ADR 0042. Published as #514 with
tickets #515, #516; the build order at the end is the tickets' shape when implementation starts.
#514 is blocked by the gate issue that the docs PR carrying this file closes — work starts on that
merge. The spec carries `ready-for-agent` and the tickets stay bare, so the agent claims the spec
and works the graph in order.

## Goal

`/cheatsheet` joins the composer's slash menu and opens the Cheatsheet: every key a hardware
keyboard can send in Gots, and what each does, in one sheet. Today the app answers a dozen bindings
— Enter sends, double Escape clears, Ctrl+C stops a reply, Alt+1…9 switches bots — and names none of
them anywhere; the slash menu teaches what can be typed, never what can be pressed. The sheet lists
keys only, and only keys that are switched on.

## What this is not

- **Not the slash menu's list.** Commands and the bot's skills stay where they are; the Cheatsheet
  lists keys, and putting commands on it too would give the two surfaces a drift to maintain.
- **Not host keybindings.** Nothing is editable, nothing is read from the host, and the host
  desktop app's bare `?` drawer and Cmd/Ctrl+/ panel are not mirrored — a bare-`?` trigger would
  hijack a lone question mark.
- **Not a keybinding registry.** The handlers stay where they are; the list is written by hand
  beside them (ADR 0042).
- **Not platform glyphs.** Ctrl and Alt are spelled as the handlers take them — the bindings are
  already platform-exact — so no detection is written.
- **Not explanatory copy.** Rows say what a key does in the app's words; there is no paragraph
  teaching keyboards.
- **Not the implementation.** This spec, its ADR and its glossary entry are what ships first; the
  build is the two tickets below, once the pull request carrying this file merges.

## Decisions

1. **`/cheatsheet` is a Command.** A row in the slash menu, intercepted before send like every
   command; picking it clears the composer and nothing reaches the agent (the glossary's Command,
   and ADR 0037's transport: no slash parsing exists on the run route).
2. **Keys only, in five groups.** Composer — Enter sends, Shift+Enter new line, double Escape
   clears the message keeping attachments. Slash menu — up/down move, Enter or Tab pick, Escape
   closes it. Chat — Ctrl+C stops a running reply. Navigation — Alt+1…9. While something's open —
   left/right arrows step the attachment viewer, Escape cancels a recording. Browser-standard
   Enters in forms are deliberately out.
3. **The list is hand-written and import-free** — one module taking the navigation-shortcuts flag
   as an argument, with its own unit tier. No registry, no drift-guard string test; drift with a
   handler is fixed where it is found (ADR 0042).
4. **The Alt+1…9 row obeys its switch.** The switch defaults off, so the Navigation group is
   absent rather than lying; the sheet reads the setting once on open and writes nothing.
5. **The slash row is the only way in.** No hotkey, no permanent button: `?` and Cmd/Ctrl+/ belong
   to the host's desktop app, and a bare-`?` trigger hijacks a lone question mark.
6. **The sheet is the app's pop-up convention whole.** An unanchored Popup, a pinned titled header,
   one scroll region (ADR 0035), size md, a bottom sheet below 1024px and a drawer from there,
   dismissed by swipe, scrim, Escape and Android's back. Rows are a key chip beside its
   description, under group headings.
7. **Ctrl and Alt as written.** The stop binding rejects the meta key and the bot switcher reads
   only Alt, so what the sheet says is what the app does on every device — no Cmd-vs-Ctrl branch.
8. **The vocabulary lands with the code.** The glossary gains **Cheatsheet**, and **Command**
   enumerates it; ADR 0042 records why none of the alternatives won.
9. **Two tiers, no flow.** The rule is unit-tested and the sheet component-tested; sheet geometry
   belongs to the pop-up every sheet already draws through, so no browser flow and no audit row
   (ADR 0019).

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/lib/cheatsheet.ts` | The import-free list: groups, rows, the flag gate — new |
| `app/scripts/test-cheatsheet.mjs` | Its unit tier — new |
| `app/src/components/chat/cheatsheet.tsx` | The sheet: popup, header, groups, rows — new |
| `app/scripts/test-cheatsheet-sheet.tsx` | The component tier: the pick opens the sheet — new |
| `app/src/lib/slash.ts` | The local-command union and the command's place in it |
| `app/src/components/chat/slash-menu.tsx` | The row's icon in the command icon map |
| `app/src/routes/chat.tsx` | The command branch that opens the sheet — its fall-through opens Settings |
| `AGENTS.md` | Layout rows for the two new files, in their own commits |
| `docs/adr/0042-the-cheatsheet-is-a-hand-written-list-opened-from-the-slash-row.md` | The decision |
| `GLOSSARY.md` | **Cheatsheet** recorded, **Command** widened |

## Edges

- **Typed with text after it** — `/cheatsheet anything` matches no local command (only carrying
  commands take text), so it goes to the host as a message, exactly like `/settings anything`
  today.
- **Sent while a reply runs** — the Cheatsheet is not a send command; steer and queue offer
  themselves beside it, and the sheet opens regardless of the stream.
- **A question or approval in the composer's place** — no composer, no slash menu, no way in; the
  sheet is unreachable exactly where the composer is.
- **Escape while the sheet is open** — the pop-up takes it and closes; the composer's double-Escape
  clear belongs to the composer's own field, which does not hold focus under the sheet.
- **Android's back** — closes the sheet through the pop-up, never the screen.
- **The switch flipped while the sheet is open** — the sheet read once on open; reopening is the
  honest state. No live binding, by decision.
- **A phone with no keyboard at all** — the sheet still lists what a hardware keyboard would send;
  it teaches rather than controls, and nothing on screen depends on it.
- **Two sheets stacked** — the Cheatsheet opens over the composer, not over another pop-up, so the
  pop-up stack's own rule carries it.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Unit** — the import-free list: groups, the curated rows, the flag gate (off hides Navigation,
  on shows it) and the row shape. Prior art: the pure rules the repo already drives with node's
  test runner.
- **Component** — the sheet over a seeded device database with the HTTP faked: the slash pick
  opens it with its rows, and the Navigation group is absent with the switch off. Driving the real
  pick path is what fails when the command branch is missed — the branch whose fall-through opens
  Settings. Prior art: the pipeline sheet's component test.
- **No flow** — geometry is the pop-up's, owned by the sheet every pop-up already draws; no
  registry row, no audit row.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. No schema bump, no plugin
version, no flows to run.

## Build order

1. #515 — feat(chat): open the Cheatsheet from the slash menu with its composer, slash-menu and reply keys. Edge: none.
2. #516 — feat(chat): gate the Cheatsheet's navigation row and add the keys an open viewer or recording answers. Edge: 1.

## Risks

- **The list drifting from a handler** is the accepted cost of having no registry (ADR 0042): a
  changed binding with an unchanged row. The unit test pins the list, not the handlers, so review
  is where the pair gets read together.
- **A missed command branch opens Settings** instead of the sheet — the switch's fall-through. The
  component test drives the real pick, so a miss fails there rather than in a demo.
- **The gated row forgotten** would advertise a dead key by default; the flag gate's unit case is
  written for exactly that.
- **An unanchored pop-up rendering as an anchored menu** would be the wrong surface on desktop; the
  sheet takes no anchor, as the skill sheet beside it does not.
