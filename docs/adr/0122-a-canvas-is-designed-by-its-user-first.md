# A canvas is designed by its user first, and its sandbox keeps the page it was given

**Amends [ADR 0113](0113-a-canvas-is-its-bots-record-edited-only-through-its-own-session.md) and
[ADR 0114](0114-a-canvas-runs-in-a-sandbox-that-reaches-only-its-host.md)** (2026-11-09).

A canvas is the user's page, so the guide told to its session now says so first: a named look, brand,
palette, font or reference *is* the design, and everything Gots says below that is a floor filling only
what the user leaves unsaid. The floor is the app's own: one surface doing one job with a real
hierarchy, its empty, loading and error states, the theme tokens and the compiled classes, 390px first
with 44px targets and 16px typed text, and no explanatory copy. This is the same order ADR 0113's last
paragraph promised — the user's own design skills and preferences win — written where a bot reads it
before it writes a page, rather than as a caveat at the end.

**A bot that wants more than the floor loads one of three bundled skills.** `plugin/skills/` carries
`impeccable` (curated to its craft floor and its four modes, its detection engine and `/impeccable`
commands left out), Vercel's `web-design-guidelines` with its rules beside it instead of fetched, and
the whole `transitions-dev` collection with its own licence, so a review reads no network and a canvas
session can be precise about the thing it is unsure of. They are registered with
`ctx.register_skill`, each guarded, each carrying the description from its own frontmatter — Hermes
lists a skill by what it was registered with, so a bare name would be a row with nothing under it.
`DESIGN.md` at the repository root is the app's design system in the format agents read, and
`plugin/canvas/DESIGN.md` is the same bytes, because a plugin is installed without the repository; a
test holds the two together and the linter holds the spec to no errors and no warnings.

**The sandbox stops taking the page away.** Two things the frame used to do badly are fixed in the
head the app injects, not by asking a bot to work around them:
- **A form's submit stays on the page.** `form-action 'none'` refuses the navigation a submit asks
  for, so the reader was left on a refusal with the page's state gone. A bubble-phase `submit`
  listener on `window` cancels the default only when the submission is still unprevented: every
  handler the page put on the form, a field or the window runs first, and a page that prevented the
  submit itself is left alone. The policy does not move; this cancels a navigation, it never permits
  one.
- **An `http(s)` link opens in the app.** A trusted click on the nearest `<a href>` whose attribute is
  an absolute `http` or `https` URL cancels the click and posts one `open` call, which the bridge
  accepts only through `new URL` with no base and only for those two schemes, and the screen opens
  through `openExternal` — the platform's browser on Android, a tab with `noopener,noreferrer` on the
  web. A click the page already answered itself is left alone. `open` is not on `window.canvas`, so the
  API a page is offered has no way to ask it; that is a shape, not a fence, since a page's own script
  can post the same call and nothing on this side can tell a tap from a script. What is enforced is the
  scheme — the app opens `http(s)` and nothing else — and the frame: only this screen's own frame is
  heard. `mailto:`, `javascript:`, `data:`, `blob:`, relative and `#hash` links stay in the frame,
  where they are the page's own business.

**A write answers with the guide's advice.** `canvas_write` and `canvas_edit` carry `warnings`: a
`<form>` with nothing handling its submit or a click inside it, and a width past the 390px phone set on
an element's own `style`. They are advice and never a gate — the version is stored either way, because
`scan` is what refuses a write and these are what the guide would have said. Deliberately absent is any
rule about colour: a user's named palette is the design, and a rule that argued with it would be the
guide overruling what it puts first. So is anything the markup cannot decide — a 44px target, an empty
state — because a warning a bot cannot act on is noise, and one that fires on the guide's own advice
(its 768px breakpoint, its button click) teaches a bot to distrust all three.

The cost of the choice is that the guide has 18 characters of headroom under the host's 4,000 (a
section over it is dropped whole, and the app hides Canvas when its section is missing), that a page's
own script can ask for a link to open — the scheme is what is enforced, not a proven tap — that the
vendored skills are snapshots with no updater and duplicate names a host may already ship, and that a
tab opened from a message handler can still be popup-blocked on the desktop web. A consent question per
link, a fourth skill holding the spec, and renaming the bridge's transport were all considered and left
out: each is a surface this change does not need.
