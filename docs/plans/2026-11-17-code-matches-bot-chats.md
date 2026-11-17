# Code's list and sessions look and behave like a bot's chat list and chats

## Goals
- **G1** The Code list is drawn by the same shell as a bot's chat list: pinned bar, project chips in the pill slot, search in the bar from 1280px and in the foot below it, the shared foot with one round `+` for New session, one flat band of rows.
- **G2** A project session's header stays as today (centred, with its subtitle and the back to Code), minus the `…` button. Its subtitle reads the bot name, then the first repository and `+N more` when the session has several, at every width. Pressing the header opens the same settings sheet a chat's title opens.
- **G3** Everything the `…` menu held lives in that sheet: Context, name, mute, pin, then the session's own Resolve/Reopen, Discard and Delete, and the full list of its repositories. The wide-width context ring stays in the header as today.

## Non-goals
- Keeping Code's state groups (Waiting for You, Working, Idle, Closed). The user chose a flat list.
- Any change to the session's composer, cards, thread or blank-state content.
- Rooms or routines in Code.

## Change map
| Layer | Status | Goals | Tested at |
|---|---|---|---|
| UI: Code list screen | changed | G1 | component test over a seeded device |
| UI: shared list shell and foot | changed | G1 | same |
| UI: chat header and settings sheet | changed | G2, G3 | component test of the sheet |
| Repo line rule (`repo-line`) | changed | G2 | unit test (`test-repo-line`) |
| UI: chat and chat-next screens | changed | G2, G3 | chat screen tests |
| Item grouping rules | affected | G1 | unit test (`item-groups`) |

## Flows
No flow crosses layers.

## Steps
1. **Code list on the shared shell.** Goals: G1. After: none. Layers: Code list screen, list shell and foot, item grouping. Check: component test that Code renders flat rows under pills, with the foot's `+` opening the New session pick and the search in the foot below 1280px; red then green. Done.
2. **Session header and sheet.** Goals: G2, G3. After: none. Layers: chat header and sheet, both chat screens. Check: component test that a session's centred header, unchanged, opens the sheet holding Context, Resolve/Reopen, Discard and Delete, and that no `Chat options` menu exists; red then green. Done.
3. **Repo line.** Goals: G2. After: none. Layers: repo line rule, chat screens. Check: `test-repo-line` asserts `Bot · owner/repo +2 more` for three repos at phone, tablet and laptop widths and the bare name for one; red then green. Done.
4. **Gates and docs.** Goals: G1, G2, G3. After: 1, 2, 3. Layers: all above. Check: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, plus `pnpm e2e` for any flow naming the removed menu or groups; AGENTS.md rows updated. Done.

## Decisions
- **Foot is the shared `ListFoot`.** Made by the user (Q1), because they picked it.
- **Code goes flat.** Made by the user (Q2), because they chose it over keeping groups.
- **The session screen changes too.** Made by the user (Q3, then "header, edit options, etc."), because they asked for consistency there.
- **Arena skipped.** Made by the agent: no new layer, nothing new public, three steps, no open boundary question.
- **Subtitle names one repo plus a count, replacing the width-based cap.** Made by the user (header correction), because they asked for it.
- **Context joins the sheet.** Made by the user (header correction), because everything from the menu moves there.
- **Project chips go in the pill slot.** Made by the agent, because the chat list puts its filter there.
- **Order is Code's sort menu, pinned first, kept in the bar.** Made by the agent, because the sort is a stored user setting and removing it is not asked for.
- **Row state stays on the row** (spinner, alert icon, tone, unread dot), because that is how the chat list already shows it.

## Risks
- Flat loses "Waiting for You" as a place to look; a session that needs you is seen only by its alert icon and warning line. Last activity order helps only if you sort by it.
- Resolve, Discard and Reopen move from a menu into a sheet one tap deeper.
- AGENTS.md states a session keeps its `…`; that line and ADR text need amending (a new ADR will record it).

## Not now
- A "Waiting" pill to recover the lost grouping, from the grilling.
