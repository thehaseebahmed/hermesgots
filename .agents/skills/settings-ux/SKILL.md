---
name: settings-ux
description: Use when designing or reviewing a settings screen in Gots — a bot's settings, a Settings section, or any card-and-row surface — to keep the Samsung One UI pattern the app adopted: a value shows and the edit drills in. Carries the rules, the control-to-presentation table, the Material/Android evidence behind them, and the review checklist.
category: design
---

# Settings UX

A settings screen in Gots does not edit in place. It shows what a value is and sends the edit
somewhere else — a pushed screen on a phone, a centred card on a large one. The rules come from
Samsung One UI's settings screens (the app's own reference), checked against Material 3 and
Android's settings pattern; `docs/adr/0055-settings-show-a-value-and-the-edit-drills-in.md` is the
decision and `AGENTS.md`'s **Settings UX** section is the short form every agent reads first.

Read this before drawing a settings screen, and again before calling one done.

## The rules

1. **A card never holds a text box, a picker or a stepper.** It holds rows; a row shows the value.
2. **A row is a title over the value it holds, in the accent colour** — *Not set*, muted, where it
   holds nothing. The value is a line of its own, not a trailing slot: model ids and URLs don't fit
   a trailing slot, and truncating the answer is worse than giving it a line.
3. **A subtitle says what the setting is for only where the row drills in, or where the purpose
   isn't obvious.** This is the exception to **No explanatory copy**, and it stays one line. Android
   says it plainly: show the status instead of describing the setting, and put a longer explanation
   on the destination screen. A subtitle on every row is what makes a settings screen read as prose.
4. **No chevrons.** The value and the press state mark a row tappable; the reference screens carry
   no disclosure indicators and the app follows them.
5. **Captions are short and muted, and only where they disambiguate.** The bot-settings pages caption
   their ownership cards *Gots* and *Hermes*, and General's profile card *Bot Profile*; the list
   itself carries none, and a page whose cards need no disambiguation carries none either. Cards are
   separated by gaps — grouping is spacing first, a caption second.
6. **One breakpoint: 1024px.** It is where panes split, pop-ups turn into drawers and these screens
   change shape. Material's expansion point is 840dp; the gap is recorded in ADR 0055 as a later,
   app-wide change, never a per-screen one.

## Where a control sends you

| Control | Below 1024px | From 1024px |
| --- | --- | --- |
| A text value (name, address, key) | pushed screen: labelled input, Cancel and Save | centred dialog card: the same form |
| A list that is picked from (models, avatars) | bottom sheet: search, radio rows | centred dialog card: search, radio rows |
| A list that is only read (vocabulary, fallbacks, a server's detail) | pushed screen | the page pane swaps to it, the list stays |
| A switch, a stepper, a button | in place | in place |
| Yes-or-no confirmation | `AlertDialog` | `AlertDialog` |

Save is explicit: the edit holds its value, Cancel discards it and Save writes it once. Switches and
steppers are not part of that form — they are instant and stay out of anything with a Save button.

## Why (the evidence)

- **Lists** (m3.material.io/components/lists): a list is container, label, supporting text and a
  trailing slot; there is no section-header element. Grouping is spacing and containment.
- **Settings pattern** (developer.android.com/design/ui/mobile/guides/patterns/settings): contain
  groups *and* head them; show the setting's status, not a description of it; present a single choice
  in a dialog or a child screen; a setting with a dependency is gated by its parent.
- **Dialogs** (m3.material.io/components/dialogs): a full-screen dialog is for form fields and only
  at compact widths; from the expanded breakpoint a basic dialog is the answer, centred, and it holds
  at most two actions — which is why Test connection never sits inside a Save/Cancel form.
- **Bottom sheets** (m3.material.io/components/bottom-sheets): modal sheets are a mobile pattern;
  on a large screen a sheet gives way to a side sheet, which is for content, not for choosing.
- **Menus** (m3.material.io/components/menus): a list of choices is a menu with an optional filter,
  adapted to a bottom sheet on small screens — the shape the pick card takes.
- **Apple HIG** (lists and tables): the grouped style is built from headers and footers; a disclosure
  indicator reveals the next level. Where the app departs from it, it is deliberate (rule 4).
- **NN/g** (toggle switches): a switch takes effect immediately and never sits in a form that needs
  Save.

## Reviewing one

- Does any card hold an input, a select or a stepper? → it must not.
- Does every row show its value, or a muted *Not set*?
- Is every subtitle earning its line — the row drills in, or the purpose is genuinely not obvious?
- Are captions present only where two cards would otherwise be indistinguishable, and short?
- Is the drill-in target right for the control (table above), at 390px and at 1024px?
- Does an edit discard on Cancel and write once on Save, with no third action in the card?
- Is the destructive action where the spec puts it, rather than in a new overflow menu?
- Do the switches and steppers still act in place, without a Save anywhere near them?

## Pitfalls

- **Subtitle inflation** — the spec's "every row says what it is for" was the last design's rule; it
  was narrowed on purpose. A row whose value says it all needs no second sentence.
- **A second breakpoint** — adding an 840px split here makes the screen change shape at three widths
  while panes change at one.
- **Dialogs growing actions** — a Test, a Reset or a Disable inside an edit card breaks the
  two-action rule; those belong on the row or the page behind it.
- **Captions creeping back onto the list** — the list is the one surface that stays caption-free.
