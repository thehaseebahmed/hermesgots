# A bot's settings are multi-step, split into Gots and Hermes, and show a value where an editor was once in place

Status: grilled 2026-10-25, every decision settled and recorded in ADR 0052. Published as #581 with
tickets #582, #584, #585, #586, #587, #588, #589, #590 and #591; the build order at the end is the
tickets' shape when implementation starts. #581 is blocked by the gate issue #594 that this docs
pull request (#593) closes — work starts on that merge. The spec carries `ready-for-agent` and the
tickets stay bare, so the agent claims the spec and works the graph in order.

The presentation was grilled again on 2026-10-25 against Samsung One UI references and Material 3
guidance, and the decisions below were amended to it: a value shows and the edit drills in
(ADR 0055). The list, the pages, the ownership grouping, the names and the tickets stand; rows, the
page captions and the editing surfaces are rebuilt in a follow-up pull request stacked on #614.

## Goal

Settings > Bot is its own multi-step screen: a grouped list of pages — General first, then Gots
Specific Settings (Chat, Coding, Speech-to-text) and Hermes Settings (MCP, Skills) — where every
row's subtitle says what the page holds. The list replaces the Settings pane at 1024px and wider and
stays there while the last pane swaps pages; on a phone the pages push with a back button. Every page
groups its settings into Gots Specific Settings and Hermes Settings by ownership: the Gots plugin's
own host values and the app's own are Gots settings, and a knob on the bot's Hermes is a Hermes
setting, named as the Hermes Dashboard names it. Settings rows read as a title over a subtitle that
says what the setting is for — the triage model's explanation moves into its subtitle and its info
icon goes — and deleting a bot is a trash icon at the top of the list behind a *Delete {name}?*
confirmation.

## What this is not

- **Not a change to any setting's value or its home on the host.** Every setting keeps the profile
  field, plugin route or Hermes key it writes today; this is where it lives on screen and what it is
  called.
- **Not new settings.** Nothing is added to or removed from a bot's capabilities; the tabs' contents
  are redistributed, not rewritten.
- **Not the Settings menu's notification settings.** Notification types keeps its own screen and its
  feature headers; Skills only borrows the pattern.
- **Not the project AFK pop-up**, beyond Pick count gaining the subtitle its sibling Pick budget gets.
- **Not a schema change.** Nothing new is stored, so no Dexie version moves.
- **Not code renames.** The UI and the docs speak the new names first; identifiers follow later.
- **Not Account, Appearance or Developer settings.**
- **Not the implementation.** This spec, ADR 0052 and the glossary entries are what this change ships
  first; the build is the nine tickets below, once the pull request carrying this file merges.

## Decisions

1. **Settings > Bot is multi-step.** The list is sub-nav: at 1024px and wider it replaces the
   Settings pane and the last pane shows the selected page (General by default); below 1024px each
   page pushes with a back button, back from the list returns to Settings, and Android's back follows
   the same path. Old tab URLs land on their pages (ADR 0052).
2. **The grouping rule is ownership** — the glossary's **Gots setting** and **Hermes setting**. The
   root list groups its rows the same way (General first, then the two groups) and carries no
   captions; each page captions its cards *Gots* and *Hermes* where both kinds exist, and General's
   profile card carries its own caption, *Bot Profile*, above its rows (ADR 0055).
3. **Membership is settled page by page.** General: Gots = Enabled, Mute notifications, Bot Profile
   (Name, Image, Test connection); Hermes = Subagent model, API base URL, Server key. Chat: Gots =
   Triage model; Hermes = Model, Default model, Fallback providers. Coding: Gots = Away From
   Keyboard > Pick budget. Speech-to-text: Gots = Vocabulary, Cleanup model; Hermes = Speech model.
4. **A Hermes setting is named as the Hermes Dashboard names it.** Two renames land: *API key* →
   *Server key* (the field is the API server's key, not a provider's) and *Fallback models* →
   *Fallback providers* (Hermes's own name). Model, Default model, Subagent model, Speech model and
   API base URL keep their names.
5. **Speech-to-text replaces Dictation** everywhere the feature is named, and its speech model picker
   follows the composer's model picker minus search, recents and a default entry, in place of the
   list of host speech model rows.
6. **A row is a title over the value it holds**, in the accent colour, or *Not set* in muted grey
   where it holds nothing. There are no chevrons: the value and the press state are what mark a row
   tappable. A subtitle saying what the setting is for stays only where the row drills in or the
   purpose isn't otherwise obvious — the triage model keeps its explanation and its info icon is
   gone, and Pick budget and Pick count keep the subtitles naming what each pick counts. This
   narrows the one carve-out from *No explanatory copy* (ADR 0055).
7. **The plugin banner leads the list**, reading "This bot's plugin is out of date! Update it to
   v0.0.0 or newer." with the required version in place of v0.0.0 — at the top of the Settings > Bot
   list, so it stays visible in the persistent pane.
8. **Delete is a trash icon in the list header** (the settings screen chrome gains a header action).
   The dialog is titled *Delete {name}?* and states exactly what goes: for a linked bot, its host and
   any sibling bots on it, its chats staying on the Hermes server and coming back on re-linking; for
   an unlinked bot, the bot and its data leaving this device for good. Buttons Cancel and Delete
   (destructive); deleting lands on the Settings menu.
9. **MCP's + header action** replaces the Add a server row and opens the same Add sheet (Catalogue,
   Custom server) under the same feature gating the row had.
10. **Skills categories use the Notification types header pattern exactly**: the category for a title
    (the "No category" group included), "N of M on" over a multi-skill category, checked while any
    skill in the category is on, and a tap flipping the whole category. Skill rows use the split row:
    the left opens the skill's sheet, the right toggles it.
11. **The settings UX rules live in AGENTS.md, app-wide, and their long form is
    `.agents/skills/settings-ux/SKILL.md`**: a toggle-only settings group always has a parent that
    switches it all; a toggle row with a tap action splits into a fully clickable left column (icon,
    title, subtitle) and a fully clickable right column (the switch); input labels on settings share
    one styling with the Name field's label as the baseline.
12. **A page the plugin does not advertise is hidden**, as its tab is today: Speech-to-text on
    `dictation`, Coding on `afk_picks`, MCP on `mcps`, Skills on `skills`; General and Chat always
    show.
13. **A card never holds a text box.** Editing a text value — Name, API base URL, Server key — opens
    the edit itself: a pushed screen below 1024px, a centred dialog card from 1024px, a labelled
    input with Cancel and Save committing once. Switches, steppers, avatars and buttons keep acting
    in place (ADR 0055).
14. **A list that is picked from opens a sheet below 1024px and the same centred card from it**,
    searchable, with radio rows: every model row, and Image's avatars. The anchored picker the model
    rows open today is retired.
15. **A list that is only read drills in as a screen**: Vocabulary, Fallback providers, and the two
    sheets these pages open today — the MCP server's Config/Tools and the skill note. A push below
    1024px, and from 1024px the page pane swaps while the list stays. The AFK pop-up keeps its
    sheet; it opens from a project's options menu, not from a settings row.
16. **1024px stays the app's one breakpoint** for panes, pop-ups and these screens. Material's 840dp
    expansion point is recorded in ADR 0055 as a later, app-wide change rather than adopted here.
17. **The list's trash stays**, and a page earns an overflow menu only where it needs more than one
    action — none does today.

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/components/settings-chrome.tsx` | The screen header's action slot and the settings row primitives |
| `app/src/components/bot-settings.tsx` | The Settings > Bot list, the grouped pages, the delete icon and its dialog |
| `app/src/lib/bot-tabs.ts` | The pages' URLs and order (the tab order it is today) |
| `app/src/routes/settings.tsx` | The route, the pane behaviour, and the redirects from old tab URLs |
| `app/src/components/bot-coding-tab.tsx` | The Coding page's Away From Keyboard section |
| `app/src/components/bot-dictation-tab.tsx` | The Speech-to-text page |
| `app/src/components/mcps-tab.tsx` | The MCP page's + and its Add sheet |
| `app/src/components/skills-tab.tsx` | Category header switches and split skill rows |
| `app/src/components/afk.tsx` | Pick count's subtitle |
| `docs/adr/0052-bot-settings-are-multi-step-and-split-by-ownership.md` | The structure's decision |
| `docs/adr/0055-settings-show-a-value-and-the-edit-drills-in.md` | The presentation's decision |
| `.agents/skills/settings-ux/SKILL.md` | The rules, the evidence and the review checklist for a settings screen |
| `GLOSSARY.md` | **Speech-to-text** (replacing **Dictation**), **Gots setting**, **Hermes setting**, **Pick budget** |
| `AGENTS.md` | The **Settings UX** rules and the *No explanatory copy* carve-out |

## Edges

- **A linked bot** — API base URL and Server key are absent from General; the delete dialog speaks of
  the host and its sibling bots, and says the chats stay on the Hermes server and come back on
  re-linking.
- **An unlinked bot** — the dialog says the bot and its data leave this device for good.
- **A plugin that withholds a feature** — that page's row is hidden and its old URL lands back on
  General.
- **A plugin too old** — the banner leads the list and the pages stay usable.
- **A one-skill category** — the header carries no count; a mixed category reads checked while any of
  its skills is on, and a tap flips them all.
- **A skill that doesn't load** — its row's health line keeps saying so; the split row doesn't hide
  it, and the sheet still opens from the row's left.
- **A host that withholds the model override** — the triage model keeps its banner ("This host
  doesn't let Gots pick the model…") under its subtitle.
- **Old tab URLs in history, links or docs** — land on their pages rather than the list.
- **390px and tablet widths, light and dark** — rows, values, captions and both column targets hold
  at both widths in both modes; an edit is a pushed screen below 1024px and a centred card from it.
- **A value that holds nothing** — an unlinked bot's API base URL and Server key, a bot with no
  vocabulary — reads *Not set* in muted grey rather than showing a blank line.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Unit** — the pure rules the pages draw from: a category header's checked state and "N of M on"
  wording, and the ownership membership map the group headers are drawn from.
- **Component** — each page over a seeded device database with the host faked: the grouped list and
  its feature gating, the grouping, order and copy of each page, the delete dialog's two cases, the
  category flip, the split row's two targets, the value each row shows (and *Not set*), the edit
  card's Cancel and its single write, and the pick card's search and choice. Prior art: the settings
  row and pane component tests already in the tree.
- **End to end** — geometry only: the pane replacement at 1024px, the push/back path at phone width
  and the edit's change of shape — a pushed screen below 1024px, a centred card from it — in one new
  flow with its row and verdict in `docs/e2e-flow-audit.md`; the Settings flows already in the
  registry run by name (ADR 0029).

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. The flows that touch Settings
run by name. Nothing here moves the plugin, so its suite is untouched.

## Build order

1. #582 — refactor(ui): give settings screens a header action and a split toggle row. Edge: none.
2. #584 — feat(settings): make a bot's settings multi-step with a grouped sub-nav. Edge: #582.
3. #585 — feat(settings): group a bot's General settings into Gots and Hermes. Edge: #584.
4. #586 — feat(settings): move a bot's chat model choices onto a Chat page. Edge: #584.
5. #587 — feat(settings): hold pick budget in an Away From Keyboard section on Coding. Edge: #584.
6. #588 — feat(settings): split a bot's Speech-to-text settings into Gots and Hermes. Edge: #584.
7. #589 — feat(settings): add an MCP server from a + on the MCP page. Edge: #584.
8. #590 — feat(settings): switch a skill category on and off as one. Edge: #584.
9. #591 — feat(settings): delete a bot from a trash icon on its settings screen. Edge: #584.

## The presentation rebuild

A second pull request, stacked on #614, carries ADR 0055 into the code: a row becomes a title over its
value in the accent colour, the page captions replace the bold group headings, a text value opens an
edit screen (a centred card from 1024px), the model rows and Image open a pick card, and Vocabulary,
Fallback providers, the MCP server detail and the skill note become drill-in screens. Nothing above
changes shape — the list, its pages, the ownership membership, the names and the delete behaviour
stand.

## Risks

- **The tab URLs are in muscle memory and in old docs.** Every old segment needs its redirect or a
  deep link lands on the list instead of its page.
- **The row primitives are shared by every settings screen**, so the prefactor ticket must land first
  with existing rows rendering unchanged — the blast radius of a broken row is the whole Settings
  menu, not just bot settings.
- **The *No explanatory copy* carve-out could sprawl.** A subtitle stays one line saying what the
  setting is for; it never explains how the app works or where data comes from.
- **The rows lose their purpose lines in places.** The rebuild narrows the last spec's subtitle rule
  to rows that drill in or aren't obvious, so the lines it no longer earns are deleted rather than
  left standing.
