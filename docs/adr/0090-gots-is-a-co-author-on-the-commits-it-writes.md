---
status: accepted
---

# Gots is a co-author on the commits it writes

A repository counts a contributor from the commits that reach its default branch, not from anything a
pull request says. GitHub's own troubleshooting names the two ways to be missing from that list — "your
commits haven't been merged into the default branch", and "the email address you used to author the
commits isn't connected to your GitHub account" — and its guide to multiple authors says what makes an
address count: "For the commit to count as a contribution, use an email address associated with their
account on GitHub.com." So the account that works a session is credited by the identity on the commit,
and by nothing else. The description's watermark carried that address for a while and could never have
worked; it is gone (`0089-a-pull-requests-watermark-is-the-tools-to-write.md`).

**The tool adds the trailer, from its own constant.** `_commit` ends every commit message it writes
with `Co-authored-by: Gots <342030690+gotsfather@users.noreply.github.com>` — `CO_AUTHOR_NAME` and
`CO_AUTHOR_EMAIL` in `ship.py`, written by hand and fetched from nowhere. That is the point: a server
whose token is missing, expired or answering nothing still writes the credit, where reading the account
at commit time dropped the line on exactly those hosts and said nothing. The address is the ID-based
no-reply form GitHub documents for an account made after July 2017, the one that stays linked through a
username change.

**The person stays the author.** The human whose work it is writes the commit and keeps the blame, the
history and their own contribution graph; Gots is named beside them. That is the inverse of the model
GitHub's own agent uses — Copilot authors the commit and the human is the co-author — and it is the
inverse on purpose: this plugin works inside somebody's repository on their behalf, and taking the
author field from them would make `git blame` name the product for the user's own decisions. A server
with no git identity configured has no person to be, so it commits as its account; that is the one case
where the product's name can lead a commit, and the case the trailer is left off in.

**It is left off only where it would be a commit crediting itself.** `_identity` answers the env a
commit runs with and the email it will carry — the host's own git identity, or the account's — and on
this product's own server the second is the address above, so `_credit` writes nothing there. A
`Co-authored-by` line already naming Gots is replaced rather than repeated, and one naming somebody
else — `Gotsfather`, say — is left where it stands with ours added beside it. The comparison is by
address, so an account GitHub answers without a numeric id gets the older login-only no-reply form,
which is not this constant: a server authenticated that way credits itself once before the trailer is
added.

**Considered options.**

- **The account's address in the description, as a watermark.** Rejected, and the reason this record
  exists: no line of a description is read when contributions are counted, so the account never
  appeared however the line was worded.
- **Gots as the author, with the person as co-author.** Rejected. It guarantees the credit and costs
  the person their own history: every commit in their repository would blame the product, and the
  complaint GitHub's users file about Copilot's agent is exactly that. The co-author trailer gets the
  same credit without taking the author field.
- **Reading the account from the host's token at commit time.** Rejected after it was built. It makes
  the credit depend on a network read of `GET /user` as the commit is made, so a missing token or one
  API wobble drops the trailer silently — and a server working as somebody else's account credits that
  account rather than Gots. A constant cannot fail that way, and this mark is the product's, not the
  deployment's.
- **A value generated at build time from a repository variable.** Rejected: the plugin has no build
  step, so this would mean generating a module in CI and shipping a tree that differs from the source
  for one string.
- **A `prepare-commit-msg` hook in the session's worktree, so the agent's own checkpoint commits carry
  it too.** Not taken. It reaches the commits the tool never sees, but it needs its own
  `core.hooksPath` scoped per worktree (with `extensions.worktreeConfig`) or it rewrites the user's
  commits in their own checkout, and `--no-verify` skips it anyway. The credit stays on the commits the
  tool makes, which is the path it controls.
- **No attribution at all, and the commits carry the host's identity alone.** Rejected: then the account
  never appears, which is the thing being asked for.

**Consequences.** The trailer rides in the commit message, so it survives a rebase, an amend and a
squash that keeps the message — and it is written once, by the tool, on every commit it makes. The
commits an agent makes itself, through its own `git commit` in the worktree, carry none, and a staged
workflow's commits are mostly those. Credit
lands when the pull request merges into the default branch, and not before. One thing is worth checking
after the first merge rather than assuming: GitHub's documentation says a co-author's address counts as
a contribution, and a measured report has such an account in the repository's `stats/contributors` and
in Insights → Contributors but not in the plain REST `/contributors` list. The graph is what "appears
as a contributor" means here, so that is the surface to read; if the account is still missing there,
the answer is to author the commit as the account, which this record rejects for the reason above, and
that would be a new decision rather than a tweak.
