---
version: alpha
name: Gots
description: The app's surfaces, tone inks, type, measures and shapes, as CSS tokens.
colors:
  background: "oklch(1 0 0)"
  foreground: "oklch(0.145 0 0)"
  card: "oklch(1 0 0)"
  card-foreground: "oklch(0.145 0 0)"
  popover: "oklch(1 0 0)"
  popover-foreground: "oklch(0.145 0 0)"
  primary: "oklch(0.527 0.154 150.069)"
  primary-foreground: "oklch(0.982 0.018 155.826)"
  secondary: "oklch(0.967 0.001 286.375)"
  secondary-foreground: "oklch(0.21 0.006 285.885)"
  muted: "oklch(0.97 0 0)"
  muted-foreground: "oklch(0.556 0 0)"
  accent: "oklch(0.97 0 0)"
  accent-foreground: "oklch(0.205 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
  destructive-ink: "oklch(0.52 0.22 27)"
  border: "oklch(0.922 0 0)"
  input: "oklch(0.922 0 0)"
  ring: "oklch(0.708 0 0)"
  warning: "oklch(0.7 0.17 55)"
  warning-ink: "oklch(0.52 0.15 55)"
  success: "oklch(0.65 0.17 152)"
  info: "oklch(0.55 0.17 255)"
  merged: "oklch(0.55 0.2 300)"
  usage-input: "oklch(0.6 0.17 255)"
  usage-output: "oklch(0.64 0.19 40)"
  usage-cache-write: "oklch(0.62 0.14 165)"
  usage-cache-read: "oklch(0.7 0.15 75)"
  syntax-keyword: "oklch(0.55 0.2 15)"
  syntax-string: "oklch(0.5 0.13 150)"
  syntax-number: "oklch(0.5 0.15 250)"
  syntax-title: "oklch(0.5 0.17 300)"
  syntax-attr: "oklch(0.55 0.13 60)"
  syntax-comment: "oklch(0.556 0 0)"
  chart-1: "oklch(0.55 0.15 150)"
  chart-2: "oklch(0.62 0.16 55)"
  chart-3: "oklch(0.52 0.14 255)"
  chart-4: "oklch(0.58 0.16 310)"
  chart-5: "oklch(0.62 0.12 195)"
typography:
  headline-lg:
    fontFamily: Figtree Variable
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  headline-md:
    fontFamily: Figtree Variable
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  title-md:
    fontFamily: Figtree Variable
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.3
  body-lg:
    fontFamily: Figtree Variable
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  body-md:
    fontFamily: Figtree Variable
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.625
  body-sm:
    fontFamily: Figtree Variable
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: Figtree Variable
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
  label-sm:
    fontFamily: Figtree Variable
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.33
  code:
    fontFamily: JetBrains Mono Variable
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.625
rounded:
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  2xl: 16px
  3xl: 24px
  sheet: 28px
  full: 9999px
spacing:
  base: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  gutter: 16px
  column: 640px
  column-box: 672px
  touch: 44px
  row: 56px
  field: 48px
  phone: 390px
  tablet: 768px
  breakpoint: 1024px
