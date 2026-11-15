# Rehearsal: Gots hero (GotsHero.tsx)

Gold: `device-pair` for the layout (window pinned top-left and off the bottom, phone straddling its
right edge a third outside, lock screen with `stack="top"`), `ai-chat` for the thread (Collapse
drop from below, a one-line Thinking, Stream for the reply). Changed: a sidebar window with Gots's
bots, the app's green and composer, a pull request pill, a push instead of a payment.

Beats: new chat with Byte → the ask typed and sent (the title rolls from New chat to the chat's
title) → Thinking, Thought for 6s → Running tests to Ran 3 commands while the cursor leaves (the app
is put away) → the reply streams, Draft #214 · Checks passing → the phone's push → hold 2.6s →
the cursor comes back and opens a new chat (the visible cause of the reset). Loop about 13.6s.

Poster (reduced motion): the payoff, with the reply, the pull request and the push on screen.

Captured: 1040 wide in the skill's preview and on the built site at 1280, 390 (the compact
design: no sidebar, the window off the right with its own new-chat button, the phone on the
gutter under the composer), dark on the site.

Gate: `rehearsal passed` in the skill's preview at both widths. On the built site the gate reports
six `kit override` lines.
Film: `kit override` (6) → every frame → stands: film-checks.mjs decides a sheet is the kit's by
its path containing `/kit/`, and Astro bundles the kit's CSS into `/_astro/index.*.css`, so the
kit's own phone rules read as the example's. No rule in `gots.css` touches a kit part.
`settle snap` on `ss-field__value`/`__chars` while typing → the type beat → stands: each typed
character adds width; the gold's field doesn't flag it, nothing visible hops.
`small text: now at 9px` (compact) → the push → stands: the phone at a 16px gutter is 326 wide,
and the next size up runs it off the stage or onto its edge.

Assumptions: Byte is the bot, its greeting is one of its own lines (`app/src/components/bots.tsx`);
the app's icon is `app/public/pwa-192x192.png` (served as `/app-icon.png`).
Unresolved: in the compact payoff the ask has scrolled up out of the thread; the title says it.
Not checked: Safari and Firefox; a slow network's first paint (the box is held at the scene's
aspect ratio until the island mounts); a fresh-eye review by a second reviewer.
