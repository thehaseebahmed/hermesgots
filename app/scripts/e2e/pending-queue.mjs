// A chat whose queue Hermes itself holds behind a turn a restart lost (`plugin/pending.py`): the card
// takes the composer's place, names the lost turn and the message waiting behind it, and Discard
// acknowledges it so the queue runs again — the TUI's `/discard`, from the app.
import { app, assert, flow, LOOKS, mockPost, pass, runId } from "./lib.mjs"

/** Puts the host's fence on a session: one lost turn, and one input waiting behind it. */
const fence = (session, text, queued) =>
  mockPost("/__mock/pending", { session, text, queued: [queued] })

async function body({ page, seed, shot, until }) {
  const chat = `e2e-pending-${runId()}`
  const session = `gots-${chat}`
  const LOST = "a turn the server lost"
  const HELD = "the older message behind it"
  await seed([{ id: chat, title: "A fenced chat", hermesSessionId: session }])
  await fence(session, LOST, HELD)
  await page.goto(`${app}/c/${chat}`)

  const title = page.getByText("This session's queue is paused.")
  await title.waitFor({ timeout: 20_000 })
  await page.getByText(LOST).waitFor({ timeout: 10_000 })
  await page.getByText(HELD).waitFor({ timeout: 10_000 })
  assert.equal(await page.getByText("Lost when the server restarted").count(), 1, "the lost row")
  assert.equal(await page.getByText("Waiting").count(), 1, "the row behind it")
  assert.equal(
    await page.locator("textarea").count(),
    0,
    "nothing can be typed behind a turn that will never run",
  )
  // The thread a lost turn never wrote a row in is empty, and that is the state, not a read that
  // failed: no pane over it, and no spinner, since nothing can run behind the fence to write one.
  const missing = page.getByText("The thread didn't load.")
  assert.equal(await missing.count(), 0, "the empty thread is not called a failed read")
  assert.equal(await page.locator('[data-slot="spinner"]').count(), 0, "and no read is claimed to run")
  await shot("paused")

  await page.getByRole("button", { name: "Discard lost turn" }).click()
  await until(() => title.count().then((n) => n === 0), 10_000, "the card gone")
  await page.locator("textarea").waitFor({ timeout: 10_000 })
  assert.equal(
    await page.getByText("The thread didn't load.").count(),
    0,
    "and clearing the queue does not turn the empty thread into one",
  )
  await shot("cleared")

  // The host now reports the turn it freed as running, and the thread is still empty: the app waits
  // on it rather than naming a read that failed, which is the state the queue-cleared screen used to
  // fall into a few seconds later.
  await page.waitForTimeout(5_000)
  assert.equal(
    await page.getByText("The thread didn't load.").count(),
    0,
    "and it is still not a failed read once the freed turn's window has passed",
  )
  assert.equal(
    await page.locator('[data-slot="spinner"]').count(),
    0,
    "nor a spinner nothing is filling",
  )
}

for (const { look, options } of LOOKS) await flow(`pending-queue-${look}`, body, options)

pass("a fenced chat names what its queue holds and clears the lost turn from the app")
