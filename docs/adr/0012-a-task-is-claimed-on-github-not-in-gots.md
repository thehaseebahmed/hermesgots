# A task is claimed on GitHub, not in Gots

AFK claims a task where the frontier is read from: it assigns the issue to the account's GitHub user and
adds a `gots-got-it` label, and it releases the claim by taking that label off when the session is
discarded or fails. The frontier excludes an issue that carries either mark, so the same task is never
worked twice. The task's pull request body carries `Closes #n`, so merging it closes the issue the way
GitHub intends — which is what unblocks the tasks behind it, since a blocker counts as satisfied once it
is closed.

The claim has to be visible outside Gots. The frontier is a GitHub query, the user reads the tracker on
GitHub, and anything else that picks work up on that repo — another agent, another host, a person —
has to honour the same convention. A claim table inside the plugin would be invisible to all of them, and
an issue that looked claimed on GitHub could not be released by hand. The cost is that a claim can outlive
its session: a host that dies mid-task leaves the label on and the task stays unclaimable until someone
takes it off, which is the deliberate half of the claim standing across a restart. The label is created on
first use, because a label that doesn't exist on a repo can't be applied.

## Considered options

- **A claim table in the plugin**, with GitHub left alone. Rejected: the tracker would show a task as free
  while an agent was working it, and nothing outside Gots could see or release the claim.
- **Assignment alone**, the tracker doc's own claim step. Rejected: an assignee is read as a person, and it
  is the same field the user sets when they mean to take a task themselves — a mark of Gots's own says an
  agent has it, and leaves assignment free to mean what it always meant.
- **A label of the user's own, like `in-progress`.** Rejected: it would collide with whatever the user
  already means by their labels, and Gots's mark should be recognisable as Gots's.
- **Nothing closing the issue automatically**, leaving the user to close each one after review. Rejected:
  a blocker is satisfied by a closed issue, so a task whose pull request merged but whose issue stayed open
  would block everything behind it for ever.

## Consequences

- The host's GitHub token needs Issues write, which nothing checks today; a token without it fails the
  claim and the switch shows why.
- A claim released by hand on GitHub — the label taken off — puts the task back in the frontier, which is
  the escape hatch for a claim that outlived its session.
- Merging a task's pull request closes the issue, which unblocks its children; the user's own close, or a
  review that ends without a merge, leaves the issue open and the claim on until the session is discarded.
