---
status: accepted
---

# A run may finish its own pull request, when its Prompt asks it to

The `pull_request` tool could open a draft and go no further. Marking one ready and merging it were
refused with a teaching error — "merging and closing are the user's decision" — so "end to end" was
a person doing the last two steps by hand. The tool now has `ready` and `merge` beside `ship`,
`push` and `update`, and three things about that are the decision.

**Two actions, not one.** A `deliver` that shipped, marked ready and merged in one call would hide
which half failed, and it would leave no way to do the middle step on its own — mark a pull request
ready so its checks run and so a person can read it, and merge later, or never. They are also two
different calls at GitHub: `ready` is a GraphQL mutation and `merge` is a `PUT`, with failure modes
that ask for different next steps. `merge` keeps one refusal, and it is `close`: closing throws away
work a merge would have delivered, so it stays the user's.

**Ready is the mutation, on the one seam.** REST's update endpoint documents no `draft` field, so
`mark_ready` reads the pull request for its `node_id` and posts `markPullRequestReadyForReview`
through `_fetch`, which is where the token, the timeout, the outbound slot and the error mapping
already live; the mutation's `errors` array becomes a `GitHubError` carrying GitHub's own sentence.
A pull request already out of draft is answered without a second call, so a retry after a dropped
answer costs nothing.

**Merge is the tool's, but who may merge is the Prompt's.** `merge` refuses a draft (call `ready`),
and a pull request whose checks failed or still run — the two states a run can do something about,
and better said by the tool than by GitHub's 405 "not mergeable". It then `PUT`s the merge route
with the merge method (`squash` by default) and the sha the row was read on — the one its checks and
draft state were judged at, not a fresher one — as GitHub's own guard, so a branch that moved is
refused rather than merged at a commit nobody looked at; a
405, a 409 and a 422 each become the next call ("fix what GitHub names and ship again", "ship then
merge again", the refusal in GitHub's words). Whether a run *should* is a different question, and
the answer is not "always": a pull request exists so the user reads it when they come back, so the
base prompt keeps a merge the user's **unless they ask for the work to be delivered**, and only a run
with nobody watching — an AFK run, whose prompt is the one that carries `## The Project's Prompt` —
takes its project's Prompt for that answer. A plain session's prompt has no Project's Prompt in it at
all, so naming that alone would have given it an authority it never sees. The tool's schema says the
same in one sentence, because a tool that offers what the prompt forbids teaches an agent to refuse
something it can do.

**What a merge invalidates, and where.** The branch's cached row is forgotten, so the app's next
read is the merged row. `ship`'s next decision needs no change: `wants_pr` already reads a merged
row as "only new work opens another", which is why a squash-merged branch's old commits are not
mistaken for work. No new state is invented — `merged` is already in the vocabulary the app, the
merge sweep and the PR cache read (`_state`). The session is resolved through `merges.check` with
`only={session_id}` on the spot, so the chat list says resolved and the `pr_merged` push goes out
when the merge happens rather than on the next five-minute sweep; a sweep that runs afterwards sees
the merge already marked and says nothing twice. `_described` does not change: a merge writes no
description, and the watermark and `Closes #n` rules are the tool's on both paths that do (ADR 0089).

**What the gate does not know.** `checks` is the one collapsed word the pull request row carries, and a
GitHub whose check API can't be read answers as a repository with no checks — indistinguishable from
one that has none. So the gate is what a run can act on, not a required check: a rule that insists on
one is enforced by GitHub, and its refusal comes back through the 405 mapping like any other.
