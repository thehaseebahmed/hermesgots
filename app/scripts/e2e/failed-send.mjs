// A message whose send fails — nothing reaches Hermes at all — stays in the thread wearing the dimmed
// green a queued message wears, with a mark beside it, and can be sent again or taken back. It says it
// didn't go and no more: a reason, when the host gives one, belongs in the chat's own error, not under
// the message. The state is on the device, so it outlives a reload. Sends are refused meanwhile, as a
// host the browser can't reach, or one that answers with its own reason, does.
import { app, assert, flow, LOOKS, pass, runId } from "./lib.mjs"

const REFUSAL = "Rate limit exceeded. Try again in a few seconds."

/** The chat's stored messages, oldest first. */
const messages = (page, chatId) =>
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

/** With nothing streaming, a send starts a turn here rather than waiting in the queue. */
const idle = (page, chatId) =>
  page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    const rows = await db.messages.where("conversationId").equals(id).toArray()
    return !rows.some((m) => m.status === "streaming" || m.status === "queued")
  }, chatId)

/**
 * The bubble's own colour and opacity beside the ones the page offers, which is how a message that
 * didn't go reads: the green a send goes in, at less than full strength — the same dimmed bubble a
 * queued message wears — and not the page's flat grey.
 */
const bubbleLook = (row) =>
  row.locator("[data-slot=bubble-content]").evaluate((bubble) => {
    const probe = (className) => {
      const div = document.createElement("div")
      div.className = className
      document.body.append(div)
      const colour = getComputedStyle(div).backgroundColor
      div.remove()
      return colour
    }
    const own = getComputedStyle(bubble)
    // The dimming sits on the bubble, not on its content: a child's own opacity stays 1 whatever its
    // parent wears, so read the frame that carries the class.
    const frame = getComputedStyle(bubble.closest("[data-slot=bubble]") ?? bubble)
    return {
      colour: own.backgroundColor,
      opacity: frame.opacity,
      green: probe("bg-primary"),
      grey: probe("bg-muted"),
    }
  })

/** The state a message that never reached the host is in: dimmed, marked beside it, two ways out. */
async function assertNotSent(page, row, what) {
  await row.getByRole("img", { name: "Not sent" }).waitFor({ timeout: 20_000 })
  const look = await bubbleLook(row)
  assert.equal(look.colour, look.green, `${what}: the bubble wears the green a send goes in`)
  assert.notEqual(look.colour, look.grey, `${what}: not the page's flat grey`)
  assert.notEqual(look.opacity, "1", `${what}: dimmed, not the strength a delivered one has`)
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

async function body({ page, seed, send, lastReply, until, shot, row, photo }) {
  const chat = `e2e-failed-send-${runId()}`
  await seed([{ id: chat, title: "Failed send" }])
  await page.goto(`${app}/c/${chat}`)

  // Nothing leaves the browser: the message keeps its place and its text, and no half-reply is left
  // beside it.
  await blockSends(page)
  await send("count the old logs")
  const logs = row("count the old logs")
  await assertNotSent(page, logs, "a send the browser couldn't make")
  assert.deepEqual(await messages(page, chat), [
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
  await photo(chat, "log the whole disk")
  const sent = async () =>
    (await messages(page, chat)).find((m) => m.content === "log the whole disk")
  await until(async () => (await sent())?.status === "error", 30_000, "the photo's send to fail")
  await assertNotSent(page, row("log the whole disk"), "a send the host turned down")
  assert.equal(await page.getByText(REFUSAL).count(), 0, "the reason isn't repeated under it")
  assert.deepEqual(await sent(), {
    role: "user",
    status: "error",
    content: "log the whole disk",
    attachments: ["photo.png"],
  })
  await shot("refused")

  await page.unroute("**/v1/**")
  await row("log the whole disk").getByRole("button", { name: "Retry" }).click()
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
      (await messages(page, chat)).some(
        (m) => m.content === "and the ones from last week" && m.status === "error",
      ),
    20_000,
    "the second send to fail",
  )
  await row("and the ones from last week")
    .getByRole("button", { name: "Cancel failed message" })
    .click()
  await until(
    async () =>
      !(await messages(page, chat)).some((m) => m.content === "and the ones from last week"),
    10_000,
    "the failed message to be taken back",
  )
  await shot("cancelled")

  // The cue is the one a queued message wears. Side by side: a send that failed and one waiting its
  // turn dim their bubbles the same way, and only the failed one is marked.
  await until(() => idle(page, chat), 30_000, "the chat to be idle")
  await blockSends(page)
  await send("and this one as well")
  const stuck = row("and this one as well")
  await assertNotSent(page, stuck, "a failed send beside a queued one")
  await page.unroute("**/v1/**")
  await send("go slow about it") // the mock answers this one in 20 steps, to queue behind
  await until(
    async () => (await lastReply(chat))?.status === "streaming",
    30_000,
    "the reply to start streaming",
  )
  await send("queue this one behind it")
  await until(
    async () =>
      (await messages(page, chat)).some(
        (m) => m.content === "queue this one behind it" && m.status === "queued",
      ),
    20_000,
    "the send to wait its turn",
  )
  const waiting = row("queue this one behind it")
  assert.equal(
    await waiting.getByRole("img", { name: "Not sent" }).count(),
    0,
    "a queued send isn't marked as failed",
  )
  const queuedLook = await bubbleLook(waiting)
  const failedLook = await bubbleLook(stuck)
  assert.equal(queuedLook.colour, failedLook.colour, "the two bubbles wear the same colour")
  assert.equal(queuedLook.opacity, failedLook.opacity, "…and the same dimming")

  // The controls read alike too: Retry works while the reply streams, the way the composer's send
  // does, rather than sitting there greyed out — and it queues the message it carries.
  const retry = stuck.getByRole("button", { name: "Retry" })
  assert.equal(await retry.isDisabled(), false, "Retry isn't dead while a reply streams")
  assert.equal(
    await retry.evaluate((element) => getComputedStyle(element).opacity),
    "1",
    "…and isn't faded out",
  )
  await shot("beside-queued")
  await retry.click()
  await until(
    async () =>
      (await messages(page, chat)).some(
        (m) => m.content === "and this one as well" && m.status === "queued",
      ),
    20_000,
    "the retried send to wait in the queue",
  )
  assert.equal(
    await stuck.getByRole("img", { name: "Not sent" }).count(),
    0,
    "it waits as a queued send now, not a failed one",
  )
  await shot("retried-into-queue")
}

// The mark, the dim bubble and the two controls have to read right on a laptop and on a phone in
// the dark.
for (const { look, options } of LOOKS) await flow(`failed-send-${look}`, body, options)

pass("a failed send is kept, sent again with what it held, and taken back on request")
