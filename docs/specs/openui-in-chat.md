# OpenUI in the chat thread

Status: grilled 2026-10-21, every decision settled and recorded in ADRs 0031, 0032 and 0033. The
tickets at the end are the build order.

## Goal

A reply can carry an interface, drawn from Gots's own components, and a reply that can't be drawn is
still the reply it was.

That is the whole feature: no second chat shell, no new screen, no new storage. If a reply has no
interface in it, nothing about the thread changes.

## What this is not

- **Not the Agent Interface SDK, Gateway or Autofix.** `@openuidev/react-ui`, `@openuidev/react-headless`
  and the cloud fixing services would each bring their own chat surface or a server we don't own. The
  app draws what arrives, and an unrenderable block falls back to the code the model sent.
- **Not interactive in v1.** Read-only: cards, tables, lists, callouts and charts. No `onAction`, no
  forms, no `Query`/`Mutation`, no `toolProvider`, which is also why the optional
  `@modelcontextprotocol/sdk` peer stays uninstalled.
- **Not a message kind and not a stored tree.** No Dexie bump, no sync change, no history change.

## Decisions

1. **The wire format is a fenced block, info string exactly `openui-lang`, inside the reply's text**
   (ADR 0031). `media-tags.ts` sets the precedent: something the model writes inline, split out by a
   pure rule before the text reaches the markdown renderer. The transcript stays the only store, and
   the fallback is free because the markdown renderer already draws an unknown fence as code.
   The fence name is OpenUI's own: `library.prompt({ inlineMode: true })` tells the model to wrap
   `openui-lang` in triple-backtick fences.
2. **A reply may carry any number of interfaces**, drawn in the order they appear, with the reply's
   text between them.
3. **A block whose id is already in the thread is a patch.** It changes that interface, draws in that
   interface's place, and draws nothing of its own. A patch whose id is in no thread draws as code.
4. **An interface's id is a first-line comment inside the Lang** — `# id: sales` — which the parser
   strips (`stripComments`) and the fold reads. Optional: a block with no id is a new interface that
   can never be patched.
5. **While it streams, an interface draws partially, root first**, filling in as the data arrives,
   which is what OpenUI's streaming exists for. Before a root can be parsed there is nothing in its
   place: the gap reads as still typing.
6. **Anything that can't be drawn draws as the code the model sent**: an unknown component, a
   validation failure, a patch naming nothing, a block that parsed and then broke. Nothing is
   swallowed and nothing is half-drawn. Each fallback is noted at the console's verbose level
   (`report.ts`) and nowhere in the thread.
7. **Every assistant reply `MessageItem` draws gets this**, in a chat and in a project session alike.
   One rule, no surface list to maintain.
8. **The component library is Gots's own**, hand-written over shadcn/Base UI (ADR 0032). Charts are in
   v1 through `pnpm dlx shadcn@latest add chart` (Recharts), imported lazily inside the chart
   component alone. A chart requires a short `summary`, because it is a picture in a reply that may be
   read aloud. A table's cells are plain text: no markdown, no links.
9. **The library is generated into a system-prompt section** (ADR 0032): written once as TypeScript, a
   script emits the artifact, the plugin registers it with `ctx.register_system_prompt_section`, and a
   drift test fails when the two disagree.
10. **The Appearance switch is profile-wide and written to the host** (ADR 0033). Off stops both
    halves: the app draws a block as code, and the next chat is not told the library at all.

## Dependencies, as verified against the registry

- `@openuidev/react-lang@1.0.1` (MIT). Peers: `react` and `react-dom` present already; `zod`
  `^3.25.0 || ^4.0.0` is required and new to this app; `@modelcontextprotocol/sdk` is optional and
  stays out.
- What the app uses, from the real export list: `defineComponent`, `createLibrary`, `Renderer`,
  `parseMessage`, `mergeStatements`. `Renderer` takes `response`, `library`, `isStreaming`,
  `onParseResult`, and the action/query props this spec leaves unset.
