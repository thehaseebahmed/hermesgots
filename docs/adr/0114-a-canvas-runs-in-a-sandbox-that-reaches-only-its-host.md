# A canvas runs in a sandbox that reaches only its host, and declares the tools it calls

**Supersedes [ADR 0102](0102-an-app-may-call-tools-and-its-consent-is-read-off-its-own-source.md)**
(2026-11-07, #920).

A canvas is JavaScript a model wrote. A static scan can't contain that code, because `eval`, `atob`
and a URL built from pieces all defeat one. So the box the page runs in is the boundary, and the
host is the only door out of it:
- **The frame:** `<iframe sandbox="allow-scripts" srcdoc>` without `allow-same-origin`. The page gets
  an opaque origin, so it can't read the app's storage, cookies or keys.
- **The frame's CSP:** injected as the first element in its head. It allows no connections, no frames
  and no form posts. `RTCPeerConnection` is removed before the page's own scripts run.
- **The parent's CSP:** the app's own page carries `frame-src 'self'`. Without it, a sandboxed frame
  can still leak its data by navigating itself to an outside URL. Checked in Chromium on 2026-11-07:
  the leak happened with no parent policy and was blocked with this one, and the `srcdoc` page still
  ran. Safari is unchecked.
- **Libraries:** a vetted set (a chart library, a date library, icons and Tailwind) ships in the app
  bundle and is inlined at render, so the page needs no CDN. This also keeps minified third-party code
  out of `plugin/`, which Hermes's install scanner reads file by file. Chart.js, Day.js and lucide
  answer an empty `<script data-canvas-lib="NAME">`; a name the app doesn't carry is dropped. Tailwind
  is not inlined as a runtime: the page's classes are compiled in the app with Tailwind v4's own
  `compile()`, over the app's tokens as the theme, and the result is injected as plain CSS. The base
  is Tailwind's own stylesheet, preflight included, so a canvas that uses utilities behaves as a
  Tailwind page does — and an existing version, whose markup never changes, draws with the app's
  current base rather than the one it was written against. `dark:` is the app's mode, put on the
  page's `html` as a class, not the operating system's.
- **The bridge:** the page reaches anything only through a `postMessage` bridge. The parent answers
  only its own frame. A read of the canvas's data is answered from the device's copy
  ([ADR 0113](0113-a-canvas-is-its-bots-record-edited-only-through-its-own-session.md)); a write, and
  a call to a declared tool, goes to one host route, which enforces the rules below. Every call
  carries the epoch of the page that asked, so a reply can only settle a promise of the page it
  answers.

**Consent is declared, not derived.** ADR 0102 read an app's tools off its source, which openui-lang
allowed and JavaScript doesn't: the parser reported every call, so an app could not call something it
never wrote. A canvas's bot declares its tools as an argument when it writes a version, and the host
stores the list with that version. A call outside the list is refused. The first call of a declared
tool asks the user in an Android-style dialog, one tool at a time, Allow or Don't allow. The answer is
kept on the host for every device, and the user can change it later in the canvas's options. The
rejected alternative was a list inside the HTML, which any find-and-replace edit could change without
anyone noticing.

**The four host shapes stay free.** A canvas reads usage, routines, projects and sessions without
declaring or asking, as ADR 0102 had them; the user chose this. The consequence is that any canvas can
read the user's chat titles, and one granted an outbound tool could pass them on.

**The canvas's own data is free too, and capped.** A page's `data.put` and `data.remove` write the
canvas's own store and read nothing of the user's, so they are answered without a declared tool or a
consent; a declared tool is still what reaches anything else. The whole of a canvas's data is capped
at 1 MB and a write past it is refused whole, naming the cap, with each document counted beside the
content a read carries for it; a collection or a document id is a name of at most 64 characters. The
cap is the canvas's because the whole of the data rides every open and every device's copy.
