# The prompt artifact is compressed and its generated body is rewritten

The instructions that teach the model to draw interfaces ride one system-prompt section capped at 4,000 characters, with 22 of them free when both the draw-on-data rule and the map arrived. The build script now owns the artifact end to end: it rewrites the parts of the generated body that no longer hold — the "questions get text only" rule that fought the product, and a mention of forms the library does not have — and compresses the remaining prose caveman-style: dense telegraphic text, articles and filler dropped, while every signature, enum value and rule string stays byte-exact, since those are the schema the model codes against. A second system-prompt section was rejected: one artifact, one section, one measured budget.

## Considered options

- **A second system-prompt section** with its own 4,000-character budget for the encouragement. Rejected: it forks "the library told by the host" into two frozen sections every session pays for, and the guidance belongs beside the signatures it governs.
- **Trimming the schema** — shorter descriptions, fewer optional props. Rejected as the first move: descriptions are what the model chooses components by, so the ceiling is paid from prose before contract.

## Consequences

- The artifact reads in compressed prose; its drift test pins it byte for byte, so every regeneration is deliberate and reviewable.
- Every change to the artifact reports its length, headroom and delta, measured with the spec's serialization options — headroom alone hides a change that grew it.