- `createLibrary({ components, componentGroups, root })`; a component is
  `defineComponent({ name, props: z.object({...}), description, component })`.
- The package's JS is about 48K across `index.mjs` and one shared chunk: a lazy import, like the
  markdown renderer.
- Pin `@openuidev/react-lang` and `@openuidev/lang-core` exactly. Their versions move together and the
  prompt artifact must match the renderer that parses it.
- Hermes bounds a plugin system-prompt section at 4,000 characters
  (`DEFAULT_SYSTEM_PROMPT_SECTION_MAX_CHARS`), renders it once per session, freezes it into the stored
  prompt and restores it verbatim on resume. Compression leaves the system prompt alone.

## Where it lives

| Path | What it is |
| --- | --- |
| `app/src/lib/openui-block.ts` | The extraction rule: pure, import-free, splits reply text into text and `openui-lang` parts, with an id when the block carries one. `scripts/test-openui-block.mjs` |
| `app/src/lib/openui-thread.ts` | The fold: a conversation's parts in, each interface's resolved source out. Pure. `scripts/test-openui-thread.mjs` |
| `app/src/components/openui/openui-block.tsx` | The lazy, memoised renderer: `Renderer`, the streaming draw and the fallback ladder |
| `app/src/components/openui/library.tsx` | The component library: the single source of truth for what a model may draw |
| `app/src/components/openui/chart.tsx` | The one heavy component (Recharts), lazily imported |
| `app/src/components/settings/appearance.tsx` | The switch, where Appearance already lives |
| `app/scripts/build-openui-prompt.mjs` | Writes the prompt artifact from `library.tsx`, refusing past 4,000 characters |
| `app/scripts/test-openui.tsx` | Component tests: an interface, a fallback, a patch in place, an orphan patch |
| `app/scripts/e2e/openui.mjs` | The flow: an interface at 390px and 768px, a fallback, a patch that doesn't move the reader's place |
| `plugin/openui.py` | The system-prompt section, the stored switch and its route |
| `plugin/openui/prompt.txt` | Generated. Read by the section renderer |
| `docs/adr/0031-an-interface-lives-in-the-reply-text.md` | The wire format, the fold, patches |
| `docs/adr/0032-the-component-library-is-written-once-and-told-by-the-host.md` | The library, its artifact, charts, tables |
| `docs/adr/0033-the-interface-switch-is-a-host-setting.md` | The switch |
| `GLOSSARY.md` | **Interface**, **Component library** (under Generative replies) |

## The extraction rule

`openuiParts(content)` returns `{ kind: "text", at, text }` and
`{ kind: "openui", at, source, id?, open }` parts in content order, and `toParts` in
`message-item.tsx` gains that kind beside `media`, `tools`, `clarify` and `agent`.

- A block opens on a fence of three or more backticks or tildes, indented at most three spaces, whose
  info string is exactly `openui-lang`. Anything else is text.
- Its body runs to a closing fence of the same character, at least as long as the opener, on a line of
  its own. Reaching the end of the text without one is an **open** block: `open: true`, which is what
  a reply still streaming looks like.
- The body's first non-blank line may be `# id: <slug>` (`[a-z0-9-]{1,40}`). That is the block's id;
  the line stays in the source, since the parser strips it anyway.
- A block inside another fence is never extracted: a reply that shows Lang as an example keeps showing
  it as code. The scanner tracks fences the way `markdown-blocks.ts` does.
- Extraction applies to an assistant reply only. Queued, steered and user bubbles are untouched.
- Text between and after blocks keeps its order.

## The fold

`resolveInterfaces(messages)` reads only the interface-bearing parts of a conversation, in thread
order, and answers what each one draws:

- an id seen for the first time is a new interface; its source is what it draws;
- an id already seen is a patch: `mergeStatements(existing, patch, id)` becomes that interface's
  resolved source, and the patch part draws nothing;
