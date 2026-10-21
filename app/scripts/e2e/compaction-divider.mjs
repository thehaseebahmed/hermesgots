// The host compacted a chat's context between two turns: the thread draws a divider above the turn
// that ran on the compacted context, the model change's squiggle labelled Conversation compacted.
import { app, assert, compress, flow, pass, runId } from "./lib.mjs"

for (const [name, viewport, dark] of [
  ["compaction-divider", { width: 1440, height: 900 }, false],
  ["compaction-divider-narrow", { width: 320, height: 640 }, false],
  ["compaction-divider-phone-dark", { width: 390, height: 844 }, true],
]) {
  await flow(
    name,
    async ({ page, seed, send, lastReply, until, shot }) => {
      const chatId = `e2e-compact-${runId()}`
      const sessionId = `memento-${chatId}`
      const divider = page.locator("[data-slot=message-scroller-item] [role=separator]")
      await seed([{ id: chatId, title: "A long chat", hermesSessionId: sessionId }])
      await page.goto(`${app}/c/${chatId}`)
      const done = () =>
        until(
          async () => (await lastReply(chatId))?.status === "done",
          20_000,
          "the reply to finish",
        )

      await send("first question")
      await done()
      assert.equal(await divider.count(), 0, "nothing compacted, nothing marked")

      const rotated = await compress(sessionId, `${sessionId}-c1`)
      assert.equal(rotated.status, 200, "the host compacts the chat")
      await new Promise((r) => setTimeout(r, 1100))
      await send("second question")
      await done()
      await until(async () => (await divider.count()) === 1, 15_000, "the divider to appear")
      const text = (await divider.innerText()).trim()
      assert.match(text, /^Conversation compacted at \d+%$/, "with how full it was")
      const place = await page.evaluate(() => {
        const items = [...document.querySelectorAll("[data-slot=message-scroller-item]")]
        return {
          divider: items.findIndex((item) => item.querySelector("[role=separator]")),
          turn: items.findIndex((item) => item.textContent?.includes("second question")),
        }
      })
      assert.equal(
        place.divider,
        place.turn,
        "and sits above the turn that ran on the compacted context",
      )
      await divider.evaluate((el) => el.scrollIntoView({ block: "center" }))
      await page.waitForTimeout(400)
      await shot("thread")
      if (process.env.SHOTS_DIR)
        await divider.screenshot({ path: `${process.env.SHOTS_DIR}/${name}-divider.png` })
      pass("the thread marks the compaction")
    },
    { viewport, dark },
  )
}
