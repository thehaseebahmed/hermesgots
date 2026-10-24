# A bot's Skills tab manages its skills the way its MCP tab manages its servers

Status: grilled 2026-10-24, every decision settled and recorded in ADR 0044 and ADR 0045, with the
glossary's *Built-in skill*, *Hub skill*, *Your skill*, *Plugin skill*, *Project skill* and
*Skill sheet* entries written alongside and *Health* extended to cover a skill's row. Published as
#519 with tickets #520 to #525; the build order at the end is the tickets' shape when implementation
starts. #519 is blocked by the gate issue (#527) that the docs PR carrying this file (#526) closes —
work starts on that merge. The spec carries `ready-for-agent` and the tickets stay bare, so the
agent claims the spec and works the graph in order. Re-grilled 2026-10-24 after the build
landed in #565: decisions 4 and 8 changed — the section headings now show only where both kinds
of skill share the bot, and the sheet reads as a note — and the rows shed their icon and category
badge. The tickets below are the original build order and stand as shipped.

## Goal

A bot's MCP servers are managed from its settings editor and its skills are managed nowhere: the
slash menu lists what a bot can do, but nothing shows everything a bot's profile holds — the skills
seeded with Hermes, the ones installed from a Hub, the ones written on the profile, the ones a
plugin package provides — or says how each is doing, and a skill that has stopped loading is
invisible. So the bot's editor grows a **Skills** tab beside MCP: every skill the profile holds with
its **health** in prose under its name, switched off and on from its row, one opened into its own
**skill sheet** — the SKILL.md and its linked files, and where it came from — and removed there
where its origin has a removal.

## What this is not

- **Not installing or authoring skills.** No catalogue, no add button, no SKILL.md editor:
  managing what the bot has is this change; adding is its own later one.
- **Not project skills.** A repository's own skills are the project's, not the bot's, and different
  per project — the tab leaves them out.
- **Not a per-platform switch.** One switch writes the profile's global disabled list: a skill is
  off for that bot, full stop.
- **Not usage facts.** The sheet says where a skill came from and whether it is ready; how often it
  ran is not this screen's question.
- **Not the dashboard's routes.** `/api/skills` answers only on the host's loopback; everything goes
  through the plugin ([ADR 0044](../adr/0044-a-bots-skills-are-managed-through-hermes-own-skill-machinery.md)).
- **Not a change to the slash menu's shape.** It keeps listing the skills the bot can run; it reads a
  richer list behind it.
- **Not the implementation.** This spec, its ADRs and the glossary are what the docs pull request
  ships; the build is the six tickets below.

## Decisions

1. **The tab is the MCP tab's sibling**: one more entry in the bot editor's tabs, its own URL at
   `/settings/bots/<botId>/skills`, its own history entry, and no tab at all where the host does not
   advertise `skills`.
2. **One read serves the slash menu and the tab**: the plugin's skills read resolves the host's
   helpers under either name they ship with, and every row carries its health and its origin; the
   slash menu filters to what the bot can run, the tab shows everything.
3. **Every row says how it is doing** ([ADR 0045](../adr/0045-a-skill-row-says-how-it-is-doing.md)):
   `Ready`, `Off`, or `Doesn't load` with the host's own reason — no badges, the same prose
   reasoning as an MCP server's health.
4. **Two sections, grouped by category**: *Your skills* and *From plugins*, each heading drawn
   bigger than the category titles and shown only while the bot holds both kinds of skill — a
   one-kind bot's tab opens straight at its categories, and a heading with nothing under it is
   dropped either way; inside the sections the groups are the categories under titles in the
   Models tab's field-label style, alphabetical, with *No category* last. Every row is its name
   over its description with its health under it and its switch to the side — no icon, no
   category badge: the group already says the category.
5. **The tab holds what the profile can**: built in, from the Hub, yours, from a plugin — including
   rows that are `Off` and `Doesn't load`, since Remove is the way out of a broken one; project
   skills and shadowed duplicates are the two things kept out.
6. **The switch follows what the host honours**: a plugin skill gets one (its disabled name is
   honoured), a protected built-in gets none, and every switch writes the profile's global disabled
   list inside the host's own config write scope.
7. **Remove is one word over three host operations**: a Hub skill's uninstall, a profile skill's
   delete, and nothing at all for a built-in — so Remove appears only where the origin has a removal
   behind it ([ADR 0044](../adr/0044-a-bots-skills-are-managed-through-hermes-own-skill-machinery.md)).
8. **The skill sheet reads the skill as a note**: one properties block first — the host's own
   rows (Origin, then Readiness and Setup where it has them) beside the SKILL.md's frontmatter
   with every key it holds, in file order, plain text — then the file's own words drawn as
   rendered markdown through the chat's own renderer, read-only, with the yaml never shown raw;
   its linked files each viewable below, a markdown one read the same way and any other staying
   the code it is; it reads that one skill when it opens.
