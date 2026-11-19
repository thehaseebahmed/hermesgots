# A canvas build's method is its guide, and its craft is a bundled skill

**Amends [ADR 0122](0122-a-canvas-is-designed-by-its-user-first.md)** (2026-11-19, planned in
`docs/plans/2026-11-19-canvas-builds.md`; not built yet).

The canvas guide spent its 4,000 characters on what a page may and may not do, and none on how to
work. **The guide section becomes the user's design first, the floor, and the method every build
follows** — file a plan, break the work into slices, write to the draft, test, read the screenshots,
keep the memory, end on a summary — while the coding practices it holds today move into a bundled
canvas-craft skill, registered beside the three design skills and named by the guide. A section is
frozen when a session starts, and a session per build (ADR 0169) is what makes the method current on
every build rather than on every canvas.

## Considered and rejected

- **The method in each run's `instructions`.** Current every turn, but it splits what a build is told
  across two places and is sent with every turn rather than once.
- **The whole guide as a skill.** A skill is loaded when the agent chooses; the method must not be.

## Consequences

- The section still shares the host's 4,000-character cap, over which it is dropped whole and Canvas
  hides.
