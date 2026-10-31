import { assert, flow, mock, openChatNext, pass } from "./lib.mjs"

async function body({ page, seed, send, shot, until }) {
  await openChatNext({ page, seed }, { id: "e2e-away", title: "Away" })
  const host = new URL(mock).origin
  const thread = page.locator('[aria-label="Messages"]')
  const header = () =>
    page.evaluate(
      () => document.querySelector('[data-slot="header-line"]')?.textContent ?? null,
    )
  const nudge = () =>
    page.evaluate(() => void document.dispatchEvent(new Event("visibilitychange")))
  const field = () => page.getByRole("textbox", { name: "Message" })
  const unsent = (text) => page.locator("[data-unsent]").filter({ hasText: text })

  await field().waitFor({ timeout: 20_000 })
  assert.equal(await field().isVisible(), true, "the composer is drawn")
  assert.equal(await header(), null, "and the header carries no line of its own")

  await page.route(`${host}/**`, (route) => route.abort("failed"))
  await nudge()
  await until(
    async () => (await header()) === "This host isn't answering",
    20_000,
    "the header to say the host isn't answering",
  )
  assert.equal(
    await thread.getByText("Can't reach this host right now.").count(),
    0,
    "nothing about the host is drawn in the thread",
  )
  await field().fill("a thought from the tunnel")
  assert.equal(await field().inputValue(), "a thought from the tunnel", "the composer takes typing")
  await shot("away")

  await page.context().setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event("offline")))
  await nudge()
  await until(async () => (await header()) === "You're offline", 20_000, "the header to name the device")
  assert.equal(await field().inputValue(), "a thought from the tunnel", "and the draft is still there")
  await shot("offline")

  await page.context().setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event("online")))
  await nudge()
  await until(
    async () => (await header()) === "This host isn't answering",
    20_000,
    "the header to name the host again",
  )

  // The host's reads go on failing — the chat is away, as it has been — while the turn's own start is
  // let through to a host that takes eight seconds over it and then says it never took it (the words
  // ask for it, "hold the start"). A send given a breath answers in ~4s with the row; one given a
  // read's fifteen seconds would only answer when the host did, at eight. The new route is laid over
  // the one that refuses everything, with no moment in between in which a read could land and take
  // the away state with it.
  await page.route(`${host}/**`, (route) => {
    const request = route.request()
    if (request.method() === "POST" && /\/v1\/runs$/.test(request.url()))
      return route.continue()
    return route.abort("failed")
  })
  const started = Date.now()
  await send("hold the start of this one")
  await unsent("hold the start of this one").waitFor({ timeout: 7_000 })
  const waited = Date.now() - started
  assert.ok(waited < 7_000, `a send made while away answers in a breath, not ${waited}ms`)

  assert.equal(
    await page.locator('[aria-label="Messages"] [data-unsent]').count(),
    1,
    "the message is in the thread",
  )
  const row = unsent("hold the start of this one")
  await row.getByRole("img", { name: "Not sent" }).waitFor({ timeout: 5_000 })
  assert.equal(await row.getByRole("button", { name: "Retry" }).count(), 1, "with Retry")
  assert.equal(
    await row.getByRole("button", { name: "Cancel failed message" }).count(),
    1,
    "and Cancel",
  )
  const dimmed = await row
    .locator("[data-slot=bubble-content]")
    .evaluate((bubble) => getComputedStyle(bubble.closest("[data-slot=bubble]") ?? bubble).opacity)
  assert.notEqual(dimmed, "1", "dimmed, as a message that isn't through yet wears it")
  assert.equal(await field().inputValue(), "", "and the words left the field")
  await shot("not-sent")

  await page.reload()
  await unsent("hold the start of this one").waitFor({ timeout: 20_000 })
  assert.equal(
    await unsent("hold the start of this one").getByRole("button", { name: "Retry" }).count(),
    1,
    "the message outlives a reload",
  )
  await shot("after-reload")

  await page.unroute(`${host}/**`)
  await unsent("hold the start of this one").getByRole("button", { name: "Retry" }).click()
  await until(
    async () => (await page.locator("[data-unsent]").count()) === 0,
    20_000,
    "the row to leave the thread once the host takes it",
  )
  await until(
    async () =>
      (await thread
        .locator("[data-slot=message]")
        .filter({ hasText: "hold the start of this one" })
        .count()) > 0,
    20_000,
    "the turn to draw the message the retry sent",
  )
  assert.equal(await page.getByRole("img", { name: "Not sent" }).count(), 0, "and nothing is marked")
  assert.equal(
    await thread.locator("[data-slot=message]").filter({ hasText: "hold the start of this one" }).count(),
    1,
    "the host took the turn once, though the message was sent twice",
  )
  await shot("resent")

  await until(
    async () => (await page.getByRole("button", { name: "Stop" }).count()) === 0,
    20_000,
    "the reply the retry started to finish",
  )
  await page.route(`${host}/**`, (route) => route.abort("failed"))
  await nudge()
  await until(
    async () => (await header()) === "This host isn't answering",
    20_000,
    "the header to say the host is away again",
  )
  await send("and this one is taken back")
  await unsent("and this one is taken back").waitFor({ timeout: 10_000 })
  await unsent("and this one is taken back")
    .getByRole("button", { name: "Cancel failed message" })
    .click()
  await until(
    async () => (await page.locator("[data-unsent]").count()) === 0,
    10_000,
    "the message to be taken back",
  )
  assert.equal(await field().inputValue(), "", "and its words don't come back to the field")
  await shot("cancelled")

  await page.unroute(`${host}/**`)
}

await flow("away", body, { viewport: { width: 390, height: 844 }, dark: true })

pass("away is the header's word, and a message the host didn't take stays in the thread")
