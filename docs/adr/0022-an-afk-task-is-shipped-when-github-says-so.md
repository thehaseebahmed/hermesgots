# An AFK task is shipped when GitHub has a pull request for its branch

The design that added workflows asked for a stricter rule: a task is shipped only if the
`pull_request` tool was successfully used to open its draft, so that a run which reached GitHub some
other way — `gh pr create`, a `git push` and a pull request opened by hand — could not pass as
shipped. The host can record the tool's own act, and it does not: shipping is read off GitHub, as it
has been since AFK's first run, and any pull request on the session's branch counts, whatever opened
it.

The reason is that the answer the user cares about is GitHub's. The app's pull request pill reads
GitHub, the merge and the review comments happen there, and a draft that a merge has closed is not a
draft. A record of the tool's call would be a second truth about the same fact — one that says
"shipped" about a pull request GitHub has since merged, and one that misses a pull request a run
pushed with git. Worse, the two would have to agree at the moment the sheet is drawn, so every reader
of the record would be asking GitHub anyway and the record would only ever add refusals.

What the stricter rule would have bought is narrow: a task whose pull request came from an earlier
attempt looks shipped, and a run that used `gh` looks shipped. Neither is invisible to the user —
both are pull requests they can open — and both are cases where the work *is* on GitHub, which is the
thing the rule was trying to establish.

## Considered options

- **Both: the record and GitHub, agreeing.** Rejected: two truths, plus an exception for every
  re-run over an existing draft, and a stall whose only cause is that the agent typed the wrong
  command while the pull request sits open.
- **The record alone.** Rejected: the app tells the user about the pull request from GitHub, so after
  a merge the record would say shipped and the pill would say merged, about the same task.
- **GitHub alone, but requiring the pull request to still be a draft.** Rejected as the same
  question with a shorter half-life: a task the user has already merged would read as unshipped.

## Consequences

- Item 4 of the workflow design is deliberately dropped; a run that opens its pull request with `gh`
  passes, and so does a task inheriting a pull request from a previous attempt.
- The prompt keeps telling the agent to ship with the tool, and the tool is still the only way that
  gets the draft, its template and the `Closes` line right — the rule is guidance, not a check.
- A workflow's last stage ending still asks GitHub whether any of the session's repos has a pull
  request, and stalls the task naming that if none does.
