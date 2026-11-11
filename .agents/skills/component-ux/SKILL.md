---
name: component-ux
description: Use when adding, moving or reviewing any surface in Gots — names the one component each surface is drawn with (bar, row, group, card, sheet, dialog, menu, pill, notice, loader, empty state, field) and when and where it shows, then audits a diff, a file, a feature or the whole app for deviations and settles each as a fix, a rule or an exception.
category: design
---

# Component UX

`DESIGN.md` says what the app looks like — tokens, surfaces, type, measures, shapes. This skill says
**what draws each surface**, **when it shows and where**, and **how to tell a deviation from a
decision**. `settings-ux` is the deep dive on one family (the settings screen); this is the map the
rest of the app is drawn from.

Read it before drawing a surface that already exists somewhere else. Read it again before calling a
screen done — the review checklist is at the end.

## The rule

**A surface is drawn by the component this file names for it, and a diff that draws it by hand is a
deviation.** The app has one bar, one row system per context, one overlay, one search field, one
spinner, one destructive confirmation. When a surface genuinely has no component, the work is to add
the component and a row to the table below — not to write a seventh private copy.

Three counts from the whole app, which is why this matters: 156 component files, 30 of them shadcn
primitives, and 16 hand-written copies of the page column. `references/inventory.md` is every
component with its importers; `references/deviations.md` is what is currently off the table.

## When and where

| Surface | Component | It shows |
| --- | --- | --- |
| A screen's top bar | `ChatHeader` (`pinned` form) | Every child screen: a chat, a room, a routine's run, a blank pane, a project, a canvas, a bot's list, a bot's routines. `pinned` for a screen that scrolls rows under it, floating (default) for a thread. ADR 0140 |
| A screen's column and its header | `Screen` (`settings-chrome`) | A settings-shaped screen: sticky header over one centred column of groups. Its title slot is for a page that is a row's detail |
| A row in a list of things | `ItemRow` | Projects, Code, Meetings, Research, a bot's chats, the Canvas list. Icon disc, title, age, one status line, unread dot |
| A row in a settings-shaped screen | `RowText` / `LinkRow` / `SwitchRow` / `ValueRow` | A value shows, the edit drills in (`settings-ux`). Never an input inside the row |
| A row a pop-up offers | `PickRow` in a `PickGroup` | A model, a bot, a mode, a Prompt, a skill in `/`, a pull request, a setting's value. 44px at its shortest, a tick or a chevron by the group's `mode` (ADR 0142) |
| A group of rows | `Group` | Settings and skills. One 24px card, rows square inside it, hairline showing between |
| A card that is a feature's own surface | `Card` (`ui/card`) | A Routines job, a bot gallery card, an account panel. Flat `bg-card`, one hairline ring |
| A card inside a thread | `CARD_BASE` / `CARD` / `FLAT_CARD` (`chat/session-cards.tsx`) | A question, an approval, a plan, a resolved card. `CARD` floats in the composer slot, `FLAT_CARD` sits in the thread |
| Anything opened over the page | `Popup` | A pick, a detail, a form, a list. Bottom sheet below 1024px, side drawer from it, menu when `anchor` is a button. ADR 0141's foot is the one exception |
| A yes-or-no question | `ConfirmDestructive` | A delete, a remove, a discard. Centred `AlertDialog` at every width, two actions, never a sheet; it owns the write, so a refusal stays on screen |
| A full-screen takeover | `FullscreenPopup` | The Previewer and the meeting recorder. Nothing else |
| A quiet choice from a button | `Popup anchor` (menu) | The composer's `+`, a model field, a project pick. Never a sheet for a two-row pick |
| A notice inside a screen or sheet | `Banner` | Above what it is about. Tone plus words; no icon where the room is tight |
| The app talking about the thread | `SystemLine` | A room's system row, a progress reminder. Not for a reply's state |
| What a reply is doing | `StatusLine` + `WorkRow` | Inside the thread, under the reply's work. Never in the header (ADR 0070, 0076) |
| The result of the user's action | `toast` (sonner) | After a write: saved, failed, copied. Never for a state the screen already shows |
| A list with nothing in it | *(none yet — `EmptyState` is the extraction)* | One icon disc, one sentence saying what would fill it, one action where the screen can make one. Three copies exist today; the fourth is the deviation |
| A shape about to fill | `Skeleton` | A row, a card, an image cell while its read is out |
| Something running | `Spinner` | Beside the words it belongs to, 16px. Never a private ring |
| A field of search | `SearchField` (`components/search-field.tsx`) | Every search: a list's bar, a sheet's list, a picker, a form |
| A pill that filters | `Chip` + `ChipRow` | A row of alternatives, 44px, pressed state |
| A pill that reports | `Badge`, `RepoChips` | Read-only metadata: a category, a repo and its branch. Never pressable |
| A pill above the composer | `PILL` (`chat/pill.ts`) | Todos, outputs, a pull request. One row, one height |
| An action | `Button` | `primary` once per screen; everything else secondary, ghost or a row |