9. **Four features gate it** as the MCP tab's do: `skills` for the tab, `skills_write` for the
   switch, `skills_remove` for Remove, `skills_view` for the sheet.
10. **Every write clears the host's own caches** — its skills cache and its prompt cache — so the
    change is live for the next turn, and a chat already built keeps the abilities it had.

## Where it lives

| Path | What it is |
| --- | --- |
| `plugin/skill_catalog.py` | The shared read: the host's helpers under either name, each row with its health and origin |
| `plugin/__init__.py` | The skills routes — list, one skill's view, the switch, the removal — and the four features |
| `app/src/lib/bot-tabs.ts`, `app/src/routes/settings.tsx`, `app/src/components/bot-settings.tsx` | The Skills tab's entry, URL and feature gate |
| `app/src/components/skills-tab.tsx` | The tab: sections, groups, rows, the switch and the skill sheet |
| `app/src/lib/skills.ts`, `app/src/lib/skills-cache.ts` | One list per bot behind both consumers, and the slash menu's filter over it |
| `app/src/lib/hermes.ts` | The routes' client calls |
| `app/scripts/mock-hermes.mjs`, `app/scripts/e2e/skills-*.mjs` | The mock's answers and the flows |
| `docs/adr/0044-*.md`, `docs/adr/0045-*.md`, `GLOSSARY.md` | The decisions and the vocabulary |

## Edges

- **A host without `skills`** has no tab; a URL naming it lands back on General, exactly as a host
  without `mcps` does.
- **A host that can do some of it**: each verb disappears where its own feature is missing — a
  read-only tab is a tab with no switches and no Remove.
- **A host whose skill helpers moved again**: the read tries the current names and falls back to the
  old; neither importing is the 501 it is today.
- **A skill switched off** leaves the slash menu and every picker, because one list serves them all.
- **A chat in flight** keeps the abilities it had; the change is the profile's, not the session's.
- **A refusal** — a protected built-in, a pinned skill, a host saying no — is the host's own
  sentence as a toast, with the row unchanged.
- **A bot whose skills all come from one source** shows no headings at all; the categories say
  the list, and only a bot holding both kinds earns the split a word.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Plugin tests** are the host's seam: the read under either helper naming, the row's health and
  origin, the switch writing the global disabled set in the write scope, a removal per origin and
  its refusals, plugin skills switch-only and protected built-ins unswitchable — with the suite's
  documented harness rules (plant the host modules imported lazily).
- **Unit tests** (no DOM, `node --test`) for the pure rules: a row's health line, the grouping
  (categories alphabetical, *No category* last, headings only where both kinds are held), the
  frontmatter read into property rows (`skill-frontmatter.ts`), and the slash menu's filter over
  the shared list — following the existing pure-rule tests for the MCP rows and the skills cache.
- **Component tests** over a seeded device database with the HTTP boundary faked: the tab's sections
  and groups, a row's switch, and the skill sheet with its linked files.
- **End to end** for geometry only: the tab and its sheet at phone and tablet widths in light and
  dark, with rows and verdicts in the audit — the mock mirroring the plugin's shapes.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, then every flow the change
touches, run by name. From the repo root: the plugin suite (`python3 -m unittest discover -s
plugin/tests -t .`).

## Build order

1. #520 — fix(hermes): answer the skills list again, with health and origin. Edge: none.
2. #521 — feat(settings): list everything a bot's profile holds on the Skills tab. Edge: 1.
3. #522 — feat(settings): switch a skill off and on from its row. Edge: 2.
4. #523 — feat(settings): open a skill's own sheet with its SKILL.md and its files. Edge: 2.
5. #524 — feat(settings): remove a skill where its origin has a removal. Edge: 4.
6. #525 — test(settings): prove the Skills tab, its switch and its sheet on screen. Edge: 3, 5.

## Risks

- **The helper naming** is the fix and the risk: a fallback that misses is a slash menu that shows
  nothing again, pinned by a test per naming.
- **The richer read** reaches a cache the slash menu already trusts; a row shape that drops a field
  breaks the menu rather than the tab, so the cache's pure rule is where it is pinned.
- **A removal routed to the wrong host operation** could take a file the wrong way; each origin's
  path and refusal has its own plugin test.
- **The switch writing the platform slot** instead of the global list would make "off" mean
  something else on another host; one assertion on the written key pins it.
- **Mock drift**: the mock answers in the plugin's shapes, so every new shape must be mirrored there
  or the flows pass against a fiction.
- **A fifth tab crowding the editor** at 390px is exactly what the flow's width assertions are for.
