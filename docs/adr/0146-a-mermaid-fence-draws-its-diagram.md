# A mermaid fence draws its diagram, wherever the app draws markdown

A reply that answered with a sequence diagram drew a code block: the fence's label, its copy control,
and forty lines of `sequenceDiagram` where the reader wanted the picture those lines describe. The
model had written the one shape markdown gives a diagram, and the app had no rule for the fence —
every fence but `openui-lang`, which had one, went to `CodeBlock`.

**So a closed ```` ```mermaid ```` fence draws its diagram where the fence stood.** `mermaidParts`
(`app/src/lib/mermaid-fences.ts`) tiles a markdown text into the stretches it shows as they are and the
fences it holds; `Markdown` (`app/src/components/chat/markdown.tsx`) draws each of those through
`Diagram` (`app/src/components/chat/diagram.tsx`). That one renderer is where all thirteen call sites
draw through, so a reply, a session's thread, the user's own bubble, the thinking sheet, room chat and
the docs demo pages carry a diagram alike, and a diagram cannot draw on one surface and stay code on
another. The frame names itself `[data-slot=diagram]` and carries no `data-md-code`, since that marker
is what the rest of the app — eight tests and two flows — counts as a block of code.

**The rule is a fence rule in `Markdown`, not a branch in react-markdown's `code` hook.** The hook is
handed a fence's body with no position: it cannot tell a fence that has closed from one still arriving,
nor a list item's example from a fence at the margin, and it is handed an inline code span the same way.
Its component map is also built once per tone, so no per-block answer can be given there. What the
decision needs is the text's own lines and columns, and the rule is what reads them.

**Only a closed fence draws.** An opener in the first column whose info string is exactly `mermaid`, and
a closer that has arrived. Anything else is the code it is: a fence still streaming, one set into a list
item, one quoted, one inside another fence, `mermaid extra`, `Mermaid`, a four-space indent. So a reply's
fence draws once the stream reaches its close and not before — which is also why a streaming reply
fetches nothing: the frame is never mounted for an open fence, and no import is asked for on its way in.

**mermaid is asked for on an effect, never imported at the top.** The wait is the fence's own: the code
block is already drawn and the drawing replaces it where it stands, so nothing is empty and nothing
flashes back. A chunk that cannot be fetched takes the same path as a source that will not parse, which
is one fallback rather than two.

**The colours go in as hex.** mermaid's directive sanitiser drops any value matching neither
`[\d "#%(),.;A-Za-z]` nor a plain colour, so `var(--border)` never arrives at all, and its colour
arithmetic reads hex where the app's tokens compute to `oklch()`. `toHex` (`app/src/lib/theme.ts`) is
applied where each token is read — off the element the diagram stands in, since the tokens are custom
properties and inherit down to it — and `mermaidTheme` (`app/src/lib/mermaid-theme.ts`) maps them onto
the `base` theme's variables, one per colour a box, a word, a connector, a label, a note and a section
is drawn in. The surface is the first painted solid behind the frame, because a frame in a bubble is a
wash of the words' own colour and a wash has no hex mermaid could draw on.

**`securityLevel: "strict"`, and `htmlLabels` left at mermaid's default.** A diagram is a model's markup
drawn inside this document, so its labels are sanitised. `htmlLabels` stays on because a model writes
`<br/>` and long labels in its diagrams, and losing that wrapping costs more than the CSS isolation a
`foreignObject` gives up — the svg is in the app's own document either way.

**One global config, so one drawing at a time, and one id per drawing.** `initialize` writes mermaid's
one config, so two diagrams drawing at once would each be drawn in the other's colours: renders are
serialised, and a render that failed must not hold the queue behind it. Each frame mints a DOM-safe id —
`useId`'s colons are no DOM id, and mermaid selects the svg it draws by the id it is handed — and the
sheet a tap opens holds the same string under a name of its own, since mermaid removes an element by the
id it was given and the thread's drawing is the first of the two.

**A source mermaid will not parse draws its source, with one quiet line.** The line is mermaid's own
words where it refused the source, and one plain sentence where the chunk never arrived: never a stack
trace, and never mermaid's error graphic, which is switched off (`suppressErrorRendering`). The block is
the one `CodeBlock` the fence would have been, on the tone it stands on.

**The chunk is a path, not a name.** The build names every chunk carrying a module of mermaid's packages
under `assets/mermaid/` (`app/vite.config.ts`), the service worker leaves that path out of the precache
and holds it in one cache-first route with a bounded lifetime, and `app/scripts/check-mermaid-chunks.mjs`
— run from `.github/scripts/checks.sh` — asserts that the entry chunk carries none of mermaid, that every
chunk of mermaid's is under that path and nothing else is, that the precache manifest names none of them,
and that exactly one route answers them. A hashed file name changes with every mermaid release and could
be matched by neither the exclusion nor the route; they cannot be forced into one chunk either, since each
diagram type is a lazy import of its own.

## Considered options

- **Drawing from the `code` hook.** It is the shortest path and it cannot answer the question: the hook
  sees a body, not a position, so an arriving fence would draw as soon as its first line landed, and a
  list item's example would draw as a diagram.
- **A second splitter beside `openuiParts`.** `openuiParts` already cuts a reply into its text and its
  `openui-lang` blocks, and a reply may hold both kinds. One rule grown to answer two features would make
  every change to either a change to both, and a reply holding both would need the fold's order decided
  inside it. `Markdown` asks each rule for its own parts over the text it was given instead.
- **`mmd`, `diagram`, or the info string matched case-insensitively.** The info string is the one thing a
  model writes, and `mermaid` is the name the whole diagrams ecosystem writes. An alias is a second name
  nobody asked for, and it would make the rule's own promise — exactly `mermaid` — untrue. An alias that
  arrives draws as code, which is visible, copyable and fixable.
- **Rendering on the host and posting an image.** A host would need a headless renderer, a per-fence call
  and a cache of its own for a picture the app already holds the source of, and the diagram would stop
  drawing when the host was away.
- **A rasterised image, a `data:` URL.** It needs a rasteriser, it loses the app's colours on a theme
  flip, and a picture cannot be panned at its own width the way the svg can. The non-goal was an export;
  this is the same picture arriving early.
- **mermaid's own `dark` and `default` palettes.** They follow the app's mode and nothing else, so a
  diagram would be a second palette on the same screen. The `base` theme with the app's own tokens is
  what makes a diagram read as part of the sentence it sits in.
- **Precaching all of it.** Every reader would pay the whole 5049 KiB at install for a feature most of
  them never see, and the install is what a phone pays for on a connection it may not have chosen.
- **Telling agents to write mermaid, through `plugin/replies.py`.** The user declined it: the request is
  that fences already arriving draw, and a section in every session's prompt would be charged on every
  turn to ask for something nobody asked for.

## Costs

- Importing mermaid costs 162KB gzipped — its 19-chunk static closure — and the first flowchart brings
  that to 184KB gzipped. On a slow connection the fence sits as its own source for a moment; it never
  flashes, because the code block is already drawn and the drawing replaces it in place.
- Every diagram type together is 5049 KiB raw across 89 chunks, about 1.45MB gzipped. The build puts all
  89 under `assets/mermaid/`, and the install's precache holds 164 entries with none of them — 253 entries
  without the rule, and that 5049 KiB on the install. If the exclusion drifts, it lands on every reader at
  install: the gate catches it at build time, and nothing catches it at deploy time.
- The split sits beside `markdownBlocks`, which keeps a text whole when it holds link or footnote
  definitions. A text with a definition above a diagram and its use below is split across one — the same
  hole `openuiParts` already has.
- jsdom has no layout and mermaid measures a diagram with `getBBox`, so the component tier can pin the
  frame and the fallback only; the drawing itself is the sweep's. The sweep runs against the dev server,
  which registers no service worker, so the offline half is proved by the gate reading the built worker
  rather than in a browser.
- `securityLevel: "strict"` sanitises labels, so a source that writes HTML in one draws plainer here than
  where it was copied from. `htmlLabels` on means a label is page HTML in a `foreignObject`, so the
  drawing is not a self-contained image — export is a non-goal, so nothing depends on that today.
- A theme flip redraws each visible diagram once, and a streaming reply's fence changes height the moment
  it closes, so what is below it moves: once, at the close.
