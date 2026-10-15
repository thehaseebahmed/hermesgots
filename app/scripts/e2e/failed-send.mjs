// A message whose send fails — nothing reaches Hermes at all — stays in the thread, dimmed with a
// mark beside it, and can be sent again or taken back. It says it didn't go and no more: a reason,
// when the host gives one, belongs in the chat's own error, not under the message. The state is on
// the device, so it outlives a reload. Sends are refused meanwhile, as a host the browser can't
// reach, or one that answers with its own reason, does.
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

const rowOf = (page, text) => page.locator("[data-slot=message]").filter({ hasText: text })

/**
 * The bubble's own colour beside the two the page offers, which is how a message that didn't go
 * reads: the dim colour, not the green a delivered one wears.
 */
const bubbleColour = (row) =>
  row.locator("[data-slot=bubble-content]").evaluate((bubble) => {
    const probe = (className) => {
      const div = document.createElement("div")
      div.className = className
      document.body.append(div)
      const colour = getComputedStyle(div).backgroundColor
      div.remove()
      return colour
    }
    return {
      own: getComputedStyle(bubble).backgroundColor,
      dim: probe("bg-muted"),
      sent: probe("bg-primary"),
    }
  })

/** The state a message that never reached the host is in: dim, marked beside it, two ways out. */
async function assertNotSent(page, row, what) {
  await row.getByRole("img", { name: "Not sent" }).waitFor({ timeout: 20_000 })
  const colour = await bubbleColour(row)
  assert.equal(colour.own, colour.dim, `${what}: the bubble wears the dim colour`)
  assert.notEqual(colour.own, colour.sent, `${what}: it doesn't read as delivered`)
  assert.equal(
    await row.getByRole("button", { name: "Retry" }).count(),
    1,
    `${what}: it can be sent again`,
  )
  assert.equal(
    await row.getByRole("button", { name: "Cancel failed message" }).count(),
    1,
    `${what}: it can be taken back`,
  )
}

async function body({ page, seed, send, lastReply, until, shot }) {
  const chat = `e2e-failed-send-${runId()}`
  await seed([{ id: chat, title: "Failed send" }])
  await page.goto(`${app}/c/${chat}`)

  // Nothing leaves the browser: the message keeps its place and its text, and no half-reply is left
  // beside it.
  await blockSends(page)
  await send("count the old logs")
  const logs = rowOf(page, "count the old logs")
  await assertNotSent(page, logs, "a send the browser couldn't make")
  assert.deepEqual(await stored(page, chat), [
    { role: "user", status: "error", content: "count the old logs", attachments: undefined },
  ])
  await shot("failed")

  // It survives a reload, and sending again goes through once the host answers.
  await page.reload()
  await assertNotSent(page, logs, "a failed send after a reload")
  await page.unroute("**/v1/**")
  await logs.getByRole("button", { name: "Retry" }).click()
  await until(
    async () => (await lastReply(chat))?.status === "done",
    30_000,
    "the reply to arrive after the retry",
  )
  assert.equal(
    await page.getByRole("img", { name: "Not sent" }).count(),
    0,
    "the message is no longer marked",
  )
  await shot("resent")

  // A host that refuses the turn: the message keeps its attachment to go again with, and the host's
  // own reason is not repeated under it — a reason belongs in the chat's error, not here.
  await until(() => idle(page, chat), 30_000, "the chat to be idle")
  await refuseSends(page)
  await sendPhoto(page, chat)
  const sent = async () => (await stored(page, chat)).find((m) => m.content === "log the whole disk")
  await until(async () => (await sent())?.status === "error", 30_000, "the photo's send to fail")
  await assertNotSent(page, rowOf(page, "log the whole disk"), "a send the host turned down")
  assert.equal(await page.getByText(REFUSAL).count(), 0, "the reason isn't repeated under it")
  assert.deepEqual(await sent(), {
    role: "user",
    status: "error",
    content: "log the whole disk",
    attachments: ["photo.png"],
  })
  await shot("refused")

  await page.unroute("**/v1/**")
  await rowOf(page, "log the whole disk").getByRole("button", { name: "Retry" }).click()
  await until(async () => (await sent())?.status === "done", 30_000, "the photo's message to go through")
  assert.deepEqual(await sent(), {
    role: "user",
    status: "done",
    content: "log the whole disk",
    attachments: ["photo.png"],
  })

  // Taking one back removes it and its text.
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
  await rowOf(page, "and the ones from last week")
    .getByRole("button", { name: "Cancel failed message" })
    .click()
  await until(
    async () => !(await stored(page, chat)).some((m) => m.content === "and the ones from last week"),
    10_000,
    "the failed message to be taken back",
  )
  await shot("cancelled")
}

// The mark, the dim bubble and the two controls have to read right on a laptop and on a phone in
// the dark.
for (const width of [1440, 390]) {
  const look = width < 768 ? "phone-dark" : "laptop"
  await flow(`failed-send-${look}`, body, {
    viewport: { width, height: width < 768 ? 844 : 900 },
    dark: width < 768,
  })
}

pass("a failed send is kept, sent again with what it held, and taken back on request")
