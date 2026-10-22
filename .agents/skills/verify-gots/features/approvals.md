# Approvals and questions

Some turns stop and wait for the user: an approval (Accept edits, a command), a clarify question, a
plan. Each shows where the user looks — the sidebar's `Waiting for input`, the project's
`Waiting on you` — and takes its answer in the chat. Nothing is lost when the app is closed; the
wait is on the host.

## Sub-features

- `approval-waiting` — a project session waiting on an approval shows in the sidebar's `Waiting for
  input` and the project's `Waiting on you` (`approval`).
- `approval-allow` — `Allow once` moves both to Idle once the host has the answer (`approval`).
- `approval-missed` — an approval the host timed out, or refuses to take an answer for, leaves the
  composer (`approval-missed`).
- `clarify-answer` — an answered question survives stale polls, a reload and a fresh transcript
  (`clarify-polling`, `clarify-transcript`).
- `question-push` — a question opened from a notification in a chat not loaded here shows as waiting
  from the first frame, never "No answer" (`question-from-push`).

## How to get to it (user POV)

- The sidebar's `Waiting for input` navigation group.
- A project's `Waiting on you` region (Code, or the project's own screen).
- The chat itself: the composer is replaced by the approval's buttons (`Allow once` and friends) or
  the question's form.
- A push notification naming the question.

## Driving it with the e2e flows

Preconditions:

- Baseline state (features/README.md). The mock asks for an approval when a turn mentions `clean` or
  `delete` — the standing trigger is sending `clean up`.
- The `approval` flow also runs on the polling mock (`alsoPolling`); a verification pass runs both.

- **Reach the wait.** Start a project session turn that asks for an approval. Run
  `pnpm e2e approval --shots "$GOTS_VERIFY_ARTIFACTS/<run-id>"` (from `app/`). The drive seeds a
  project session, sends `clean up`, and waits for `getByRole("button", { name: "Allow once" })` —
  the approval's own control in the thread.
- **Sidebar and Code agree.** The same flow asserts
  `getByRole("navigation", { name: "Waiting for input" })` holds the session and
  `getByRole("region", { name: "Waiting on you" })` shows it in the project — the same state in both
  places, the shot capturing both at 1440px where they sit side by side.
- **Allow it.** Click `Allow once`. The flow clicks it and both views move the session to Idle; the
  turn then finishes on the host. The proof is the state change in both views, not the click.
- **Polling mock.** Run `pnpm e2e approval --polling --shots …` — the same journey where the app
  polls instead of reading the change stream (an older plugin).
- **A missed approval.** Run `pnpm e2e approval-missed`. The composer comes back without an answer
  having been taken: the approval is gone from the thread, and nothing claims it was allowed.
- **Answered questions.** Run `pnpm e2e clarify-polling` and `pnpm e2e clarify-transcript`. The
  answer stays shown after stale polls, a reload and a fresh transcript read — read back from the
  stored transcript, not only the rendered thread.
- **Proof of a whole pass.** `approval-*.png` at phone and laptop widths where the journey claims
  them, plus the `PASS:` transcript, in `$GOTS_VERIFY_ARTIFACTS/<run-id>`.

## Gotchas

- The mock triggers an approval only from words in the message: `clean` or `delete` (use `clean
  up`). A turn that doesn't ask for one can't be used to prove the wait.
- The approval answer is the app's own request to the host (`POST /v1/runs/{id}/approval`). Never
  answer it from the drive: a proof that posts it directly bypasses the user path being verified.
- `approval-missed`'s end state is the approval *leaving* the composer. Assert that it is gone and
  the turn did not claim an answer; don't wait for buttons that must not come back.
- The sidebar group's accessible name differs when collapsed: `Waiting for input` is its label in the
  collapsed rail (`conversation-list.tsx` sets it conditionally).
- An approval that the flow never allowed keeps its session waiting on the mock; the mock's state
  lives in its process, so restart it (`pnpm e2e down` then `up`) if a later journey needs that
  session idle.
