// A composer's unsent text and a session's picked mode travel in the chat record the Gots plugin
// holds: typing and a pick in the Add context sheet reach it, they come back to a device that lost
// its copy, and typing leaves the chat's updatedAt (the activity clock the lists sort on) alone.
import { app, assert, flow, mock, pass } from "./lib.mjs"

const chat = "e2e-draft-sync"
const PROJECT = "p_1a2b3c4d"

/** The chat record the plugin holds for this chat, as the app pushed it. */
async function record() {
  const body = await fetch(`${mock}/api/plugins/memento/chats`).then((res) => res.json())
  return body.chats?.[chat]?.value ?? null
}

await flow("draft-mode-sync", async ({ page, seed, until, shot }) => {
  // A project session, so its composer carries the mode picker the pick comes from.
  await seed([{ id: chat, title: "Draft sync", projectId: PROJECT }])
  await page.goto(`${app}/c/${chat}`)
  const composer = page.getByRole("textbox").last()

  await composer.fill("half-written thought")
  await page.getByRole("button", { name: "Add context" }).click()
  await page.getByRole("radio", { name: /^Plan/ }).click()

  await until(
    async () => (await record())?.draftText === "half-written thought",
    20_000,
    "the typed draft to reach the plugin's chat record",
  )
  // The pick is its own write, so it syncs on the pass after the draft's, not with it.
  await until(
    async () => (await record())?.mode === "plan",
    20_000,
    "the picked mode to reach the plugin's chat record",
  )
  pass("typing and a mode pick reach the plugin's chat record")

  // This device loses its copy of the chat; the plugin's copy arrives on the next pull.
  await page.evaluate(async (id) => {
    const { deleteConversation } = await import("/src/lib/db.ts")
    await deleteConversation(id, { remote: true })
  }, chat)
  await page.reload()
  await until(
    () =>
      page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        return (await db.conversations.get(id))?.draftText === "half-written thought"
      }, chat),
    20_000,
    "the chat record to come back from the plugin",
  )
  await page.goto(`${app}/c/${chat}`)
  await composer.waitFor()
  await until(
    async () => (await composer.inputValue()) === "half-written thought",
    10_000,
    "the draft to fill the composer again",
  )
  await shot("draft-restored")
  pass("the draft comes back after the local row is cleared")

  const before = (await record())?.updatedAt
  await composer.fill("another line")
  await until(
    async () => (await record())?.draftText === "another line",
    20_000,
    "the new text to sync",
  )
  assert.equal((await record())?.updatedAt, before, "typing leaves the chat's updatedAt alone")
  pass("typing leaves updatedAt where it was")
})
