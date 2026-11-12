# A claim is read in two blind lanes, and its label is code's, kept at delivery

Research's third mission type, Verify a claim, answers whether the evidence supports a claim the user
pasted. A verdict is only worth reading if the reader can audit it, and the two ways a model gets one
wrong are anchoring on what it finds first and stating a label the evidence doesn't carry. So the
reading is split in two, the label is worked out by a rule rather than written, and the rule's answer is
kept as it was when the user first read it.

**Two blind lanes.** A verification reads in two Hermes runs, For (`research-<id>-for`) and Against
(`research-<id>-against`), each told to find the strongest evidence one way, each asked from the
confirmed restatement, parts and terms alone — never the user's original wording, never anything of
the other lane. One researcher told to look both ways was the obvious design and was rejected by the
user: it anchors on what it finds first, and a search for disconfirming evidence run after the
confirming one is shaped by it. Loaded wording steers a search as surely as it steers a judge, so the
lanes never see it. The price is two full readings and a judge, about twice a Learn mission's cost.
Runs are kept per lane for every type (`research_runs`), with Learn and Compare as one-lane missions,
rather than a second run column every run-shaped path would have had to special-case.

**A claim counts only where two independent readings agree.** The researcher records a stance with
each claim (`supports`, `refutes`, `context`); the judge, a separate call, tags the claims bearing on
each part with its own stance, and sees the parts and the claims with their sources and passages but
not the original wording, not the researcher's stance and not the lane. A claim counts for a side on a
part only where it is verified and the two stances agree. Trusting the researcher's stance alone would
let the lane that was told to find support grade its own finds; trusting the judge alone would make the
lanes' instructions decide nothing; and a judge shown the stance or the lane would be agreeing with it
rather than reading independently, so the agreement would mean nothing. Either lane may record any
stance, since a lane that finds the other side's evidence must be able to say so.

**The label is code, total, and stored at delivery.** `verdict()` in `research.py`, beside the
comparison's `decide()`, turns the parts, the ledger and the judge's tags into a stance per part and a
label by a fixed precedence, counting independent sources by registrable domain under a rule that
under-counts rather than over-counts. The tests enumerate every pair of source counts and every
combination of part stances, so no ledger can fall between labels. A model-written label, or a
model-written sentence of why, could contradict the evidence it sits on, so the sentence is composed by
code from the label and the part stances too. The answer is stored with the output when the mission is
delivered and a read returns it as stored; recomputing it on read was rejected by the user, because a
verdict the user has read must not change under them when the rule is fixed. A rule change reaches old
verdicts only by running the mission again.

**A broken lane fails the reading.** Both lanes have to complete. One that ended failed, cancelled or
interrupted fails the reading even when the other recorded claims, and Try again restarts only the
lane that broke; delivering on the one lane that finished was rejected by the user, because a verdict
searched in one direction is the very bias the lanes exist to remove. A reading where both completed
with nothing fails with the web-search hint rather than delivering "not supported" from a host that
couldn't search. A flaky host therefore fails more verifications than it would fail Learn missions.

**Thin evidence is a label of its own.** The six labels a fact check usually carries (Supported, Partly
supported, Disputed, Not supported, Refuted, Can't tell) would have called a part backed by one site
supported. The user added a seventh, Thin evidence, whose sentence says which way the lone source
leans, and narrowed Partly supported to a mix of parts, because one source is not support. Some claims
a person would call supported will read Thin evidence; that under-claiming is the intended direction.