components:
  screen:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-lg}"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.3xl}"
    padding: "{spacing.md}"
  group:
    backgroundColor: "{colors.border}"
    rounded: "{rounded.3xl}"
  separator:
    backgroundColor: "{colors.border}"
    height: 1px
  row:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    typography: "{typography.body-lg}"
    height: "{spacing.row}"
    padding: "{spacing.md}"
  row-current:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    typography: "{typography.body-lg}"
    height: "{spacing.row}"
    padding: "{spacing.md}"
  caption:
    backgroundColor: "{colors.card}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.body-sm}"
  sheet:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.popover-foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sheet}"
    padding: "{spacing.md}"
  menu:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.popover-foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.2xl}"
    padding: "{spacing.sm}"
  field:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.full}"
    height: "{spacing.field}"
    padding: "{spacing.md}"
  field-edge:
    backgroundColor: "{colors.input}"
    height: 1px
  focus-ring:
    backgroundColor: "{colors.ring}"
    height: 3px
    rounded: "{rounded.full}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    height: "{spacing.touch}"
    padding: "{spacing.md}"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    height: "{spacing.touch}"
    padding: "{spacing.md}"
  button-destructive:
    backgroundColor: "{colors.card}"
    textColor: "{colors.destructive}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    height: "{spacing.touch}"
    padding: "{spacing.md}"
  warning-plate:
    backgroundColor: "{colors.warning}"
    rounded: "{rounded.sm}"
  warning-line:
    backgroundColor: "{colors.card}"
    textColor: "{colors.warning-ink}"
    typography: "{typography.body-sm}"
  destructive-plate:
    backgroundColor: "{colors.destructive}"
    rounded: "{rounded.sm}"
  destructive-line:
    backgroundColor: "{colors.card}"
    textColor: "{colors.destructive-ink}"
    typography: "{typography.body-sm}"
  success-dot:
    backgroundColor: "{colors.success}"
    rounded: "{rounded.full}"
  info-dot:
    backgroundColor: "{colors.info}"
    rounded: "{rounded.full}"
  merged-dot:
    backgroundColor: "{colors.merged}"
    rounded: "{rounded.full}"
  usage-input-dot:
    backgroundColor: "{colors.usage-input}"
    rounded: "{rounded.full}"
  usage-output-dot:
    backgroundColor: "{colors.usage-output}"
    rounded: "{rounded.full}"
  usage-cache-write-dot:
    backgroundColor: "{colors.usage-cache-write}"
    rounded: "{rounded.full}"
  usage-cache-read-dot:
    backgroundColor: "{colors.usage-cache-read}"
    rounded: "{rounded.full}"
  code-keyword:
    textColor: "{colors.syntax-keyword}"
    typography: "{typography.code}"
  code-string:
    textColor: "{colors.syntax-string}"
    typography: "{typography.code}"
  code-number:
    textColor: "{colors.syntax-number}"
    typography: "{typography.code}"
  code-title:
    textColor: "{colors.syntax-title}"
    typography: "{typography.code}"
  code-attr:
    textColor: "{colors.syntax-attr}"
    typography: "{typography.code}"
  code-comment:
    textColor: "{colors.syntax-comment}"
    typography: "{typography.code}"
  chart-series-1:
    backgroundColor: "{colors.chart-1}"
    rounded: "{rounded.sm}"
  chart-series-2:
    backgroundColor: "{colors.chart-2}"
    rounded: "{rounded.sm}"
  chart-series-3:
    backgroundColor: "{colors.chart-3}"
    rounded: "{rounded.sm}"
  chart-series-4:
    backgroundColor: "{colors.chart-4}"
    rounded: "{rounded.sm}"
  chart-series-5:
    backgroundColor: "{colors.chart-5}"
    rounded: "{rounded.sm}"
---

# Gots

Gots is the app beside Hermes Agent: a chat, the lists that open beside it, and the settings that
keep a bot running. It is drawn for a phone in one hand first and a wide screen when there is one,
and it speaks only where a screen has something to say.

## Overview

The app is quiet and a little playful. A screen is a surface with cards on it, one green accent for
the thing to press, and words at the size they are read at. Nothing is decorated to look busy: the
mood is one idea per screen, a real hierarchy, and a deliberate accent.

Two rules carry most of the look.

- **Colour answers "can I press this".** `{colors.primary}` marks the one action a screen exists
  for; every other control is a row, a pill in `{colors.muted}`, or a plain line of text.
- **Motion answers "is something happening".** A loader turns beside the words it belongs to, and a
  surface that has nothing running keeps still.

Structure comes from surfaces rather than decoration: `{colors.background}`, then `{colors.card}`
for what is grouped, then `{colors.popover}` for what is opened over both. Hairlines in
`{colors.border}` separate them, and elevation is the order of those surfaces, not a shadow.

## Colors

The palette is neutral with one accent, in light and in dark.
**Light and dark are the same token names**: every screen reads `{colors.background}`,
`{colors.card}`, `{colors.foreground}` and the rest, and the mode swaps the values behind them.
Nothing is styled for one mode alone, and a colour written as a literal instead of a token is a bug
that only shows in the dark.

- **Background:** the page, and the surface a card stands on — `oklch(1 0 0)` in the light and
  `oklch(0.145 0 0)` in the dark.
- **Card and popover:** the grouped surface, `{colors.card}` for a list of rows and
  `{colors.popover}` for a sheet, a drawer or a menu. Both take their own ink,
  `{colors.card-foreground}` and `{colors.popover-foreground}`, so text never borrows a colour from
  the surface under it.
- **Primary:** the app's green, `oklch(0.527 0.154 150.069)` in the light and
  `oklch(0.448 0.119 151.328)` in the dark, always with `{colors.primary-foreground}` on it. It is
  spent on one action per screen, a current value, and the dot that says a bot is online.