- an id that is nowhere earlier in the thread is an orphan: it draws as code.

The fold is pure and runs at render, over the few messages that carry blocks. A row memoises on its
resolved source, not its own text, so a patch that changes one interface re-renders that row and no
other. Nothing about the fold is stored: a synced chat, a re-loaded one and one imported from the host
fold the same way, because they carry the same text.

## Rendering, and the fallback ladder

The block is a lazy import, memoised on its resolved source.

- No fence: nothing changes.
- An **open** block with no root yet: nothing, and the gap reads as still typing.
- An **open** block that has a root: the partial interface, filling in.
- A closed block that validates: the interface.
- A closed block that validates and names an id already in the thread: the patch, applied in place,
  drawing nothing where it sits.
- Any block that can't be drawn — unknown component, validation error, orphan patch, an open block in
  a reply that has stopped — the fenced source as code, with its language label.
- A block that drew and then failed on a later flush: back to code. Lang is append-only, so a failure
  means the block broke, and saying so is more honest than holding a stale tree.
- No height cap and no inner scroll: a tall interface scrolls with the thread. An inner scroller in a
  bottom-anchored thread is a trap on a phone.

## Component library v1

Root `Stack`. Read-only, theme tokens only, no hard-coded colour, legible at 390px before it is pretty
at 768px. Seven components, which still fits the host's 4,000-character section: the artifact measures
3,789 characters with the map's signature in it, 211 characters of room left.

| Component | Props | Drawn with |
| --- | --- | --- |
| `Stack` | `children` | A plain column with the thread's spacing |
| `Card` | `title`, `body?`, `children?` | `ui/card` |
| `Table` | `columns: string[]`, `rows: (string \| number)[][]`, `caption?` | `ui/` primitives, `overflow-x` inside the bubble, never the page. Cells are plain text |
| `List` | `items: { label, detail? }[]`, `ordered?` | The thread's list treatment |
| `Callout` | `tone: "info" \| "warn" \| "good"`, `text` | `ui/alert` |
| `Chart` | `kind: "bar" \| "line" \| "area" \| "pie"`, `series`, `xLabel?`, `yLabel?`, `summary` (required) | `chart.tsx`, Recharts, lazy |
| `Map` | `points: { lat, lng, label, detail? }[]`, `summary` (required) | `map.tsx`, Leaflet over theme-aware CARTO tiles, lazy; pans and zooms once tapped (ADR 0039) |

No explanatory captions: the components say what their data says.

## The host side

- `build-openui-prompt.mjs` writes `plugin/openui/prompt.txt` from
  `library.prompt({ inlineMode: true, toolCalls: false, bindings: false, builtinFunctions: false })`,
  plus the rules this app adds through `additionalRules`: the fence is `openui-lang`, a new interface
  carries a fresh `# id:`, a change reuses that id in a patch block, and a table's cells are plain
  text. The script fails when the artifact passes 4,000 characters.
- `plugin/openui.py` registers the section with
  `ctx.register_system_prompt_section("openui", content, position="after_memory")`, reading the
  artifact at import, and advertises `openui` in `info`'s `features` with the artifact's version.
- The switch is a plugin setting: `GET openui` answers it and `POST openui` writes it, and the section
  renderer returns nothing while it is off. The app reads it before drawing and writes it from
  Appearance (ADR 0033).
- If `prompt_builder.py` moves for any of this, regenerate `docs/prompts.md` with
  `python3 plugin/scripts/generate_prompts_doc.py`.

## Budget and measurement

- Extraction and the fold are string work on render, off the write path. `chat.ts` is not touched.
- The cost to measure is the open block re-parsed per flush plus the fold over a conversation's
  blocks: CDP `ScriptDuration` while a reply with a growing block streams, before and after, with the
  numbers in the pull request.
- `pnpm e2e stream-writes` and `pnpm e2e idle-requests` must not move.
- The build's chunk list must show `Renderer`, Recharts and the library in lazy chunks, never in the
  chat route's entry chunk. Asserted in the pull request.

