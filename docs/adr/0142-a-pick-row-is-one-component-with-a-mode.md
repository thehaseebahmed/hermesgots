# A pick row is one component with a mode

The app draws a list you pick from in a sheet, a drawer or a popover in eight places — the model
picker, a bot's picture and every other settings pick, the composer's `+` › Mode and Tools, the
Prompt library, the `/` menu, and the pull requests in the Outputs drawer and on a project's tab —
and every one of them was written by hand. They had drifted the way hand-written rows do: two
heights (44 and 56), two chosen fills (`bg-muted` on a bare list, `bg-background` on the grey plate),
three shells for the group (`ModelList`, `ModeOptions`' div and attach-menu's) and four different
ideas of what a row's state is (a keyboard cursor, `aria-pressed`, `role="radio"`, and a tick with no
role at all). Two of the eight carried props no caller passed: `SheetPickerRow`'s `chosen` and
`saving`, and `SkillRow`'s `checked`, which only the dead skill sheet ever set.

**So there is one `PickRow` and one `PickGroup`.** A row is an `<li>` holding one button and, where
the caller has an action of its own, one button beside it — never inside it, since a button inside a
button cannot be pressed by a screen reader, and the Prompt row's pencil was one wrapper away from
that. A row draws its mark in a fixed 32px column, its name, one muted line under it, and the state
its mode promises: a tick on the row that is chosen, a chevron on the row that goes somewhere, a
grey fill on the row the keyboard is walking.

**The mode is a fact about the list, so the group carries it.** A row is not a radio outside a
radiogroup, and a row that carried its own mode could put `role="option"` inside one. There are
four: `choose` (one of several — `role="radio"` and `aria-checked`), `toggle` (each on its own —
`aria-pressed`), `open` (a way out — no state, a chevron) and `option` (a cursor to run — `role="option"`
with `aria-selected` following it). The `/` menu is the fourth: it neither chooses nor opens, its only
state is the cursor the field's `aria-activedescendant` points at, and the three modes would have
made a screen reader hear a radio for every command in it. A row with no group is an `open` row.

**The chosen fill comes from the surface, because only one of them has a track.** A chosen row on
the grey plate fills `bg-background` (a `bg-muted` fill would be invisible on it), and a chosen row
on the popover fills `bg-muted`. `PickGroup` takes `surface`, which is how the Outputs drawer, the
Prompt sheet and `PickList` keep the bare look they had — one row, not one backdrop.

**44px is the floor, not a height.** A row with a muted second line is taller than its padding, so
the Prompt's preview, a model's facts and the Tools row stand around 56; a row with one line is 44.
The `PROVIDER_ROW` constant that made a provider row 56 for opening another list is gone: a row is
as tall as what it says, not as tall as what pressing it does.

## Considered options

- **One component per state.** A `PickRadio`, a `PickToggle`, a `PickLink`. That is the same anatomy
  written four times, which is the fault this fixes; the state is four attributes, not four rows.
- **A `role` prop instead of a mode.** The `/` menu's listbox would have been described by a second
  prop beside the group's mode, and the two could disagree about one list.
- **The mode on the row.** Simpler to pass, and wrong: a row could then be an option in a radiogroup.
- **One plate everywhere.** It reads as one consistent list, and it repaints three surfaces that had
  no plate — the drawer, the Prompt sheet and every settings pick — for a rule about nesting.
- **A `size` prop, or a 56px form for a list that is not in a pop-up.** Nothing needs one yet; the
  first caller that does can ask.

## Consequences

- Nine component tests and five browser flows named those rows by `role="button"`, `aria-pressed` or
  `[data-pick-list] > button`; each one's selector changed with the row.
- What a screen reader hears changed on three surfaces: the model pick and the settings picks are
  now radios ("radio, 3 of 200" in the model picker's providers), where the model pick said
  "pressed". That is the cost of one row; the picker's groups are the one place to revisit, and no
  row changes to do it.
- The Outputs drawer's PR rows and `PickList`'s avatar rows got shorter, and their marks went from
  44px to 32. Visible on a phone before anywhere else.
- Two components and a kit are gone: `sheet-picker.tsx`, `skill-row.tsx`, and `chat/skill-sheet.tsx`
  (dead since the AFK workflow went, ADR 0110).
