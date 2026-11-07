# Generative apps: the loop

**Superseded by [ADR 0113](../adr/0113-a-canvas-is-its-bots-record-edited-only-through-its-own-session.md)** (2026-11-07): Apps are replaced by canvases (#920), and the implementation this spec describes is gone.

Status: settled by the wayfinder map #810 and ready for a build handoff.

## Problem Statement

A reply can draw an interface, and the thread forgets it. Ask for a home dashboard in March and again in
April and there are two dashboards in two messages, neither the one read yesterday, neither changeable
except by asking again. Everything the chat's interfaces are good at — arriving in a reply, patching the
block above, falling back to code — belongs to a transcript, and a transcript is a place things scroll past.

The surfaces people want are the ones a thread holds worst: a dashboard opened on a phone in the morning,
a list of what is due, a page per room. These want returning to, changing in one place, reading on a train.

The chat's shape rules most of the obvious answers out. An interface's identity is the id of the block that made
it, so a saved thing carrying a thread's id would be rewritten by any reply reusing that id. The vocabulary
is taught in a section with 4,000 characters to spend, and the library spends 3,848; teaching a page to
query, mutate and navigate in that same section measured more than three times the ceiling. What is missing
is a record: somewhere for an app to live that is not a message, an answer that replaces one page without
touching the others, and a prompt section of its own.

## Solution

An app is a saved surface of its own: a record of pages on the bot's host, one openui-lang document each,
one of them the root the app opens on. The device keeps a copy of every page it has opened, so a saved app
draws with the host away.

The apps screen is a list pane and the open app beside it, and it is where an app is asked for and changed. A
build is a run prompted from that screen: its blocks are the app's pages, the first is the root, and nothing
is written until the answer finishes — one transaction, so no reader meets a half-built app. A change is a
run over one page: the page's whole source goes to the bot, one block comes back, the page streams in place,
and the source it replaced is kept for one step of undo. There is no accept step, because a change landing
where the reader is looking is undone rather than declined.

A page may fetch its own data and link to another page of the same app. The tools it calls are derived from
its source, agreed once at save, and enforced on the host's query route, so what the reader agreed to is
what runs. The app's prompt section is its own, written for documents that query and navigate rather than
for one fenced block inside a thread.

## User Stories

1. As someone who has asked for the same dashboard three times, I want to ask once and come back to it, so
   that a surface I use is not a message I scroll to find.
2. As someone saving a first app, I want a plus and a prompt sheet on an empty apps screen, so that the
   first thing I do is describe what I want rather than learn a builder.
3. As someone saving a first app, I want that sheet's last step to be the list of tools the app will call,
   so that I agree to what it may use before it exists rather than after.
4. As someone whose first app arrives as several pages, I want it to open on the page the answer put first,
   so that a dashboard of rooms does not open on a room nobody chose.
5. As someone reading an app, I want its pages to move between each other with a link, so that a room or a
   list opens without asking a model again.
6. As someone tapping a link, I want a link to a page that is not there drawn disabled rather than breaking
   the app, so that a stale link is a dead control and not a blank pane.
7. As someone changing one page, I want the rest of the app left alone, so that editing what is due does
   not rewrite my home page.
8. As someone who asked for a change, I want the page to stream the new version where it stands, so that I
   watch it redrawn rather than wait on an empty pane.
9. As someone who does not like a change, I want to undo it in one step, so that trying a change costs a tap
   rather than a rebuild.
10. As someone whose change broke mid-answer, I want the page to stay as it was, so that a failed answer
    cannot leave me a half-written surface.
11. As someone whose build failed, I want nothing saved, so that any app I open is one that finished.
12. As someone on a second phone, I want the apps my bot has, so that installing the app again gives me back
    what I paid a model to write.
13. As someone with no signal, I want the pages I have opened to draw from the device, so that a saved app
    is not a blank pane on a train.
14. As someone whose bot is away, I want refresh and edit refused before I wait on them, so that the control
    says why it cannot work instead of failing after a minute.
15. As someone opening a built-in app, I want to be asked for the tools it calls on its first open, so that
    an app I never saved still has my agreement.
16. As someone reading a built-in before its server answers, I want the values to say they are sample data,
    so that a made-up temperature is not read as my house.
17. As someone who edited a built-in, I want to be told an update is available rather than have it replaced
    under me, so that my edit survives.
18. As someone who does not want a built-in, I want to hide it, so that the list is mine without the app
    losing its place for a reinstall.
19. As someone whose app reads a live number, I want it to fetch when it draws, so that a dashboard is not a
    photograph from the day it was made.
20. As someone whose app writes — a task added, a box ticked — I want the write to show as pending, so that
    I am never shown a change the server has not taken.
21. As someone looking at what an app may call, I want the list derived from its pages, so that it holds
    nothing they do not use and nothing they use is missing.
22. As a screen reader user, I want the list, the open app and a disabled link named, so that I can tell
    which page I am on and which control does nothing.
23. As a maintainer, I want a build to write in one transaction, so that no reader ever meets an app that is
    half written.
24. As a reviewer, I want the reversal recorded — apps on a screen of their own, the chat spec's scope note
    amended in one line — so that the next reader does not read the old sentence as the rule.

## Implementation Decisions

**An app is a record of pages, and one of them is the root.** An app is not one document: a home dashboard is
a home page, a room, an energy trend; a GTD app is what is due and what is next. Each page is one openui-lang
source with its own first-line id, while the title and the library version belong to the record.

**A change replaces one page's whole source, and never merges — and a chat reply cannot change an app.** A
merge was the obvious alternative, because a chat already has one, and it is the wrong shape: the patch a
thread folds is by statement name, so a change that omits a card leaves that card standing. Removal would
need syntax the model must be taught, and a merge gone wrong is a dashboard keeping a light nobody wants.
Replacing the source makes removal free — you do not write the card — and makes a change a reviewable diff
of one page. An interface's id namespace is its thread's, and an app is changed on its own surface, in its
own prompt; nothing in a reply reaches the record.

**The record is the bot's, and the device keeps a copy.** The bot's host gains two tables — one for an app,
one for a page — with the page row carrying the source it replaced. The list route answers apps without
their sources; a write touches one page; a write aimed at a page of an app that is gone answers not-found
rather than recreating it, so a deleted app stays deleted. The device keeps every page it has opened, and
the host is the truth: a cache that disagrees loses. A page never opened here says so rather than drawing
an empty app, the cache is cleared with the app's other data, and a reinstall restores apps from the bot.

**A build writes once at the end; a change is one page in and one block out.** A build run's blocks are its
pages, the first is the root, and the app is written only when the answer finishes, in one transaction — so
a build that breaks at its third page leaves nothing behind. A change run is given the page's current
source — the bot is given a page, not access to the record — and answers with exactly one block; anything
else is refused. The block streams over the open page, and when it finishes the source is replaced and what
it replaced kept for one step of undo. There is no accept step: an answer that breaks writes nothing, so the
page keeps what it drew.

**The apps screen holds the list and the open app.** A sixth entry in the app's nav leads to it, and the open
app has an address of its own, so a reload, a back gesture and a link all land on the app rather than the
list. The list is drawn from the device's copy when the host is away. Refresh and edit are refused before
the request while the host is away or the interface switch is off, with the reason on the control. The
first run is a plus and a prompt sheet whose last step is the derived consent list; the plus stays once
there are apps, and a hidden built-in is absent from the list.

**Two built-ins ship, on two different servers.** A Home Assistant dashboard and a GTD app over Todoist, both
consumers of the bot's MCP tools on different servers, so the proxy is proven rather than special-cased.
Their sources ship in the plugin, seeded on the first list request and idempotently. A built-in cannot be
deleted, only hidden; an untouched one — no edited timestamp — is replaced wholesale when the bundle's
version moves, and an edited one reports an update available instead. Sample data rides the query's own
defaults with a Callout saying it is sample, so a made-up reading is never read as a house.

**A page reaches another page through a link, and a link is drawn through a context.** The library gains one
component, Link, taking a label and a page, costing 80 to 100 characters of prompt, drawn by the apps screen
providing navigation through a context rather than through an action — which keeps action syntax out of the
prompt and an action runtime out of the app. It sits among the library's leaf components, because extending
the library throws on its lazy root union. A link to a page that is not there draws disabled and notes it at
the console's verbose level, and the chat's section must not advertise it: a reply has nowhere to move to.

**A page fetches its own data, and the tool list is derived from its pages.** The data path has two families —
the host routes that already exist (usage, routines, projects, sessions) and the bot's MCP servers, proxied by
the plugin — reached through a query route, a registry of shapes rather than a list of tools, and the plugin's
own MCP client. Writes are allowed, so a GTD app adds a task and a dashboard switches a light, and a write shows the renderer's own pending
state rather than an optimistic flip. Hermes's own MCP stack is approval-gated and cannot serve an app; a
remote server needing OAuth is the hard case. The tool list is read
from a page's query and mutation statements, asked at save with the host's own routes exempt, and enforced on
the query route, so a tool the app was never granted is refused where the call happens.

**The app's section is its own, and it is not the chat's.** A chat's rules are about a fenced block in a
reply: one read-only interface, patches by id, plain-text cells, a fresh id per interface. A page's rules are
about a whole document: no fence, no patches, a build answering with several pages and a change with one
replacement, a page that may link and may query or mutate. Sharing one section was measured — 3,752 characters
of headroom, 9,056 more for the query teaching alone, an extension that throws on the lazy root union — so
apps get a section of their own with its own ceiling to meet, and the chat keeps the one it has.

## Testing Decisions

- **Two browser flows, because two things only a browser shows.** Geometry — the list pane and the open app at
  a phone's width and a tablet's, with the app drawn from the device's copy after the host is stopped — and
  streaming, where a change is watched arriving over an open page and undo puts back what was there. Both
  keep a row and a verdict in the flow audit.
- **Unit** — the derived tool list (a page with two queries and a mutation derives three tools, the host's own
  routes left out); the built-in update rule; link resolution (a target that is a page resolves, one that is
  not draws disabled); the caps an app and a page are held to.
- **Plugin** — the store's migration onto an existing home; the routes listing without sources and writing one
  page at a time; a write to a page of a missing app answering not-found and not recreating it; seeding twice
  leaving one copy of each built-in; the query route refusing an unconsented tool.
- **Component** — the apps screen with its list and its open app; the page fallback, where a page that cannot
  draw shows its source rather than nothing; the consent gate, where a save without consent writes nothing;
  every example in the Component reference, drawn through the real renderer.
- **Drift** — every built-in page parsed through the real library, so a sample that stops parsing fails the
  build; the Component reference's props against the library's schema; the chunk script keeping the renderer,
  the chart and the library out of the entry chunk.
- **What these assert** is what a reader sees and what a tap produces: which page is open, whether a link is
  disabled, whether a page was drawn from the device or the host, whether a write is pending. A remote MCP
  server's OAuth handshake is not tested at this tier — it needs a third party — so its refusal paths are
  covered at the plugin tier and the handshake is reported untested unless it is run against one.

## Out of Scope

- Community sharing, a public registry of apps, or importing someone else's.
- Exporting an app to a file and importing it on another device.
- A routine that refreshes an app, and any cadence for one.
- An app that talks back to a thread, or a page that asks the bot something mid-draw.
- Widening what a chat reply may draw, and any change to the chat's section beyond keeping the link out.
- The Component reference itself, which its own spec covers.
- A page container that positions child pages, or any second rendering language beside the library.
- A direct device protocol or a vendor's own API: every write is a tool call through the query route, and
  nothing speaks to a house any other way.
- How a page written against an older library draws on a newer app.
- Building any of this. This is the spec a build starts from.

## Further Notes

- **The reversal, and the record it owes.** The chat's spec says no second chat shell, no new screen, no new
  storage. That sentence takes a one-line Status amendment: apps get a screen and a store. No ADR is reversed,
  because the line was a scope note for one feature rather than a rule about generated surfaces, and the ADR
  about the bot's own face still stands.