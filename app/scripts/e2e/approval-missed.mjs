// An approval that stops waiting without this device leaves the composer's slot: on its own when
// the host says so (a timeout, with the plugin), and when an answer is refused with
// approval_not_pending (a host without it, whose run status still shows the old request).
import { app, assert, flow, mock, pass } from "./lib.mjs"

const endApprovals = (outcome) =>
  fetch(`${mock}/__mock/approvals`, { method: "POST", body: JSON.stringify({ outcome }) })

await flow("approval-missed", async ({ page, seed, send, shot, lastReply }) => {
  await seed([
    { id: "e2e-approval-timeout", title: "Timed out" },
    { id: "e2e-approval-lost", title: "Lost" },
  ])
  const allow = page.getByRole("button", { name: "Allow once" })
  const gone = page.getByText("No longer waiting for an answer")

  await page.goto(`${app}/c/e2e-approval-timeout`)
  await send("clean up the old logs")
  await allow.waitFor({ timeout: 20_000 })
  await endApprovals("timeout")
  await gone.waitFor({ timeout: 3_000 })
  assert.equal(await allow.count(), 0, "the card leaves the composer")
  assert.equal((await lastReply("e2e-approval-timeout"))?.status, "streaming", "before the reply ends")
  await page.getByText("Okay, I left everything as it is.").waitFor({ timeout: 15_000 })
  await shot("timed-out")
  pass("an approval the host timed out dismisses itself")

  await page.goto(`${app}/c/e2e-approval-lost`)
  await send("clean up the old logs")
  await allow.waitFor({ timeout: 20_000 })
  await endApprovals("lost")
  await allow.click()
  await gone.waitFor({ timeout: 10_000 })
  assert.equal(await page.getByText("Run has no pending approval").count(), 0, "no error toast")
  // The run's status still holds the old request; reading it again must not raise it again.
  await page.waitForTimeout(13_000)
  assert.equal(await allow.count(), 0, "the stale request isn't raised again")
  await shot("refused")
  pass("an answer refused with approval_not_pending marks the approval missed")
})