- **Muted and accent:** the plate of a field and a row at rest (`{colors.muted}`), and the fill of
  the row that is open (`{colors.accent}`).
- **Border, input and ring:** the hairlines. `{colors.border}` divides cards and groups,
  `{colors.input}` edges a field, and `{colors.ring}` is the 3px focus ring. In the dark the two
  hairlines are white at 10% and 15%.
- **The tone inks:** `{colors.warning}` and `{colors.destructive}` are tones, not text. Each has a
  line of its own — `{colors.warning-ink}` and `{colors.destructive-ink}` — because a tone read as a
  line of text on its own tint scores 2.55:1, where its ink scores 5.25:1. In the dark both inks
  collapse into their tones (`--warning-ink: var(--warning)`), since the dark tone is already a line
  that reads at 6.95:1. **A plate and its ink are two entries**: `warning-plate` carries the tint
  and `warning-line` reads the ink against the surface that tint sits on, since a pair read as one
  entry scores 2.06:1 — and that is not what the app draws.
- **Success, info and merged:** the dots and marks a row carries — a merge, a live pull request, a
  count at work. They are fills at 8px, never text.
- **Usage and syntax:** the four usage bars by kind, and the six colours a tool card's code is
  highlighted in. A syntax colour is ink alone: the block it is read on is the card's muted plate,
  so each is listed without a plate of its own.
- **The chart series:** five hues at a similar lightness, `{colors.chart-1}` to `{colors.chart-5}`,
  in that order, so a series stays apart by colour rather than by weight in a chart 224px tall.

## Typography

Two families, both variable. **Figtree** is everything the app says; **JetBrains Mono** is code, a
project's own face and anything that has to line up in columns.

- **Headlines** are Figtree semibold at 24px or 20px, tightened to `-0.025em` so a title reads as
  one shape. Only a screen's own title and a sheet's heading take it.
- **Bodies** are Figtree regular: 16px for a row's title, a button and anything typed into, 15px
  with 1.625 leading for a reply's words, 14px for the line under a title and for a caption.
- **Labels** are 14px and 12px at weight 500: a pill's words, a badge, a counter.
- **Code** is JetBrains Mono at 13px, and that is the size a tool card's block is drawn at.
- **Typed text is 16px**, always: a field smaller than that makes a phone zoom the page, so the size
  is the floor rather than a preference.

Line heights are unitless multipliers and belong to the level, not to the screen.

## Layout

The app is laid out for a **390px phone** first, then a 768px tablet, then a laptop at the
**1024px breakpoint**. Below 1024px a list is the screen and an item opens over it as a bottom
sheet; from 1024px the list takes a rail and the item stands beside it, and a sheet becomes a side
drawer.

- **The reading column is 640px of text inside a 672px box.** The box is what an in-chat card fills
  and the width no card passes; the 16px gutters either side of the text are the difference, so a
  card frames the measure exactly. A chat's words stand on that measure at every screen width, which
  is the measure the list screens read at too.
- **A reply is one column.** Its text, the interface a block draws and the rows that account for its
  work all stand on the same inset, so a block starting to draw moves nothing.
- **Gutters are 16px**, and 12px at the foot of a composer. Nothing scrolls sideways.
- **Anything tappable is 44px tall**, never smaller and never behind hover, and a row is 56px.
- **The foot of the screen belongs to the phone.** A composer, a sheet's last row and a toast stand
  at `max(0.75rem, env(safe-area-inset-bottom))`, and the app reads `env(safe-area-inset-*)` rather
  than guessing at a bar's height.
- **One page, one column of groups.** A settings screen is a centred column of cards, and a pop-up
  is a sheet full width on a phone and 640px at most on a tablet.

## Elevation & Depth

There are no drop shadows between a card and its page. Depth is the order of surfaces and one
hairline.

1. `{colors.background}` — the page.
2. `{colors.card}` — what is grouped on it, framed by a `{colors.border}` hairline at 24px radius.
3. `{colors.popover}` — a sheet, a drawer or a menu, over everything, with a scrim of black at 32%
   between it and the page it covers.

A pop-up is the one thing that carries a shadow: a soft one under a sheet or a drawer, and a
two-line one under a menu, because it sits over a page that keeps working beneath it. A sheet that
is drag-snapped over a canvas takes no scrim: the page stays readable and the sheet's stops say
where it is.

A card never floats. Where a row needs to lift, it takes `{colors.muted}` or `{colors.accent}`
instead.

## Shapes

