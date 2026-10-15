// A message whose send fails — nothing reaches Hermes at all — stays in the thread with its text
// and its attachments, marked Failed, and can be sent again or dropped. Its state is on the device,
// so it outlives a reload. Sends are refused meanwhile, as a host the browser can't reach, or one
// that answers with its own reason, does.
import { app, assert, flow, pass, runId } from "./lib.mjs"

const REFUSAL = "Rate limit exceeded. Try again in a few seconds."

const stored = (page, chatId) =>
  page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    const rows = await db.messages.where("conversationId").equals(id).sortBy("createdAt")
    return rows.map((m) => ({
      role: m.role,
      status: m.status,
      content: m.content,
      attachments: m.attachments?.map((a) => a.name),
    }))
  }, chatId)

/** Every send is refused: the browser can't reach the host at all (a CORS block looks like this). */
const blockSends = (page) =>
  page.route("**/v1/**", (route) =>
    route.request().method() === "POST" ? route.abort("failed") : route.continue(),
  )

/** The host takes the request and turns it down, with its own message. */
const refuseSends = (page) =>
  page.route("**/v1/**", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 429,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: REFUSAL } }),
        })
      : route.continue(),
  )

/** Sends a photo from the page, as the composer's own attachment flow would. */
const sendPhoto = (page, chatId) =>
  page
    .evaluate(async (id) => {
      const { prepareAttachment } = await import("/src/lib/attachments.ts")
      const { sendMessage } = await import("/src/lib/chat.ts")
      const canvas = Object.assign(document.createElement("canvas"), { width: 8, height: 8 })
      const blob = await new Promise((done) => canvas.toBlob(done, "image/png"))
      const photo = await prepareAttachment(new File([blob], "photo.png", { type: "image/png" }))
      void sendMessage(id, "log the whole disk", { attachments: [photo] })
    }, chatId)
    .catch(() => undefined)

/** With nothing streaming, a send starts a turn here rather than waiting in the queue. */
const idle = (page, chatId) =>
  page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    const rows = await db.messages.where("conversationId").equals(id).toArray()
    return !rows.some((m) => m.status === "streaming" || m.status === "queued")
  }, chatId)

await flow("failed-send", async ({ page, seed, send, lastReply, until, shot }) => {
  const chat = `e2e-failed-send-${runId()}`
  await seed([{ id: chat, title: "Failed send" }])
  await page.goto(`${app}/c/${chat}`)

  // Nothing leaves the browser: the message keeps its place and its text, and no half-reply is left
  // beside it.
  await blockSends(page)
  await send("count the old logs")
  const failed = page.getByText("Failed", { exact: true })
  await failed.first().waitFor({ timeout: 20_000 })
  assert.deepEqual(await stored(page, chat), [
    { role: "user", status: "error", content: "count the old logs", attachments: undefined },
  ])
  await shot("failed")

  // It survives a reload, and sending again goes through once the host answers.
  await page.reload()
  await failed.first().waitFor({ timeout: 20_000 })
  await page.unroute("**/v1/**")
  await page.getByRole("button", { name: "Retry" }).click()
  await until(
    async () => (await lastReply(chat))?.status === "done",
    30_000,
    "the reply to arrive after the retry",
  )
  assert.equal(await failed.count(), 0, "the message is no longer failed")
  await shot("resent")

  // A host that refuses the turn says why, and the message keeps its attachment to go again with.
  await until(() => idle(page, chat), 30_000, "the chat to be idle")
  await refuseSends(page)
  await sendPhoto(page, chat)
  const sent = async () => (await stored(page, chat)).find((m) => m.content === "log the whole disk")
  await until(
    async () => (await sent())?.status === "error",
    30_000,
    "the photo's send to fail",
  )
  assert.equal(
    await failed.first().getAttribute("title"),
    REFUSAL,
    "the host's own message is what the failure says",
  )
  assert.deepEqual(await sent(), {
    role: "user",
    status: "error",
    content: "log the whole disk",
    attachments: ["photo.png"],
  })
  await shot("refused")

  await page.unroute("**/v1/**")
  await page.getByRole("button", { name: "Retry" }).click()
  await until(async () => (await sent())?.status === "done", 30_000, "the photo's message to go through")
  assert.deepEqual(await sent(), {
    role: "user",
    status: "done",
    content: "log the whole disk",
    attachments: ["photo.png"],
  })

  // Dropping one takes its text with it.
  await until(() => idle(page, chat), 30_000, "the chat to be idle")
  await blockSends(page)
  await send("and the ones from last week")
  await until(
    async () =>
      (await stored(page, chat)).some(
        (m) => m.content === "and the ones from last week" && m.status === "error",
      ),
    20_000,
    "the second send to fail",
  )
  await page.getByRole("button", { name: "Discard failed message" }).click()
  await until(
    async () => !(await stored(page, chat)).some((m) => m.content === "and the ones from last week"),
    10_000,
    "the failed message to be dropped",
  )
  await shot("dropped")
  pass("a failed send is kept, sent again with what it held, and dropped on request")
})
