// A chat's model changed mid-thread: the pill under the composer picks a new one, and the thread
// draws a divider naming it above the turn it answered with — after a reload too, and in a session.
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
    const response = await fetch(`${mock}/api/plugins/memento/sessions/${session}/context`)
    return (await response.json()).model_changes ?? []
  }
  const stored = async (id) =>
    (await page.evaluate(async (chat) => {
      const { db } = await import("/src/lib/db.ts")
      return (await db.conversations.get(chat))?.modelChanges ?? null
    }, id)) ?? []

  // One model throughout: nothing in the thread says anything.
  await page.goto(app)
  await page.getByRole("button", { name: /^Model:/ }).waitFor({ timeout: 15_000 })
  await pick(sonnet)
  await send("hello there")
  await page.waitForURL("**/c/**", { timeout: 15_000 })
  const id = chatId()
  await done()
  assert.equal(await divider().count(), 0, "one model in, nothing to say")

  // Switched with the pill: the divider lands above the turn the new model answered with.
  await pick(gpt)
  await send("and again")
  await until(async () => (await divider().count()) === 1, 15_000, "the divider to appear")
  await page.getByText("and again").last().waitFor()
  assert.equal((await divider().innerText()).trim(), "gpt-5", "the divider names the new model")
  const place = await page.evaluate(() => {
    const items = [...document.querySelectorAll("[data-slot=message-scroller-item]")]
    return {
      divider: items.findIndex((item) => item.querySelector("[role=separator]")),
      turn: items.findIndex((item) => item.textContent?.includes("and again")),
    }
  })
  assert.equal(place.divider, place.turn, "and sits above the turn it answered with")
  assert.deepEqual(
    (await hosted(id)).map((c) => c.model),
    [sonnet, gpt],
    "the host recorded both models",
  )
  assert.deepEqual(
    (await stored(id)).map((c) => c.model),
    [sonnet, gpt],
    "and the device kept what it read",
  )
  await shot("chat")

  // Still there after a reload: the device keeps the list, and reads the host's again on open.
  await page.reload()
  await until(async () => (await divider().count()) === 1, 15_000, "the divider after a reload")
  assert.equal((await divider().innerText()).trim(), "gpt-5", "the divider survives a reload")

  // Picking the same model again changes nothing: no row on the host, no second divider.
  await pick(gpt)
  await send("and once more")
  await done()
  assert.equal(await divider().count(), 1, "re-picking the model adds no divider")
  assert.equal((await hosted(id)).length, 2, "and the host records no second switch")
  pass("a chat's switch shows once, above the turn it answered with, and survives a reload")

  // A project session's thread draws it too.
  await seed([{ id: "e2e-model-switch", title: "Switch the model", projectId: "p_1a2b3c4d" }])
  await page.goto(`${app}/c/e2e-model-switch`)
  await pick(sonnet)
  await send("start the work")
  await done()
  await pick(gpt)
  await send("carry on")
  await until(async () => (await divider().count()) === 1, 15_000, "the session's divider")
  assert.equal((await divider().innerText()).trim(), "gpt-5", "a session names the new model too")
  await shot("session")
  pass("a project session shows the divider as well")
})
