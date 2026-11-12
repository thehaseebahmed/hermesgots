# A canvas carries a catalogue of libraries

**Amends [ADR 0114](0114-a-canvas-runs-in-a-sandbox-that-reaches-only-its-host.md)** (2026-11-12):
the vetted set of libraries widens to a catalogue the host refuses an unknown name by. Nothing about
the sandbox, the policy or the bridge moves.

A canvas's page runs with no network, under a policy that allows no connection (ADR 0114), so a
library can only be one the app already ships: it is inlined as text, by name, where the page asked
for it. Three shipped that way. Carrying more meant the name list, the sources, the guide's block and
the host's refusal all had to agree, and a hand-kept copy in each was a page that draws a hole the bot
never hears about.

So the app holds one catalogue — a library's name, package, source path, global, measured size, and
any stylesheet or setup prelude it needs — and generates from it the guide's library block and
`plugin/canvas/libraries.json`, the names the host refuses by. A page still asks with
`<script data-canvas-lib="NAME"></script>`; the app fetches one chunk per asked name, so a page that
asks for nothing pays nothing, and a name the host does not carry refuses the write, naming it, while
a version stored before that still draws.

Three ships no browser build as of 0.187 (`build/three.min.js` is a 404), so the build bundles it to
one IIFE under `THREE` rather than widening `script-src`. Leaflet's stylesheet and marker images
become `data:` URIs, which `img-src data:` already allows and `about:srcdoc` requires, and its entry
carries the setup prelude that points the default marker at them.

Considered and rejected: loading a library from a CDN at render (needs `script-src` and `connect-src`,
and hands a stored version's behaviour to a vendor who can change it); `blob:` module injection (the
same policy widening for the same gain); a hand-kept list per consumer (the fourth copy is where it
breaks); a host route serving sources (needs `connect-src` by design).

The guide is the binding constraint: seven names and every rule it already taught measure 3,956 of
the host's 4,000 characters, so an eighth library needs a section moved out of the guide before it
can be named there.