## The families, and the rule each one holds

1. **One bar.** `ChatHeader` has the pinned and floating forms, the leading control, the title, a
   `below` slot and 44px icon circles. A screen that writes `<header className="sticky top-0 …">`
   has forked the bar. ADR 0140 settled this after three copies drifted in opposite directions.
2. **One row system per context, and none written by hand.** A *list* row is `ItemRow`; a *settings*
   row is the `settings-chrome` kit; a row *a pop-up offers* is `PickRow` in a `PickGroup`. They are
   different on purpose: a list row carries a mark, an age and a status line; a settings row carries
   a title over its value; a pick row carries the one state its mode promises. A screen picks one and
   stops. A row whose title is a bare `<span>` in a flex is a row that will drift.
3. **Cards: three kinds, no fourth.** A feature card (`Card`), a thread card (`CARD_BASE`), or a
   group (`Group`). `rounded-3xl border bg-card` typed by hand is the fourth kind and is the
   deviation. Nested surfaces step down the radius they sit in, never up.
4. **One overlay.** `Popup` decides sheet, drawer or menu from the width and the anchor. A bare
   `Sheet`, `Dialog` or `Drawer` is a bug unless the surface is a confirmation (`AlertDialog`) or a
   full-screen takeover. Pop-ups are push, not edit-in-place.