## Tests

Cheapest tier that would fail for the reason the change can fail (ADR 0019):

- **Unit** — `test-openui-block.mjs`: no fence; one block; two with text between; unterminated; a
  longer closing fence; `~~~`; a block inside another fence not extracted; a fence in a list item; an
  info string of `openui-lang ` or `openui` not matching; an id read from the first non-blank line; a
  malformed id ignored. `test-openui-thread.mjs`: two independent interfaces; a patch applied to the
  one it names; a patch to an earlier of three; an orphan patch; a patch whose merge fails to parse;
  ids that differ only by case.
- **Component** — a reply with a valid block shows the card's title and no `<pre>`; a reply whose block
  doesn't parse shows the source in a `<pre>`; a reply with no block renders exactly as before; a
  streaming reply shows nothing, then the shell, then the filled interface; a patch in a later reply
  changes the earlier card and shows nothing where it sits; an orphan patch shows as code.
- **End to end** — `scripts/e2e/openui.mjs`: the test host's chat carries an interface and a fallback;
  the flow asserts the interface at 390px and 768px with a screenshot, the fallback as code, that the
  reply reaches its end, and that a patch arriving while the thread is scrolled up does not move the
  reader's place. Geometry and scroll anchoring are what a DOM without layout can't reach, which is
  the argument for the tier.
- A row and a verdict in `docs/e2e-flow-audit.md`; `scripts/test-e2e-registry.mjs` fails without one.

## Gates

From `app/`: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Then `pnpm e2e openui`,
`pnpm e2e stream-writes`, `pnpm e2e idle-requests`. From the root: `python3 -m unittest discover -s
plugin/tests -t .` once the plugin moves.

## Tickets

On the tracker: #384 is the spec, and its seven children are the build order — each titled the
commit that lands it, each carrying the issue its edges name as a native blocker. Work the frontier.

1. #385 `feat(chat): read an interface out of a reply` — `lib/openui-block.ts`, its unit test. Edge: none.
2. #386 `feat(chat): fold a thread's patches onto their interfaces` — `lib/openui-thread.ts`, its unit
   test. Edge: 1.
3. #387 `feat(chat): draw an interface from gots' components` — the library, the renderer, the
   streaming draw, the fallback ladder, `toParts` and `MessageItem`, component tests. Edge: 1, 2.
4. #388 `feat(chat): chart an interface` — `chart.tsx`, the chart component with its required summary,
   the chunk assertion. Edge: 3.
5. #389 `test(chat): prove an interface in a real thread` — the test host's replies, the e2e flow
   including the scroll hold, the audit row. Edge: 3, 4.
6. #390 `feat(plugin): tell the model the component library` — the artifact, the drift and
   4,000-character tests, the system-prompt section, the feature. Edge: 3.
7. #391 `feat(settings): switch interfaces off from appearance` — the switch, the plugin's route and
   stored flag, the app's drawing gate, new chats only. Edge: 6.

## Risks

- **A patch changes content above the reader.** The e2e flow owns the scroll assertion; if anchoring
  still slips, the mitigation is for the fold to hold a patched interface's height until the reader
  returns to the bottom, not to stop patching in place.
- **Version coupling.** `react-lang` and `lang-core` pin together, and the artifact regenerates when
  either moves. A stale host shows up as a fallback rate, not a broken thread.
- **The 4,000-character ceiling.** The library has to stay small enough to describe; the script fails
  the build rather than letting a section be silently truncated.
- **An id reused by accident patches rather than adds.** The prompt asks for a fresh id per new
  interface; a collision is the same rule working as designed, and the fallback makes a bad merge
  visible.
- **Recharts' size.** Lazy and isolated to the chart component; if it still costs too much on a phone,
  a table is the fallback the library already has.
- **A model that never emits the fence** simply never produces an interface. That is a prompt problem,
  and it never degrades a thread.
