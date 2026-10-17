# Cluster C — usage cost

Needs cluster B's `plugin/models_dev.py`. That module owns the catalogue; this cluster is its second
consumer.

## Goal

What usage cost is a fact about tokens and model prices, so the plugin prices it. The app formats and
sorts, and the hand-maintained Claude price table goes.

## What the code does today

`src/lib/pricing.ts` holds a `CLAUDE` table of Anthropic's first-party prices (USD per million tokens,
cache writes priced as 5-minute writes), `normalize()` for Hermes-style model ids
("anthropic/claude-opus-4.8", "us.anthropic.claude-opus-4-8-v1:0"), `claudePrice()`, `estimateCost()` and
the `ModelUsage` type. `estimateCost` prefers a Claude price, else Hermes's own `costUsd`, and flags
`partial` when some usage has neither.

It is used in `src/components/project-usage.tsx` for the project's total (`:81`, over every thread's
models), each session's cost (`:169`), the sort by cost, and the `+` suffix `formatCost` prints from
`partial` (`:43`). `ModelUsage` is also imported by `src/lib/hermes.ts:16` for the wire types
(`ProjectUsage`, `ProjectSessionUsage`, `modelUsage` at `:1147`).

The plugin already reads Hermes's own figures: `plugin/projects.py::usage` selects
`COALESCE(actual_cost_usd, estimated_cost_usd)` per session row and `estimated_cost_usd` per model share,
and returns `cost_usd` per model bucket and per project total, with `None` where Hermes had no figure and
`0.0` for a genuinely free model (the comment at `:395-398` depends on that distinction). `_fit` scales the
per-model shares so the split adds up to the session row — the totals are the session rows', so the split
can never disagree with them. The mock hands the Claude threads `cost_usd: null`
(`app/scripts/mock-hermes.mjs:1606`) — which is exactly the gap the app's table fills today.

## The contract

- **New `plugin/pricing.py`** (or a function in `models_dev.py`): a model id resolves to
  `{ input, output, cache_read, cache_write }` from the cached models.dev payload's `cost` object (the same
  per-million-token fields the app's table carries; verified for `anthropic/claude-haiku-4-5`:
  1 / 5 / 0.1 / 1.25 — identical to the app's row).
- **The plugin prices what Hermes left unpriced.** Precedence, settled: Hermes's own figure where the
  session row has one (it may be the real bill), else the catalogue's prices multiplied by that model's
  token counts. Keep the existing `None` vs `0.0` rule: a model with no figure anywhere is `null`, never
  a zero.
- **The route carries it.** `GET projects/{id}/usage` returns each model bucket's `cost_usd` *filled*
  (already in the shape), each thread's own total `cost_usd` (new — the app sums the models today), and the
  project total as now. Feature flag `usage_pricing` in `info`'s `features`.
- **The app formats and sorts only.** `Intl.NumberFormat` currency, the kind split, the sort menu and the
  "Cache hit" percentage stay: a ratio of two facts the plugin sent, drawn not derived. No multiplication
  in the app.

## Steps

1. `plugin/pricing.py`: id normalisation (port `normalize` and the `-fast` / version-suffix rules from
   `src/lib/pricing.ts:47-70`; `src/lib/model-match.ts` is the app's other matcher — one of them is the
   reference, do not invent a third), the catalogue lookup, and the per-model pricing. Tests: a priced
   model, a `-v1:0` Bedrock-style id, a minor version that must not match a longer one
   (`claude-opus-5` ≠ `claude-opus-5-5`), an unknown model → `None`, and an unreachable catalogue → `None`
   and never a raise.
2. `plugin/projects.py::usage`: fill the model buckets and each thread from Hermes's figure or the
   catalogue; keep `_fit`'s scaling and the "wait, don't name a cost the total doesn't" rule, and make the
   totals come from the session rows as they do now.
3. The route + the `usage_pricing` flag.
4. App: move `ModelUsage` out of `src/lib/pricing.ts` (`src/lib/hermes.ts`, beside `ProjectUsage`) and
   **delete `src/lib/pricing.ts`**. `src/components/project-usage.tsx` reads `cost_usd` for the project and
   each thread, drops `estimateCost`, drops the `partial` marker and the `+` in `formatCost` (the marker
   cannot exist once there is no table that covers only part of a project), and keeps the sort.
   A cost of `null` renders as the `–` it already falls back to.
5. Mock: `app/scripts/mock-hermes.mjs:1585` prices its Claude threads the way the plugin would (its
   `cost_usd: null` at `:1606` and the project total at `:1618` are the point of the change), and its
   `features` list gains the flag. The `prs` flow and `pnpm e2e screens` cover the Usage tab.
6. Docs: `AGENTS.md`'s usage paragraph (its "its **Est. cost** comes from `src/lib/pricing.ts` … Update the
   price table when Anthropic's prices change" sentence, and the layout row for `src/lib/pricing.ts`),
   `plugin/README.md`'s usage line, and delete this cluster's entry from `fixes.md`.

## Pitfalls

- **`None` is not `0.0`.** A free model bills zero; an unknown model has no figure. The plugin already
  distinguishes them and the app's `cost_usd: null` path depends on it — keep both.
- **The totals are the session rows'.** Refilling prices must not move a total: the per-model shares stay
  *fitted* to what Hermes recorded, or the Usage tab's parts stop adding up to its whole.
- **A price is not a bill.** models.dev's prices are the provider list's own; a Bedrock or Vertex session
  (or a discounted plan) can bill differently. The old file's comment says as much, and Hermes's own figure
  wins wherever it exists — this is why the order matters rather than being a coin toss.
- **Don't leave two matchers.** The model-id normaliser here and `model-match.ts` in the app answer the
  same question on opposite sides of the wire; keep them aligned (a comment in each naming the other) or the
  plugin prices a model the app labels differently.
- The catalogue is fetched once for windows and prices — read it, never refetch per model.