5. **One question.** A destructive confirmation is `ConfirmDestructive`: `AlertDialog`, `size="sm"`,
   Cancel plus the one destructive action, and it owns the write — a promise that rejects keeps it
   open with the host's words (`staysOpen` where the caller tracks the answer itself). The six
   dialogs that are not yes-or-no questions (a rename form, a
   three-way exit, a permission question, a reminder, a one-action notice, the recorder's stop) keep
   their own, and say why in their file.
6. **Notices have three homes and they are not interchangeable.** `Banner` is a state of the screen;
   `SystemLine` is the app speaking about the thread; `toast` is the answer to an action. A failure
   the screen can keep showing belongs in a banner or a row, not in a toast that disappears.
7. **Loading keeps the shape.** `Skeleton` where the content will land, `Spinner` beside words that
   are already there. Motion means work is happening — so a still row that spins is wrong, and a
   loader that appears without words is a loader nobody can name.
8. **Empty says what would fill it.** One sentence, muted, in the app's voice. No illustration, no
   paragraph about why the screen exists. Three screens already draw the same disc-and-sentence by
   hand (Projects, Meetings, Code): the next one extracts `EmptyState` rather than copying it.
9. **One search field.** `SearchField` handles the 44px target, the clear button, the label and the
   browser's own clear. A new input with a `SearchIcon` beside it is the duplicate, and no picker,
   sheet or form draws its own.
10. **The numbers are not per-screen.** 44px for anything tappable, 56px for a row, 640/672 for the
    reading column and the card box, 16px typed text, one breakpoint at 1024px. A screen that wants
    its own is asking for an app-wide change (ADR 0055), not a local one.
11. **One accent per screen.** `primary` marks the one thing to press. A second primary pill is a
    screen that has not decided what it is for.
12. **A surface is named by what it is, not where it was first used.** A component that grew in one
    feature and now has a second caller moves to `components/` with a doc comment saying when it
    shows and where — `item-list.tsx` and `pick-row.tsx` are that move done. `PrRow`, in
    `components/pr-row.tsx`, is a twelve-line caller of `PickRow`: the disc, the state word and its
    colour are the part worth not copying.

## Settling a deviation

Every finding gets exactly one of three verdicts, and the verdict is a decision, not a mood.

- **Fit it.** The table already covers it and the code drifted. Change the code, name the ADR or the
  row of the table it now follows. This is the default, and the only verdict a new surface can have
  before someone has agreed to the other two.
- **Make it a rule.** The new shape is right, and it is right for *more than one surface*. Write the
  rule here (and, if it changes the look, a row in `DESIGN.md`), then make the existing callers
  follow it. A rule that only one caller could ever satisfy is an exception wearing a rule's words.
- **Make it an exception.** One surface, deliberate, and it earns the deviation. Record it in
  `references/deviations.md` with the surface, the reason and the ADR that decided it — the list
  foot's pills (ADR 0141) and the 29px work rows (ADR 0058) are the shape of a good exception: a
  place, a reason, a decision. An exception with no ADR is a fix that has not happened yet.

Never leave a finding as "noted". A finding that is neither fixed nor written down comes back in the
next review with less context than it has now.

## Auditing

The mechanical half is a script; the judgement half is this file.

```bash
node .agents/skills/component-ux/scripts/audit.mjs                 # the whole app
node .agents/skills/component-ux/scripts/audit.mjs src/routes      # a directory
node .agents/skills/component-ux/scripts/audit.mjs <diff-files>    # a diff: the files it touched
node .agents/skills/component-ux/scripts/audit.mjs --strict        # exit 1 on any finding
```

It reports the shapes that mean a primitive was skipped — a hand-written bar, page column, chip
strip, search field, spinner, empty state, ad-hoc card, a confirmation drawn by hand, a component with no
importer — each with the rule it breaks and the component it should have been. It cannot see intent,
so every finding is read, then settled:

1. **A diff.** `git diff --name-only <base>` into the script. Only the files the change touched.
2. **A file or feature.** Pass its path. Read the file's doc comment first: most components say when
   they show, and a copy that contradicts its own comment is the clearest finding there is.
3. **The whole app.** Before a release or after a big merge. Output that survives review goes to
   `references/deviations.md` with a verdict; nothing else is kept.
4. **A design change.** Read `DESIGN.md`, the ADR that decided it, then this table, then the
   inventory. If the change adds a surface, it adds a row here in the same commit.

## Reviewing a surface

- Which component from the table draws it? If the answer is "a new one", is the new one in the
  table, and does more than one surface need it?
- Is the bar `ChatHeader`, or a `<header>` that was pasted?
- Is every row a row of its context (`ItemRow`, the settings kit, or `PickRow`), or a hand-flexed
  title?
- Is a pick in a `PickGroup` whose `mode` says what its rows are, at 44px or taller, with its action
  as a sibling of the pick button?
- Is every search `SearchField`, every bar `ChatHeader` pinned, every destructive question
  `ConfirmDestructive`?
- Is the card one of the three kinds, and is a nested surface's radius smaller than its parent's?
- Is the overlay `Popup` — sheet below 1024px, drawer or menu from it — with a `PopupHeader`?
- Is the question `AlertDialog` with two actions, Cancel first?
- Is a failure shown where it happened, and a success a toast?
- Does anything still turn or pulse when nothing is running?
- Is the empty state one sentence and one action, in the app's voice?
- Are 44px, 56px, 640/672, 16px and 1024px untouched by this screen?
- Does the diff add a component with one caller, and does it say why it is not in `components/`?

## Pitfalls

- **A new component per screen.** The bar was three copies before ADR 0140; the page column is 16
  today. Copy first, extract later is how that happens.
- **`rounded-2xl` versus `rounded-3xl`.** `ui/card` ships 16px (2xl) and `Group` is 24px (3xl).
  Passing `className="rounded-3xl"` to `Card` to match a group is a rule waiting to be written;
  mixing them on one screen is a deviation now.
- **A settings row in a list, or the reverse.** `ItemRow` in a settings page loses the value line
  the page exists for; `ValueRow` in a list loses the mark the list scans by.
- **A toast for a read failure.** A screen that can keep saying "couldn't read this" says it in
  place; a toast is gone in three seconds and the screen looks empty, not failed.
- **An exception registry that only grows.** Re-read it when the surface it excuses is next touched;
  the 29px work row is deliberate, a spinner somebody forgot is not.
- **44px mistaken for a height.** A pick row with a muted line is ~56; 44 is the floor. A `size` prop
  or a fixed height brings back the two heights this replaced.
- **Folding the dialogs that are not yes-or-no.** A rename form, a three-way exit, a permission
  question, a reminder and a one-action notice look like a confirmation and are not: folding them
  needs a prop that means "this one is different", which is the row-per-screen fault again.
- **Reading the script's output as the review.** It finds shapes. Whether the shape is right is the
  table, the ADR and the three verdicts above.
