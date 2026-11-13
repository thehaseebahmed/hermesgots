# A literature review is read by code from an index, and a paper counts only by its quotes

Literature review is the fourth Research mission. Someone asks what the research says about a
question; the bot reads it back with the criteria a paper must meet, and the host searches a
scholarly index, screens the candidates, reads what is open and extracts the same few fields from
each. What comes back is a narrative review: how it was searched and what was counted, a table of
the papers read, the themes across them, where they disagree, the gaps, and a reference list.

The alternative was a "Scholarly" kind of source on a Learn mission. It was a day's work and it was
not enough: the unit of evidence changes (a paper with fields, not a claim from a page), the
pipeline gains a search and a screening step whose counts the reader is owed, and the output is a
table of papers. A reader of a review expects that structure, so it is its own type.

**No Hermes run reads it.** Learn, Compare and Verify start a researcher because they have to
discover pages on the open web. Here the candidates come from an index and the reading is a fixed
loop, so it runs in the plugin as bounded calls that code counts, stops and picks up again: a
restart reads the paper it was on and no other, because a paper's fields and how much of it was
read land in one write. A run would add a tool-using agent that can wander, for nothing gained. The
type has no lanes, its `claim_add` is refused, and the routes start it on the plugin's own thread
(`MissionType.read`). Following the included papers' references to papers the queries missed is the
reason to add a run later, and is not built.

**A reference is the index's metadata and never a model's words.** The reference list is written by
`scholar.reference` from the fields the index returned for each included paper. The synthesis is
never shown a title, an author or a DOI — its ledger names a paper by its id, its year and how much
of it was read — so it has nothing to type a citation from, and a sentence that names a paper
instead of citing a claim id is flagged like any uncited sentence. A model that returns a reference
list anyway has it ignored.

**A field is kept only with a quote found in the text the host fetched.** Each extracted value
comes with a passage, and `check_passage` — the check `claim_add` makes on a web page — looks for it
in the paper's text, compared as lower-case words with an ellipsis allowed to split it. A field
whose quote is not there is dropped and counted, and the review says how many were. A quote is at
most 500 characters: enough to find the passage, never a stretch of the paper.

**What that check does not catch is said, not hidden.** A real quote read wrongly — a subgroup
reported as the whole sample, a limitation quoted from the related-work section — passes it. A
second model sharing the misreading would pass it too, which is why the spec's "independent
extraction plus cross-check" is not in this phase: it doubles the calls on the mission's largest
cost, and it earns its place only if a hand check of extracted fields finds misread numbers. The
quote is one tap from the value, in the row that opens.

**Every paper says how much of it was read.** *Full text* is an open copy the index named, fetched
and long enough to be the paper (1,500 words, and three times its abstract: a landing page that
holds the abstract and a link is not the paper). *Abstract only* is the index's abstract, when there
is no open copy, when the copy is a PDF — nothing here reads one — or when it could not be fetched.
*Metadata only* is neither, and makes no model call. A copy that can't be read never fails the
mission. Only a copy the index itself calls open is fetched, and the abstracts and addresses the
reading worked from are deleted when it ends.

**The funnel is counted by code and always adds up.** `funnel_counts` works it out from where each
paper stands: every paper found is screened or was not reached before the cap, and every screened
one is included or excluded for a reason, the criterion it failed or that it is off the question.
An unsure paper goes through to reading. The screening stops at the cap of included papers and
reads at most three candidates for each one the cap allows.

**The index is OpenAlex, and its key is optional.** Checked against the live API on 2026-11-12: a
request without a key is charged to a daily budget of $0.10 shared by everyone behind the caller's
IP address, at $0.001 a search, and refused with a 429 once that is spent — which the host this was
built on already had. So a host on a shared address needs a key, a home host mostly does not, and
the refusal names the variable that lifts it (`OPENALEX_API_KEY`, read through Hermes's credential
helper, sent as a header). A second index for citation context is later work.

**It is called a narrative review wherever it is named**, and the word systematic is not used: no
protocol is registered and no two people screen. It scores no paper's rigour, pools no effect sizes
and reads nothing behind a paywall. Its open-access bias and its one index are stated on the review
itself, which is a disclosure and not a fix.

**A disagreement needs two findings.** The synthesis may name two claims that point opposite ways;
code keeps the pair only where both are in the ledger, come from different papers and sit under one
theme. Each theme says how many papers stand behind it and how many of those were read in full, so
a theme resting on three abstracts cannot read as firmly as one resting on three papers.
