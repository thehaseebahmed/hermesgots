# Generative apps: the built-ins

**Superseded by [ADR 0113](../adr/0113-a-canvas-is-its-bots-record-edited-only-through-its-own-session.md)** (2026-11-07): Apps are replaced by canvases (#920), and the implementation this spec describes is gone.

Status: settled by wayfinder map #810 — every decision below is one of its closed tickets, and this spec reopens none of them.

## Problem Statement

A bot's Apps list starts empty, and the empty list is the whole first impression of generative apps. What a page can be is left to the user's imagination and then to their prompt: someone who has never seen a page cannot ask for a good one, cannot tell whether a thin answer is the model's fault or their own wording, and has no way to learn that a page may query, act or link to another page except by reading documentation they have no reason to open.

The two integrations that matter most are also the least obvious. A home's states and a task list both arrive through MCP servers, both need a page that reads and a page that writes, and neither shape appears anywhere in the product. The data path, the consent list and the pending state of a write are all proven by nothing a person can look at.

Underneath both is a quieter problem. The app prompt, the component library and the pages the feature is meant to produce can drift apart while every test passes, because nothing in the repository is a page drawn by the app that ships it. A component renamed in the library breaks a page in someone's app rather than a test.

And anything shipped has a second life the product has never had to think about. An app that arrives with the plugin is, from the moment it lands, someone's app: it can be edited, it can be unwanted, and it will outlive the release that seeded it. A demo that can only be deleted is a demo that leaves a hole; one that is overwritten on every release is a demo that eats an edit. Neither is acceptable once it is on the host beside apps the user made.

## Solution

Two built-in apps ship with the plugin, written by us rather than generated: a Home Assistant dashboard and a GTD app over Todoist. Both appear in the Apps list like any other app, open on a root page, and are made of the same pages, the same components and the same query path as anything the model generates.

- **They ship inside the plugin**, beside the prompt artifact, so the text the model is taught and the pages that demonstrate it move together. A manifest carries one set version and a version per app.
- **They are proven by a drift test in the app's tier**, which parses every page through the real library. A built-in app cannot ship as a page the renderer would fall back to code.
- **Seeding is lazy and idempotent**: nothing is written at install, the first list read creates whatever is missing, and every later read writes nothing.
- **A built-in app cannot be deleted, only hidden.** Hiding is kept on the host, so two devices agree and a reinstall does not bring it back.
- **An untouched built-in app is replaced wholesale** when its version in the bundle moves. One that has been edited is marked instead, reports that an update exists, and is replaced only when the update is taken — which clears the mark. Hiding does not freeze it, and a bundle that drops an app deletes nothing.

The Home Assistant dashboard is the house at a glance: a Card with who is home and how many lights are on, a Table of rooms with temperature and humidity, a Chart of the day's energy, a Callout naming anything left open or on, and a Link to a room's own page carrying that room's entities and history. It reads and acts through Home Assistant's MCP server.

The GTD app is a working day over Todoist: a List of today's tasks, a Table of projects with their next action and count, a Callout for what is overdue, a List of what is waiting on someone else, and a Link to each project's page. It reads and writes through Todoist's MCP server.

Both are MCP consumers on different servers, with different tool shapes and different verbs, so the proxy is proven rather than special-cased. Sample data rides each query's own declared defaults, so a page draws itself before any tool answers, and a Callout on the page says the data is sample. Each built-in app asks for consent on its first open, because it is never saved by the user.

Deleting is refused because a built-in app is the only app nobody chose to create: a delete would remove something the user never added and cannot get back by asking. Hiding gives them the same quiet list without destroying the record, and because the mark is on the host, the quiet list is the same list on every device. Everything else about a built-in app is ordinary — it caches, it opens while the host is away, and a change run edits it exactly as it would edit a generated app.

## User Stories

1. As someone opening Apps for the first time, I want to see two apps already there, so that the feature is not an empty list and a plus button.
2. As someone who has never seen a page, I want to open one and read it, so that I learn what this surface can be before I ask for anything.
3. As someone about to write a prompt, I want a built-in app that reads live data, so that I know a page can be more than a static card.
4. As someone about to write a prompt, I want one that writes as well, so that I know a page can act on my behalf.
5. As someone with more than one page in a built-in app, I want to move between them, so that I understand a page can lead to another page.
6. As someone whose bot has no Home Assistant, I want the dashboard to open anyway, so that I can see the shape of it without configuring anything.
7. As someone looking at numbers I did not produce, I want to be told they are sample, so that I never mistake a demonstration for my own house.
8. As someone who has connected Home Assistant, I want the same page to show my house, so that the example becomes useful rather than staying a demo.
9. As someone with a Todoist account, I want today's tasks and my projects on the root page, so that the app is worth opening every morning.
10. As someone whose project needs attention, I want a page of its own, so that the root page stays short.
11. As someone opening a built-in app for the first time, I want to be told which tools it calls and to agree, so that nothing reads my home or my tasks without me.
12. As someone who declines, I want the app to stay and draw its sample, so that refusing is not the same as losing it.
13. As someone opening it a second time, I want no second question, so that consent is asked once rather than every visit.
14. As someone on a second device, I want the same answer honoured, so that agreeing on a phone is agreeing everywhere.
15. As someone who does not want a built-in app, I want to hide it, so that my list is mine.
16. As someone hiding one, I want it gone from both my devices, so that the list does not disagree with itself.
17. As someone who hid one by mistake, I want it back without reinstalling, so that hiding is reversible.
18. As someone who edited a built-in app, I want my edit to survive, so that the plugin never overwrites words I chose.
19. As someone who edited one, I want to be told a newer version exists, so that I can decide rather than discover.
20. As someone taking that update, I want the app replaced completely, so that I am not left with half of an old page beside half of a new one.
21. As someone who took an update, I want to stop being asked about it, so that the notice clears when the work is done.
22. As someone who hid a built-in app, I want it to keep up to date, so that unhiding it later gives me the current one.
23. As someone whose bundle no longer carries an app I have, I want it left alone, so that a release cannot delete what I may have edited.
24. As someone who reinstalled the plugin, I want no duplicates, so that seeding twice is the same as seeding once.
25. As a reader of the code, I want the pages the prompt promises to be parsed by the library that draws them, so that a rename fails in a test rather than in my app.
26. As someone opening the dashboard while my home server is slow, I want the page's shape immediately, so that opening the app is not a blank wait.
27. As someone whose bot is away, I want a built-in app I have already opened to draw from my device, so that it is not the one part of the app that needs the network.

## Implementation Decisions

- **A built-in app is an ordinary app record with a seed mark.** It has pages, a root page, a title and a library version like anything generated. Nothing about how it is drawn, cached or opened branches on being built-in; only seeding, hiding, deletion and updating do.
- **The sources live inside the plugin, beside the prompt artifact.** One bundle, so the section the model is taught and the pages that demonstrate it are released together. Nothing is fetched at runtime and nothing is generated on the host.
- **A manifest carries a set version and a version per app.** The set version says the bundle moved; the per-app version says which app moved, so a release that changes one app does not rewrite the other.
- **Versions live in the manifest, never in a page.** A page's identity is its id line; an app's version is the bundle's claim about all of that app's pages at once. Seeding records the version it wrote on the app, and that record is what every later comparison is made against.
- **Each app has a stable key** that its pages, its hidden mark, its seeded version and its consent all hang from, so a title can change without anything losing track of which app it belongs to. The keys are home and gtd, the names both apps answer to everywhere.
- **Seeding copies sources; it does not call the model.** A built-in app that had to be generated on first open would cost a turn, vary per bot, and could arrive as a page nobody has tested. Shipping the text is what makes the drift test possible at all.
- **Seeding runs on the first list read, in one transaction, and is idempotent.** There is no install hook and no migration: the first time anyone opens Apps, the plugin writes the missing apps, and a read that finds them all writes nothing. Identity is stable, so a reinstall does not duplicate.
- **A built-in app cannot be deleted.** Hide is the only removal the list offers, and the delete path refuses a built-in app outright rather than trusting the client not to ask.
- **Hiding is a host column, not a device preference.** Both devices read the same list from the host, so they agree the moment either one hides it, and the hidden app stays hidden through a reinstall.
- **Untouched means no edit mark.** An app with no edit mark is replaced wholesale — every page, in one write — when the bundle's version for it is newer than the version recorded when it was seeded. Replacing every page at once is what keeps an update from leaving an app half-new.
- **An edit is a mark on the app, not on the page.** Any write a person makes to any of its pages marks the app, because the app is now theirs; from that moment the plugin never replaces it. A change run against a built-in app is such an edit, not a regeneration.
- **An edited built-in app reports that an update exists** rather than being replaced. Taking the update replaces every page and clears the mark, and only then does it stop reporting.
- **Hiding is not a freeze.** A hidden built-in app still seeds, still updates if untouched, and still reports an update if edited; it is only absent from the list.
- **A bundle that drops an app deletes nothing.** An app seeded by an earlier bundle and absent from this one keeps every page it has and stops receiving updates. Deleting it would destroy edits the plugin has promised to keep.
- **Two built-in apps, on two MCP servers.** The Home Assistant dashboard and the GTD app over Todoist exercise the same proxy through different tools, different arguments and different verbs. Neither gets a code path of its own.
- **The dashboard shows the house at a glance and links into a room.** A Card carries presence, the thermostat and how many lights are on; a Table carries each room's temperature and humidity; a Chart carries the day's energy; a Callout carries whatever is open or on; a Link opens a room's page with its own entities. Stack holds it together, and nothing outside the library is used.
- **The GTD app shows the day and links into a project.** A List carries today, a Table carries projects with their next action and count, a Callout carries what is overdue, a List carries what is waiting on someone else, and a Link opens a project's page. Stack holds it together. The write the app offers is an ordinary mutation with the renderer's own pending state, never an optimistic flip.
- **Sample data is the page's own declared defaults.** Each query declares the values the page draws before its tool answers, so a bot with neither server configured still draws a complete page, and the parser's returned defaults are what the app renders. There is no sample fixture on the host and no second store.
- **The sample is labelled.** A Callout on each built-in page says the data is sample, in the page's own words, so the label travels with the page and is edited by whoever edits it.
- **A built-in app asks for consent on its first open.** It was never saved by the user, so there was no save at which to ask. The first open derives the tool list from the pages and asks before any query runs; the list names only the MCP tools, since the host's own routes are never asked about. The answer is kept on the app's record, so a second device does not repeat the question.
- **Declining leaves the app usable.** A refused consent does not hide or break the app: its queries do not run, its declared defaults still draw, and its Callout still says the data is sample.
- **The root page is the first page the bundle lists.** Seeding keeps the bundle's order and marks the first page as the one the app opens on, so the manifest and the app agree about where a reader starts.

## Testing Decisions

- **Unit — the update rule as a pure decision.** An untouched app at an older version is replaced; an untouched app at the same version is not written; an edited app is left alone and reports an update; taking the update replaces and clears the mark; a hidden app still takes the same branch; an app missing from the bundle is never deleted.
- **Plugin — seeding.** The first list read writes both built-in apps; a second read writes nothing; a read after a reinstall creates no duplicate; a hidden app is still created and still absent from the list; hiding one on the host is what both devices read.
- **Plugin — deletion and updating.** The delete path refuses a built-in app and allows a generated one; an untouched built-in app's pages are replaced when its version moves; an edited one is untouched and reports an update; taking the update clears the mark; a bundle without an app leaves that app's record and pages exactly as they were.
- **App tier — the drift test.** Every page in the bundle parses through the real library with no errors and no unresolved component reference; each page carries a distinct id and exactly one is the root page; every Link resolves to a page in the same app; every query declares defaults, so the sample draws without a tool; the manifest's per-app version matches the pages it lists.
- **App tier — the sample is drawable.** Every query's declared defaults satisfy the component that reads them, so a Callout's text, a Table's columns and rows and a Chart's series agree before any tool has answered.
- **Unit — the consent list a built-in app asks for.** The list derived from a built-in app's pages names only the MCP tools those pages call, and a page with no query or mutation asks for nothing.
- **Component — the built-in app as a reader meets it.** A built-in app opens on its root page and draws; the sample Callout is present; a Link moves to the linked page; the consent sheet appears on the first open and not on the second; a refused consent draws the declared defaults rather than an error.
- **Why these tiers.** The drift test is the only place a page is parsed by the library that ships with it, so it runs with the app's tests and fails a component rename before a user's app does. The plugin tests own everything that depends on the host's tables and routes, which a page cannot prove.

## Out of Scope

- Community sharing, a public registry, or importing an app from anyone else.
- A third built-in app, or a Home Assistant family of apps for rooms, energy and security.
- Connecting a server on the user's behalf, or holding its credentials: the built-in apps draw sample data until the bot's own server answers with consent.
- A routine that refreshes a built-in app, or any scheduled re-seed.
- Exporting a built-in app to a file or importing one on another device.
- What a built-in app does when the component library's version moves under it.
- Merging an edited built-in app with a newer bundle: an edited app is replaced or left alone, never reconciled.
- Deleting a built-in app, in any form, including a force delete behind a confirmation.
- Generating a built-in app on first open from the app prompt, rather than shipping its text with the plugin.
- A built-in app that cannot be edited: each one is an ordinary app from the moment it is seeded.

## Further Notes

- The bundle version is a claim made by hand when a page changes; nothing derives it. The drift test proves the pages parse, the links resolve and the versions are present — it cannot prove the number moved when the words did, so a release that edits a page without moving its version ships silently.
- The two apps were chosen for their difference, not their popularity: one server is a house with state and services, the other a task list with projects and completions. A proxy that serves both is a proxy, not a shim.
- Every component a built-in page uses is one the Component reference documents, so the shipped example and the page that explains the library cannot describe two different libraries.
- A dropped app is frozen rather than removed. It keeps its pages, its hidden mark and its edits, and simply stops receiving anything; if a later bundle carries it again, the comparison is against the version already recorded, so it resumes rather than restarting.
- The sample data is the strongest argument for the built-ins and the easiest thing to get wrong: it has to be plausible enough to teach the shape and plainly labelled enough not to be mistaken for a reading of someone's house or someone's task list.
- Hiding never resets an app. A hidden built-in app keeps its pages, its edit mark and its consent, so unhiding it returns the same app rather than a fresh seed.
- The fallback is not special-cased either: a built-in page that ever fails to draw draws as code like any page, and the drift test exists so that a release cannot ship one that does.
- Two pieces of fog touch this spec without blocking it: what a built-in app does when the library's version moves, and whether the Home Assistant dashboard becomes a family. Both are recorded on the map, and neither changes what ships here.
