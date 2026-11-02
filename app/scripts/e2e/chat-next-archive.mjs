// A chat the host compacted in place, read on a device that holds none of it, where the host left
// nothing at the seam: no hidden row, no summary the app can date the boundary by — only the chat's
// own record of the compaction. The thread opens on its live window with the compaction's divider
// over it, which is the shape a reader reports as "there is a marker at the top and my messages are
// gone", and what the host archived is still its to give. Before the record was read the screen
// offered nothing — the control was gated on a row this host does not write, so a compacted chat
// could never be read back above its window. The flow says the offer is there, that asking puts
// every archived turn back once and in the host's order above the window, and that the divider
// comes to rest where the compaction ran rather than at the top of a truncated thread (ADR 0058).
import { app, assert, flow, mockPost, pass, runId, runStatus, startRun } from "./lib.mjs"

/** The words this device holds in one set of its transcript, oldest first. */
const held = (page, chatId, set = "live") =>
  page.evaluate(
    async ([id, which]) => {
      const { db } = await import("/src/lib/db.ts")
      const chat = await db.conversations.get(id)
      const rows = await db.sessionRows
        .where("[session+set+pos]")
        .between([chat.hermesSessionId, which, -Infinity], [chat.hermesSessionId, which, Infinity])
        .toArray()
      return rows.map((one) => one.row.content ?? "")
    },
    [chatId, set],
  )

/** Whether the device has read the chat all the way back. */
const whole = (page, chatId) =>
  page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    const chat = await db.conversations.get(id)
    return (await db.sessionStates.get(chat.hermesSessionId))?.archived === true
  }, chatId)

const drawn = (page) => page.evaluate(() => document.body.innerText)
const offers = (page) => page.locator("[data-earlier]").count()
const count = (text, word) => text.split(word).length - 1

/** A user's words, long enough that the window and the archive each fill a phone's pane. */
const long = (name) =>
  `${name}: ` + Array.from({ length: 6 }, (_, i) => `The ${name}'s point ${i + 1}.`).join(" ")

await flow(
  "chat-next-archive",
  async ({ page, seed, until, shot }) => {
    const chatId = `e2e-next-archive-${runId()}`
    await seed([{ id: chatId, title: "Compacted, no seam" }])
    await page.evaluate(async () => {
      const { db } = await import("/src/lib/db.ts")
      await db.settings.update("settings", { developer: true, chatNext: true })
    })
    const sessionId = await page.evaluate(
      async (id) =>
        (await (await import("/src/lib/db.ts")).db.conversations.get(id)).hermesSessionId,
      chatId,
    )

    // Another device holds the whole conversation; this one has never opened it.
    const archived = ["alpha", "bravo", "charlie"]
    for (const name of [...archived, "delta"]) {
      const run = await startRun(sessionId, long(name))
      await until(async () => (await runStatus(run)) === "completed", 30_000, `"${name}" to end`)
    }
    // The host compacts in place and leaves nothing at the seam: the rows it keeps live come back
    // under the same request, the rest are archived, and no row of either says a compaction ran.
    const compacted = await mockPost("/__mock/compact", {
      session_id: sessionId,
      rows: 2,
      hidden: false,
    })
    assert.equal(compacted.status, 200, "the host compacts the chat")
    const after = await startRun(sessionId, "zulu: the turn after the compaction")
    await until(async () => (await runStatus(after)) === "completed", 30_000, "the newest turn")

    // The chat opens on its live window, under the compaction's divider: what a reader sees when the
    // archived turns are not on this device.
    await page.goto(`${app}/c/${chatId}`)
    await until(
      async () => (await drawn(page)).includes("zulu:"),
      20_000,
      "the live window to land",
    )
    const window = await drawn(page)
    for (const name of archived) {
      assert.ok(!window.includes(`${name}:`), `"${name}" is above the window, not in it`)
      assert.ok(
        !(await held(page, chatId)).some((text) => text.includes(`${name}:`)),
        `"${name}" is not held by this device at all`,
      )
    }
    await page.getByText("Compaction").first().waitFor({ timeout: 10_000 })
    await shot("window")

    // The offer. The host's record says a compaction ran, and the rows it archived are the host's to
    // give, so the screen can ask for them even though no row of the transcript says where.
    assert.equal(await offers(page), 1, "the screen offers the messages the host archived")
    pass("a compaction with no seam still offers the rows it archived")

    await page.locator("[data-earlier]").click()
    await until(async () => whole(page, chatId), 30_000, "the archive to load")

    // The reading is whole: every archived turn on the device once, in the order the host archived
    // them, with the turns the compaction carried still live under the same request.
    const archive = await held(page, chatId, "archive")
    for (const name of archived)
      assert.equal(
        archive.filter((text) => text.includes(`${name}:`)).length,
        1,
        `"${name}" is archived once and held once`,
      )
    const places = archived.map((name) => archive.findIndex((text) => text.includes(`${name}:`)))
    assert.deepEqual(
      [...places].sort((a, b) => a - b),
      places,
      `archived in the host's order: ${places}`,
    )

    // The divider stays where the compaction ran — under the turn it carried, over the one that
    // followed — rather than climbing to the top of a thread that is whole again.
    const foot = await drawn(page)
    assert.ok(
      foot.indexOf("delta:") < foot.indexOf("Compaction") &&
        foot.indexOf("Compaction") < foot.indexOf("zulu:"),
      "the compaction's divider sits between the turns it carried and the turn after it",
    )
    assert.equal(count(foot, "Compaction"), 1, "one compaction, one divider")

    // The reader reaches the top of the thread and the oldest turn is there, above the ones it was
    // separated from: the rows the host archived come back where they belong.
    // Walked up the pane as a reader's own finger does it: chat-next draws what is near the
    // viewport, so the reach is a run of steps rather than one jump.
    for (let step = 0; step < 40; step += 1)
      await page.evaluate(() =>
        document.querySelector('[aria-label="Messages"]').scrollBy({ top: -3000 }),
      )
    await until(async () => (await drawn(page)).includes("alpha:"), 20_000, "the top of the thread")
    const head = await drawn(page)
    assert.ok(
      head.indexOf("alpha:") < head.indexOf("bravo:"),
      "the oldest archived turn reads above the next one",
    )
    assert.equal(await offers(page), 0, "the rows are in, so nothing is offered again")
    await shot("archive")
    pass("the archived turns come back once, in order, under a divider in its place")

    // The rows stay on the device with the chat, and the offer does not come back with them.
    await page.reload()
    await until(async () => (await held(page, chatId, "archive")).length > 0, 20_000, "the chat")
    assert.equal(
      (await held(page, chatId, "archive")).filter((text) => text.includes("alpha:")).length,
      1,
      "the archived turns are still the device's after a reload",
    )
    assert.equal(await offers(page), 0, "a chat already read back offers nothing")
    pass("a reload keeps the archive and asks for nothing")
  },
  { viewport: { width: 390, height: 700 }, touch: true },
)