One radius, `0.625rem`, and four steps of it: `{rounded.sm}` 6px, `{rounded.md}` 8px, `{rounded.lg}`
10px, `{rounded.xl}` 14px. Larger surfaces take the steps the shape needs — `{rounded.3xl}` 24px for
a card or a group of rows, `{rounded.sheet}` 28px for the top corners of a bottom sheet,
`{rounded.2xl}` 16px for a drawer and a menu.

- **Pills are `{rounded.full}`**: a button, a field, a chip, the bar an edit's actions sit in.
- **Rows are square inside their group.** The group is the rounded shape; its rows take no radius of
  their own, and the hairline between them is the group's own fill showing through a 1px gap.
- **A dot is `{rounded.full}` and 8px.** It says a state — online, merged, at work — and never
  carries words.

## Components

A row is the app's unit. It is 56px of `{colors.card}` with 16px of padding either side, a title at
16px and one muted line under it, and the row that is open takes `{colors.accent}`. Rows are stacked
in a group: one 24px card whose hairline fill shows between them, so the group is one shape and the
separators are not drawn.

**Actions are pills.** A primary action is `{colors.primary}` with `{colors.primary-foreground}` on
it, 44px tall, `{rounded.full}`, 16px of padding either side. A secondary action is
`{colors.secondary}`. A destructive action is `{colors.destructive}` on the surface, over the 10%
destructive tint it carries, and never a red plate. Where a form has two actions they sit in one
muted pill, divided by a hairline: Cancel on the left, Save in the same size at weight 500.

**Fields are filled, not outlined.** A field is 48px of `{colors.muted}` at `{rounded.full}`, 16px
of padding, and 16px of typed text. A label sits above it at 14px in `{colors.muted-foreground}`,
and the field's own hairline is `{colors.input}` where one is drawn.

**Sheets and drawers.** Below 1024px a pop-up is a bottom sheet: `{colors.popover}`, its top corners
at `{rounded.sheet}`, a drag handle above a centred heading, a scrim behind it, and its last row
clear of the home bar. From 1024px the same content is a side drawer at a third of the viewport —
never narrower than the 412px list it stands beside — or, for a pick made from a button, a menu at
`{rounded.2xl}` beside that button. A confirmation is neither: it is a centred dialog on every
screen.

**Tone plates and tone lines.** A tone is drawn twice. `warning-plate` and `destructive-plate` are
the tint a banner, a badge or a count sits on; `warning-line` and `destructive-line` are the ink
that speaks on that surface. A tone is never used as its own line of text: the tint would leave it
at 2.55:1.

**Dots, code and charts.** A state is an 8px dot in `{colors.success}`, `{colors.info}` or
`{colors.merged}`. A project's token use is four dots, `{colors.usage-input}` through
`{colors.usage-cache-read}`. Code is `{typography.code}` on the muted block a tool card draws, in
the six syntax colours. A chart draws its series from `chart-series-1` upward, never reordering
them, and an interface's tables and lists reuse the row and card above rather than inventing a
surface.

**No explanatory copy.** A row's title says what it is and its muted line says what it holds; a
screen adds nothing to say why it exists. An empty screen says what would fill it, a loading one
keeps the shape it is about to fill, and an error says what failed and what to try — in the app's
words, once.

## Do's and Don'ts

- Do spend one accent per screen: `{colors.primary}` marks the single thing to press.
- Do build depth out of surfaces — `{colors.background}`, `{colors.card}`, `{colors.popover}` — and
  hairlines in `{colors.border}`.
- Do put a tone's ink on the surface its plate tints: `{colors.warning-ink}` reads at 5.25:1 where
  `{colors.warning}` as text scores 2.55:1.
- Do keep every target 44px tall, every row 56px, and every typed field at 16px.
- Do keep the foot of the screen clear of the phone's bar with `env(safe-area-inset-bottom)`.
- Do hold text to the 640px column, and cards to its 672px box.
- Don't hardcode a colour. A literal is not a token and it breaks in the dark.
- Don't explain the interface. A title, one muted line, and nothing about why the screen exists.
- Don't set a paragraph under 15px, a label under 12px, or type into a field under 16px.
- Don't put a plate and its ink in one pair. The tone and its ink score 2.06:1 read together; the
  plate is one entry and the line is another.
- Don't mix a shadow into a card. Shadows are for what floats over the page: a sheet, a drawer, a
  menu.
- Don't let a pill and a card argue: pills are `{rounded.full}`, cards are `{rounded.3xl}`, and a
  row inside a group takes no radius at all.
