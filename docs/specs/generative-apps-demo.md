# Generative apps: the demo

**Superseded by [ADR 0113](../adr/0113-a-canvas-is-its-bots-record-edited-only-through-its-own-session.md)** (2026-11-07): Apps are replaced by canvases (#920), and the implementation this spec describes is gone.

Status: settled by wayfinder map #810 — every decision below is one of its closed tickets, and this spec reopens none of them.

## Problem Statement

The component library exists, and the only place to see all of it at once is a reply that happens to use it. Someone who has the app set up and a bot connected can ask for a page and receive one, but cannot look up what the components are, what they look like drawn, which props they take, or what a valid block is shaped like. That is a strange gap in a feature whose whole proposition is that the bot draws: the person commissioning the drawing cannot read the vocabulary it is drawn in.

The failure is worse than the gap. When a block draws as code, nothing tells the person whether the component does not exist, a prop is spelled wrongly, or the ask was a bad one. Falling back to the source is correct and unhelpful at the same time — source is the one thing a person who does not read Lang cannot use.

Underneath both is a copy problem. The rules the schema cannot express — that a chart needs a summary because it may be read aloud, that a table's cells are plain text — are written into the prompt the model is given and nowhere a person can read them. Written again for a screen they would drift; written only for the model they are invisible to the person who has to ask in their own words. A screen that listed components and props by hand would drift from the library in the same silence, with every test still green.

Learning by asking is expensive in the currency that matters. A block that draws wrongly costs a build run and an answer to read, and there is nowhere to try a shape of one's own without commissioning it — no field to paste into and see. The two built-in apps are the only demonstration of these components in combination, and they demonstrate an app rather than the vocabulary: someone who wants to know what a Callout looks like still opens one and hopes it uses a Callout.

The repository has already answered the shape question once. The demo screen for markdown exists because the thread's look has no second copy: it is a lazy route of its own, it draws its subject with the production components at a reply's own measure, and a component test draws it again on every run. The component library needs the same thing, for the same reason.

## Solution

A component reference: an ordinary screen at `/docs/open-ui`, inside the gate every other screen passes through, because its audience is someone who already has the app set up. Nothing about it is published. It takes the demo screen's shape — a back control, a heading, one column at a reply's measure — and not its door: the markdown demo sits behind Developer's switch because it is a tool for whoever changes the renderer, while this screen is for whoever uses it.

Every component in the library gets one entry, in the library's own order. An entry carries the component's name, the library's own one-line description where it has one, a live drawing, the Lang that drew that drawing, and the props the library's schema declares — their types, whether they are required, and the values an enumeration allows. The drawing and the Lang are the same string, drawn through the path a reply already uses, so a reader can never be shown one thing and handed another.

The rules the schema cannot express live in one module that the prompt builder and this screen both read. What the model is told and what the person is shown are therefore the same sentences, which is the point: a rule clear enough for a person is a rule clear enough for a model, and neither copy can move without the other.

The examples are hand-written, one per component, each the smallest true thing that component can do. They are proven by the screen's own component test, which draws every one of them through the real library — so an example that stops drawing fails a gate rather than a reader.

At the foot of the screen, a playground: paste a block, see it drawn. It keeps nothing — no store, no host write, no draft restored on return — and a block that does not parse is drawn as the error it is, in words, beside its own source, never as an empty frame.

Nothing on the screen is a mock. Every drawing is the production component, every prop row is the schema, and every rule is the module the prompt is built from, so a reader who copies an entry gets the thing they saw and a maintainer who changes the library changes the reference in the same commit. That is what makes the screen worth trusting at a glance, and it is why it can be dull: its whole job is to be the library, once.

The demo's cast is the two built-in apps: a Home Assistant dashboard and a GTD app over Todoist, whose pages draw these components in combination. The screen names them and points at Apps rather than reproducing them; their pages, queries, sample labels and consent belong to the built-ins spec.

## User Stories

1. As someone who has just connected a bot, I want to see every component the bot can draw, so that I know what I may ask for before I ask.
2. As someone reading an entry, I want to see the component drawn, so that I judge it by its look rather than by a description of its look.
3. As someone who does not read Lang, I want the drawing first and the code beneath it, so that the code confirms rather than gates.
4. As someone learning the syntax, I want the Lang that drew the drawing beside it, so that I copy a working shape instead of guessing one.
5. As someone copying a block, I want the shown Lang to be the exact source that drew the example, so that what I paste draws what I saw.
6. As someone checking a prop, I want its type and whether it is required, so that I learn the shape rather than learn by failing.
7. As someone checking an enumerated value, I want the values the schema allows, so that a tone or a chart kind is a choice rather than a guess.
8. As someone comparing two components, I want them in the library's order, so that the reference and the prompt agree about what exists and in what sequence.
9. As someone whose block drew as code, I want to look up the component I used, so that I can tell a missing component from a wrong prop.
10. As someone told my chart needs a summary, I want that rule on the chart's entry, so that the correction is where I am already looking.
11. As someone writing a table, I want to be told cells are plain text, so that I do not paste markdown into one and watch it render literally.
12. As someone who wants the bot to draw well, I want the rules here to be the rules the bot is told, so that my instructions and its instructions are one vocabulary.
13. As someone reading on a phone, I want each entry to draw at a reply's width, so that what I see is what arrives in the thread.
14. As someone using a screen reader, I want every drawing to carry its words — a name, a description, a required summary — so that the reference is not a wall of pictures.
15. As someone pasting a block, I want it drawn, so that I can test an idea before asking a bot to build a page around it.
16. As someone who made a typo, I want the error in words beside the source, so that I can fix it rather than stare at an empty box.
17. As someone experimenting, I want nothing kept, so that a pasted block leaves no trace on my device or on my bot's host.
18. As someone pasting a block that calls a tool, I want it to call nothing, so that a reference screen can never act on my house or my tasks.
19. As someone returning to the screen, I want the playground empty again, so that it is a scratch pad rather than a draft I have to manage.
20. As someone whose library moved, I want a new component to appear in its place, so that the reference is never behind the bot.
21. As someone whose library moved, I want a renamed prop renamed here in the same release, so that the screen and the bot cannot disagree.
22. As a maintainer adding a component, I want the screen to fail when my component has no entry, so that shipping one is not done until it is shown.
23. As a maintainer adding a rule, I want to write it once, so that the prompt and the screen cannot say different things.
24. As a maintainer, I want an example that stopped drawing to fail a test, so that a broken example is caught before a person finds it.
25. As a maintainer, I want this screen to draw through the thread's own path, so that the build's chunking stays honest and a chart's library never reaches an entry chunk.
26. As someone who has not set the app up, I want this screen out of reach like every other, so that nothing is published that the app does not serve.
27. As someone curious about the two built-in apps, I want to be pointed at the real ones, so that the worked examples are the ones I can open.
28. As someone with a component that nests, I want to know which parents allow it, so that I do not put a chart where only text goes.
29. As someone on a slow connection, I want the reference to arrive as its own chunk, so that opening it never slows the chat I was reading.
30. As someone reporting a bad drawing, I want to paste the block I was given, so that I can show what broke instead of describing it.
31. As someone quoting the screen, I want the bot's own rules to match it, so that a sentence taken from here is understood there.
32. As the builder, I want the drawing this screen needs settled as criteria rather than as a prototype, so that I know the drawing is mine to make.

## Implementation Decisions

- **An ordinary screen, behind the gate.** The reference is a lazy route inside the setup gate, reached like any other screen and served to nobody who has not set the app up. The original brief's "without auth" is superseded: the audience is someone who already has the app, so there is no public page and no unauthenticated path to build.
- **The demo screen's shape, not its door.** A back control, a heading, a single column at a reply's measure, and content drawn by production components. The markdown demo gates on Developer's switch because it serves whoever changes the renderer; this one gates on setup alone, because it serves whoever uses it.
- **One entry per component, in the library's order.** The order is the order the library registers its components, never alphabetical and never a list kept here. A component added to the library appears in its place; one removed stops appearing; the screen never carries a roster of its own.
- **An entry's drawing and its Lang are one string.** The example is Lang source; the block drawn above is that source passed through the drawn-interface path, and the code below is the same string, not a transcription. Nothing on the screen can show a drawing its Lang does not produce.
- **An entry says where its component may sit.** Which parents accept it, and whether it takes children of its own, is read from the schema's own children union rather than described; a component that stops taking children stops claiming it, in the same commit.
- **The description is the library's, or absent.** Where the library gives a component a description, the entry shows it verbatim; where it gives none, for the components whose props say it all, the entry carries no invented gloss. A gloss written here and nowhere else is a second prompt in waiting.
- **Props come from the schema, rendered rather than typed.** Types, required and optional, array element shapes and enumeration values are read from the library's own schema at render, every prop in the schema's own order with nothing truncated or folded away. There is no props table to maintain, so nothing on the screen can claim a prop the schema does not declare.
- **The rules the schema cannot express live in one module.** The chart's required summary, the plain-text table cells, the fence and the fresh id are written once, in the module the prompt builder already needs, and read from there by the prompt build and by this screen. A rule is added in one place and appears in both, or it appears in neither.
- **The module is the prompt's own words, byte for byte.** Moving the rules out of the build script must leave the generated artifact unchanged and its drift test green; the artifact's 4,000-character ceiling still governs, so a rule is not free on the screen either. A release that changes what the model is told shows as a diff in the artifact, which is the review a wording change deserves.
- **Examples are hand-written, one per component.** Each shows its component doing the smallest true thing, inside the root the library requires and nothing more; no example leans on another component to look good. They are short enough to read at a reply's measure and plausible enough to copy.
- **The screen's own component test proves the examples.** It mounts the screen and draws every entry through the real library, asserting each entry drew its component rather than falling back to code, that every component has an entry, and that the entries are in the library's order.
- **The props drift test is the pattern the prompt artifact already uses.** One source, one generated view, a test that fails when the two disagree: the test reads the schema and asserts the screen shows exactly every component and every prop it declares, with the same types, the same required marks and the same enumerations, and nothing that it does not.
- **The playground draws a pasted block and keeps nothing.** A field takes a block; the drawing sits beneath it. Nothing is written to the device or to the bot's host, nothing is restored on return, and there is no history, no draft and no saved snippet. The map left this open; it is settled here as nothing kept, because a reference that stores things has become an app.
- **The playground calls nothing.** A pasted block's queries are not run and its mutations are not offered: no tool has been consented to for this screen, and a reference is not an app. It draws what it is given and stops there.
- **The playground's field is a plain field.** No code editor, no syntax highlighting and no new dependency: pasting is the only gesture it needs, and a highlighter would be a second renderer of the same Lang, kept in step with nothing.
- **One column, no inner scrollers.** The screen scrolls as a whole; an entry is not a box with a scroll of its own, which on a phone traps the thumb and would clip exactly the wide table a reader came to see.
- **A parse error is drawn honestly.** A block that does not parse draws its error in words with its own source as code beneath, never an empty frame or a frame that never fills. The playground draws on the block it was given rather than on every keystroke, because a half-typed line is a parse error each time, and one error per character teaches nothing.
- **Both new screens reach components through the existing drawn-interface path.** The reference and the playground hand sources to the block a reply already uses, which is the only module that names the chart and map chunks. Neither imports the renderer or the library directly, so the build's chunk assertion stays green: a second import path would duplicate a heavy chunk or pull one into a route chunk, and the assertion fails exactly that.
- **The cast is the two built-in apps.** The Home Assistant dashboard and the GTD app over Todoist are the worked examples of these components in combination, named once and pointed at. The screen copies neither, carries no sample data, and adds no third demo app: their pages, their queries, their sample labels and their consent are the built-ins spec's, and this spec only refers to them.
- **No second look.** Entries use the thread's own measure, spacing and components; the screen adds no frames, no bespoke preview styling and no marketing copy. The reference exists so the look has one copy, and a decorated copy would defeat it.

## Testing Decisions

- **Component — the entries.** Every component in the library has an entry; the entries come in the library's order; every entry's example draws through the real library and none falls back to code; an entry shows the Lang that drew it and that Lang parses on its own. A component added without an entry fails here.
- **Component — the props drift.** The props an entry shows are compared against the library's schema: each declared prop present, its type and required mark as declared, its enumeration values exactly the schema's, and no prop shown that the schema does not declare. A renamed, added or removed prop fails without the screen being touched.
- **Component — the rules.** Every rule in the shared module appears on the screen, and every rule the screen states comes from that module. A rule paraphrased on the screen rather than read from the module fails, which is what keeps the two vocabularies one.
- **Component — where a component may sit.** The parents an entry names match the schema's own children union, so a component that stops accepting children fails here as it does in the props drift: nesting is a claim the screen makes, and it has to be the schema's.
- **Component — the playground.** A pasted block draws; a block that does not parse draws its error in words and its source as code with no empty frame; a remount shows an empty playground, proving nothing was kept; a block carrying a query draws without calling anything.
- **Component — the door.** With setup incomplete the address goes where every gated address goes, and the screen draws nothing; with setup complete it draws. The gate is the one every screen passes, not a switch of this screen's own.
- **Generation — the artifact's drift, unchanged.** The prompt artifact still regenerates byte-identical after the rules move into the shared module, still reports its length and headroom, and still fails at the 4,000-character ceiling. This is the cheapest test that would fail if the extraction changed what the model is told.
- **Build — the chunk assertion.** The assertion that each heavy drawing library lives in exactly one lazy chunk, reached only by the drawn-interface block, runs unchanged after both screens land. It is the test that would fail if either screen imported the library directly, so it belongs in this spec's gates even though it is not this spec's code.
- **Why these tiers.** A DOM without layout has no pixels to check, so the look stays a screenshot in the pull request; what can fail for a reason is a construct that stopped drawing, a prop that moved, a rule that was copied instead of shared, and an import that broke the chunking. Those four are covered without a browser, and a flow that walked the screen would assert geometry the component test cannot reach anyway — which is the argument for leaving it out.

## Out of Scope

- A published or unauthenticated reference: a docs site, a marketing page, or anything served to a device that has not set the app up.
- A component index, search, filter or per-component anchors.
- An interactive prop editor, a form that builds a block, or a playground that saves, shares or restores a snippet.
- Running a pasted block's queries or offering its mutations.
- Examples generated from the schema rather than hand-written.
- A reference per library version, or an archive of how an older component looked.
- Screenshot-based visual regression for the entries.
- A third demo app, a sample app of the screen's own, or a copy of either built-in app.
- Any change to the components, the library's membership, or what a chat reply may draw.

## Further Notes

- **The two prototype tickets were carried in as criteria, not built.** The Home Assistant dashboard, drawn, and the reference, drawn, were both prototype tickets; both were folded into these specs as design criteria because a prototype now would have been drawn against a component set that does not exist yet — the link between pages, the app section, and the teaching for queries and mutations. What that means for the builder: there is no drawn answer to copy. This screen's layout, density and the look of its entries are being decided for the first time when they are built, so the criteria in this spec are the brief, not a description of something already drawn. Build a thin vertical slice first — one entry drawn end to end, then the playground — and if a criterion cannot be met with the components that exist, say so rather than widening the library or decorating the screen to make it true. The prototypes existed to spend a cheap question before an expensive build; that question is now spent inside the build, which is exactly why the slice comes first.
- **The name is component reference.** The word for a wall of pictures is already spent on the row of media in a thread, so this screen is never called that — not in code, not in copy, not in a ticket. Page means one document of an app; screen means a route of the app. The entry for a component is not a page.
- **The playground is also the cheapest bug report.** A reader who pastes the block that misbehaved can show a maintainer exactly what they saw, which is why a field that keeps nothing is worth having even after the reference is familiar. It costs nothing to support, because it does nothing else.
- **A new component lands with its example.** The entry's description is the library's, and the library's description is what the prompt carries, so the two cannot differ; the example and the props are what the tests hold. A component without an entry is a component the gates say has not arrived, and that is the whole maintenance rule — enforced rather than written down.
- **The shared module is the interesting seam.** It is the first place where the words a model is given and the words a person is given are the same object, and the ceiling that keeps the prompt small now also limits what the screen may state as a rule. Prose that only a person needs belongs around the rule, not in it.
- **The screen is deliberately dull.** No bespoke previews, no marketing sentences, no ordering of its own. Everything that would make it prettier would make it a second copy of something, and a second copy is what it was built to avoid.
- **Two pieces of fog touch this spec without blocking it.** Where Settings offers the row that leads here is that screen's business, and this spec fixes only the address. What a page drawn against an older library looks like on a newer app stays open, as it does for the built-ins.
- **A component is not done until its entry is.** The test that fails on a component without an entry is the rule, stated as a test: the library's own membership is the screen's table of contents, and there is nowhere else to remember it.
