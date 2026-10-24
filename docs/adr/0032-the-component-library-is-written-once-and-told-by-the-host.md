# The component library is written once and told by the host

The model can only draw what it is told it may draw, so the component library and the instructions
about it are the same fact, and they sit on opposite sides of a process boundary. The library is
written once in the app, as TypeScript over the components Gots already owns. The instructions the
model reads are generated from it, checked in as an artifact, and registered by the plugin as a system
prompt section.

The two halves have different homes for honest reasons. Prompt generation is TypeScript —
`createLibrary(...).prompt()` — and the plugin is Python with no build step, so the host cannot derive
the words itself. And the vocabulary has to match the renderer exactly: a host that tells the model
about a component the app does not have produces a reply that falls back to code, which is a failure
the user reads as "the model was wrong" rather than "the halves disagree". One source of truth and a
drift test is the only arrangement where that disagreement is caught by a build rather than by a user.

`@openuidev/react-ui`'s prebuilt `genui-lib` is not the library. It carries its own visual language,
and this app's is base-maia on theme tokens, phone first, in light and dark. Charts come from
`pnpm dlx shadcn@latest add chart`, on Recharts, imported lazily inside the chart component alone. A
chart requires a short summary, because a drawn chart is a picture and a reply may be read aloud. A
table's cells take plain text: no markdown, no links, nothing that needs rendering inside a cell.

The section is registered with `ctx.register_system_prompt_section`, which Hermes renders once when a
session starts and freezes into the stored prompt, restoring it verbatim on resume. That is why the
library survives a compression: compression rewrites conversation messages and leaves the system
prompt alone. It also costs nothing per turn, which per-turn injection through `pre_llm_call` would
not: that route works, but it puts the whole library in the user's message on every turn it is asked
for.

## Considered options

- **The prebuilt library, restyled later.** Fastest to a first interface, and it brings charts, forms
  and layouts with it. Rejected because every component would arrive with a second design language to
  undo, and the app's rule is to use its own primitives before writing new ones.
- **The library as a Hermes skill.** A skill is portable, versioned by Hermes and listed in the
  composer's `/` menu. Rejected as the primary route because only a skill's name and description ride
  the system prompt; its body loads when invoked, so a chat would draw nothing until someone typed
  `/openui`.
- **Generating the prompt on the host at runtime.** Would remove the artifact and its drift test.
  Rejected because it needs a JavaScript runtime inside the plugin for one string, and the string is
  static.
- **Per-turn injection through `pre_llm_call`.** Every turn, always fresh, no freeze. Rejected on cost
  and on the invariant that keeps a conversation's prompt cache intact.

## Consequences

- **A library change reaches new sessions only.** The section is frozen at session start, so a
  component added today is drawn from the next chat, not the one open. The alternative is rebuilding
  the system prompt mid-conversation, which is the one thing Hermes's caching forbids.
- **The artifact is capped at 4,000 characters.** Hermes bounds a section there, so the library has to
  stay small enough to describe inside it, and a test fails when the generated text outgrows the cap.
  That bound is a feature: seven components that fit are better than twenty that don't.
- **A drift test is the guard, not a convention.** It regenerates the artifact from the library and
  compares, including the fence name the prompt tells the model to write. A prompt that names a
  different fence than the extractor reads is the one failure the fallback cannot hide.
- **A stale host shows up as a fallback rate.** An older plugin tells the model about a smaller
  library, or an older app draws a newer one as code. Both are visible and neither breaks a thread,
  which is the trade this design chose on purpose.
