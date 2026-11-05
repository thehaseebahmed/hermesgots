// A chat whose queue Hermes itself holds behind a turn a restart lost (`plugin/pending.py`): the card
// takes the composer's place, names the lost turn and the message waiting behind it, and Discard
// acknowledges it so the queue runs again — the TUI's `/discard`, from the app.
import { app, assert, flow, LOOKS, mock, pass, runId } from "./lib.mjs"

/** Puts the host's fence on a session: one lost turn, and one input waiting behind it. */
const fence = (session, text, queued) =>
  fetch(`${mock}/__mock/pending`, {
    method: "POST",
    body: JSON.stringify({ session, text, queued: [queued] }),
  })

async function body({ page, seed, shot, until }) {
  const chat = `e2e-pending-${runId()}`
  const session = `memento-${chat}`
  const LOST = "a turn the server lost"
  const HELD = "the older message behind it"
  await seed([{ id: chat, title: "A fenced chat", hermesSessionId: session }])
  await fence(session, LOST, HELD)
  await page.goto(`${app}/c/${chat}`)

  // The card, in the composer's place: what was lost, what waits behind it, and the one control.
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
  await shot("paused")

  // Discard acknowledges it on the host, and the chat is a chat again.
  await page.getByRole("button", { name: "Discard lost turn" }).click()
  await until(() => title.count().then((n) => n === 0), 10_000, "the card gone")
  await page.locator("textarea").waitFor({ timeout: 10_000 })
  await shot("cleared")
}

// The card on a laptop and on a phone, each in its own theme.
for (const { look, options } of [LOOKS[0], LOOKS[1]]) await flow(`pending-queue-${look}`, body, options)

pass("a fenced chat names what its queue holds and clears the lost turn from the app")
