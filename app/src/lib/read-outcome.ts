/**
 * How a screen's own read ended without the thing it asked for — the two endings a page's one
 * sentence collapses, told apart because only one of them can be asked again:
 *
 * - `threw` — the request was refused, never landed, or timed out. The same read can be asked again.
 * - `answered` — the host answered and did not carry the block. An answer is an answer, and asking
 *   again cannot change it.
 *
 * A read that answered with its block has no failure at all. Import-free, so every read that hands a
 * notice a reload names its ending the same way.
 */
export type ReadFailure = "threw" | "answered"
