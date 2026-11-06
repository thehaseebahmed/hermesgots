// A model changed mid-thread: the pill under the composer picks a new one. A project session draws a
// divider naming it above the turn it answered with — after a reload too, and as the turn opens where
// the host's record hasn't reached this device yet. A bot's chat keeps the record and draws nothing: a
// model a chat fell onto mid-run is a detail of the run, not a mark on the work (ADR 0087).
import { app, assert, flow, mock, pass } from "./lib.mjs"

await flow("model-switch", async ({ page, seed, send, lastReply, until, shot }) => {
  const sonnet = "anthropic/claude-sonnet-4.5"
  const gpt = "openai/gpt-5"
  // Scoped to the thread: a divider is what a turn carries above it.
  const divider = () => page.locator("[data-slot=message-scroller-item] [role=separator]")
  const chatId = () => new URL(page.url()).pathname.split("/").at(-1)
  // The pill's own picker: a row is named by its model id, then the facts under it.
  const pick = async (model) => {
    await page.getByRole("button", { name: /^Model:/ }).click()
    const picker = page.getByRole("dialog")
    await picker.getByRole("textbox", { name: "Search models" }).fill(model)
    const row = new RegExp(`^${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `)
    await picker.getByRole("button", { name: row }).click()
    // The composer's own input is the last one on the page: wait for the picker's to go.
    await picker.waitFor({ state: "hidden" })
  }
  const done = () =>
    until(async () => (await lastReply(chatId()))?.status === "done", 20_000, "the reply to finish")
  // The host's own record for a chat, and what this device kept of it.
  const hosted = async (id) => {
    const session = await page.evaluate(async (chat) => {
      const { db } = await import("/src/lib/db.ts")
      return (await db.conversations.get(chat))?.hermesSessionId
    }, id)
    const response = await fetch(`${mock}/api/plugins/gots/sessions/${session}/context`)
    return (await response.json()).model_changes ?? []
  }
  const stored = async (id) =>
    (await page.evaluate(async (chat) => {
      const { db } = await import("/src/lib/db.ts")
      return (await db.conversations.get(chat))?.modelChanges ?? null
    }, id)) ?? []

  // A bot's chat: one model in, then a switch. The host records both, and the thread stays silent.
  await page.goto(app)
  await page.getByRole("button", { name: /^Model:/ }).waitFor({ timeout: 15_000 })
  await pick(sonnet)
  await send("hello there")
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  const id = chatId()
  await done()
  assert.equal(await divider().count(), 0, "one model in, nothing to say")

  await pick(gpt)
  await send("and again")
  await done()
  assert.equal(await divider().count(), 0, "a chat draws no model change at all")
  assert.deepEqual(
    (await hosted(id)).map((c) => c.model),
    [sonnet, gpt],
    "though the host recorded both models",
  )
  assert.deepEqual(
    (await stored(id)).map((c) => c.model),
    [sonnet, gpt],
    "and the device kept what it read",
  )
  await shot("chat")
  pass("a chat keeps the record and draws no model change")

  // A project session draws it: above the turn the new model answered with.
  await seed([{ id: "e2e-model-switch", title: "Switch the model", projectId: "p_1a2b3c4d" }])
  await page.goto(`${app}/c/e2e-model-switch`)
  await pick(sonnet)
  await send("start the work")
  await done()
  await pick(gpt)
  await send("carry on")
  await until(async () => (await divider().count()) === 1, 15_000, "the session's divider")
  await page.getByText("carry on").last().waitFor()
  assert.equal((await divider().innerText()).trim(), gpt, "a session names the new model")
  const place = await page.evaluate(() => {
    const items = [...document.querySelectorAll("[data-slot=message-scroller-item]")]
    return {
      divider: items.findIndex((item) => item.querySelector("[role=separator]")),
      turn: items.findIndex((item) => item.textContent?.includes("carry on")),
    }
  })
  assert.equal(place.divider, place.turn, "and sits above the turn it answered with")
  await done()
  await shot("session")

  // Still there after a reload: the device keeps the list, and reads the host's again on open.
  await page.reload()
  await until(async () => (await divider().count()) === 1, 15_000, "the divider after a reload")
  assert.equal((await divider().innerText()).trim(), gpt, "the divider survives a reload")

  // Picking the same model again changes nothing: no row on the host, no second divider.
  const session = chatId()
  await pick(gpt)
  await send("and once more")
  await done()
  assert.equal(await divider().count(), 1, "re-picking the model adds no divider")
  assert.equal((await hosted(session)).length, 2, "and the host records no second switch")
  pass("a session's switch shows once, above the turn it answered with, and survives a reload")

  // A session whose first turn was sent with nothing picked: the host ran its own model, and this
  // device has no pick to name it by, so the switch's divider can only come from the host's record —
  // asked for as the turn opens, not when the turn it started ends. An empty store is what a device
  // that hasn't read the record looks like: the row is on the host, not on us yet.
  await seed([{ id: "e2e-model-switch-blank", title: "Switch blank", projectId: "p_1a2b3c4d" }])
  await page.goto(`${app}/c/e2e-model-switch-blank`)
  await send("start the work")
  await done()
  await page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    await db.conversations.update(id, { modelChanges: undefined })
  }, chatId())
  // The wipe has to stick: the turn-end read lands after `done()`, and were it to write the record
  // back the next send would have nothing to ask for — the divider would come from the old path.
  await until(async () => (await stored(chatId())).length === 0, 3_000, "the record to be cleared")
  await pick(gpt)
  await send("carry on")
  // One poll for both facts: a divider up while the turn is still being written is the whole point, so
  // they have to be true at the same instant to count.
  await until(
    async () =>
      (await divider().count()) === 1 && (await lastReply(chatId()))?.status === "streaming",
    3_000,
    "the divider while the turn runs",
  )
  assert.equal((await divider().innerText()).trim(), gpt, "and names the model it was sent with")
  await shot("blank")
  pass("a switch this device has no model for shows as the turn opens")
})
