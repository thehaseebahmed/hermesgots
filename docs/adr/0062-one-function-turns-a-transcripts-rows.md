# One function turns a transcript's rows into turns

Three readers of a transcript each worked out what a turn is: `toMessages` (folding), `turnsOf` (the
catch-up's grouping) and `liveTurn` (the running reply). Compaction (#643) and wake runs (#646) were each
fixed by adding a pass to one of them — reorder around a summary, drop a repeated restatement, slice to
the newest wake run — and `liveTurn` kept its own start, summary and resumed conditions beside the
grouping `turnsOf` already had. The passes could disagree, and the reorder had to be idempotent because
it ran again on rows another reader had already ordered.

`turnsFromRows` in `history.ts` is now the one reading. It orders the rows around each compaction, drops
a restatement of the request the turn already restated, and cuts at each request. A `Turn` has its
`request` (none for a turn a wake run opened), its `rows` in reading order, its `runs` (the rows cut at
each wake prompt) and `summaryAt`, where its last summary falls. Then:

- `toMessages` is `turnsFromRows` plus `foldRows` per turn; `foldRows` folds rows already in order.
- `turnsOf` is the turns' runs, folded.
- `liveTurn` finds the last turn whose request matches, or with none the last turn after its summary,
  and takes its last run. Paging (`carriedAbove`) stays: the request is complete once a summary is held.

A new shape of compaction is taught to `turnsFromRows` and nowhere else.
