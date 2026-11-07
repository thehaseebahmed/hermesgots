# An app is drawn by a wider library, told in its own section

**Superseded by [ADR 0113](0113-a-canvas-is-its-bots-record-edited-only-through-its-own-session.md)** (2026-11-07): Apps are replaced by canvases (#920).

An app draws more than a reply: it links between its pages, it reads live data, and some of its
controls write. That vocabulary is not the chat's, and the two must not share one prompt section.

Two measurements decide it. The section is capped at 4,000 characters and the chat's artifact already
spends 3,848 of them, leaving 152. Turning queries on — `Query`, `Mutation`, `@Run` and the built-in
functions, as the library teaches them — costs **9,056 more**, which is 3.2 times the cap and cannot
be trimmed into it: a section past the cap is dropped whole rather than shortened, so the failure is
total rather than degraded. And a component costs between 67 and 83 characters depending on its
description, so a link and a query rule and nothing else would land at the cap exactly, leaving no
room for the next small thing.

But the 9,056 characters are *teaching text*, not schema. The parser accepts a query statement with
the checked-in library and reports no errors at all — the runtime does not need the library to
describe the syntax for the syntax to work. So the app's section hand-writes the short rule it needs
and leaves the library's essay out of it.

That makes a second section the honest shape: the chat's section untouched, the app's section built on
the same library with three differences — a `Link`, a hand-written query-and-write rule, and without
the two rules that only mean anything in a chat (that a data-shaped answer draws, and that a question
goes through the clarify tool). Each section answers with nothing for sessions that are not its kind,
so a chat never pays for the app's vocabulary and an app never pays for the chat's.

A wider library also has to be a *second* library, not an extension of the first. The catalogue's own
extend call throws on this library: the root's child union is built through a lazy schema, and the
slot detection does not see through it, so a component added that way is described by the prompt and
dropped by the parser. The two libraries are built from one module and differ by the components they
pass in.

## Considered options

- **One section, one library, queries enabled.** The simplest story. Rejected on the measurement: a
  dropped section, not a smaller one.
- **One section, compressed.** The repo has compressed this artifact before, and a rewrite table is
  how. Rejected because 9,056 characters is not a trimming problem; reaching 4,000 would mean
  deleting the query teaching entirely, which is the hand-written rule below, arrived at by accident.
- **A wider library through the catalogue's extend.** Rejected: it throws on this library's lazy root
  union, and a component named in a prompt that the parser cannot place is worse than no component.
- **The app's vocabulary in a skill.** Skills load on invocation, so the first app run would draw
  nothing. The chat rejected the same option for the same reason.

## Consequences

- **A component added for apps is added to the app's library only,** and the chat's section does not
  grow.
- **Two sections have to stay inside the shared eight thousand characters,** and each has to be
  measured when it moves — the build script that refuses an oversized artifact is per-section, not
  per-total.
- **The app's section is the only place a query or a write is taught,** so a change to how an app
  fetches is a change to that section, not to the library's generated words.
- **A host that predates the app's section advertises the feature off,** which the app reads as "this
  bot cannot make apps" rather than as a fault.
