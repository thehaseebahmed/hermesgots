// A reply's closed ```mermaid fence draws its frame where the fence stood, and the same fence, still
// arriving, is drawn as the code it is until its closer lands. Only a reply that is really streaming
// can show the second half: the app writes a reply as its pieces land, so a fence's body and its
// closer are two states of the page, and a component test handed the finished string has only one.
import { app, assert, flow, pass } from "./lib.mjs"

const REPLY = "[data-slot=message][data-align=start]"
const FRAME = "[data-slot=diagram]"
// A fence's code block lives in the reply's markdown, not merely somewhere in its row: a turn's tool
// rows are drawn in that same row and a tool's command is a code block of its own. And it is a
// *block* — a phrase of inline code carries the marker too, which is how a reply's prose is drawn.
const FENCE_CODE = "[data-slot=markdown] div[data-md-code]"

/**
 * Records every state of the last reply the page commits, from the send on: its code blocks, its
 * frames, and how much of its words have arrived. A state lives for as long as one batched write
 * does, which is shorter than any poll a flow could run, so the record is the reading and a poll is
 * never the thing that finds it.
 */
const watchFence = (page) =>
  page.evaluate(() => {
    window.__fence = []
    let waiting = false
    const read = () => {
      const reply = [...document.querySelectorAll("[data-slot=message][data-align=start]")].at(-1)
      if (!reply) return
      window.__fence.push({
        code: reply.querySelectorAll("[data-slot=markdown] div[data-md-code]").length,
        frame: reply.querySelectorAll("[data-slot=diagram]").length,
        words: (reply.textContent ?? "").length,
      })
    }
    const observer = new MutationObserver(() => {
      // One state per commit: a write lands as a burst of mutations, and they are one arrangement.
      if (waiting) return
      waiting = true
      requestAnimationFrame(() => {
        waiting = false
        read()
      })
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    window.__fenceRead = () => {
      observer.disconnect()
      return window.__fence
    }
  })

await flow(
  "mermaid",
  async ({ page, send, lastReply, newChat, until, shot }) => {
    await page.goto(app)
    const chatId = await newChat()
    await watchFence(page)
    await send("draw a diagram")
    const reply = page.locator(REPLY).last()
    const frame = reply.locator(FRAME)

    // The frame lands with the closing fence; the reply's last words are still to come.
    await until(
      () => frame.count().then((count) => count === 1),
      30_000,
      "the fence's frame to draw",
    )
    await until(
      async () => (await lastReply(chatId))?.status === "done",
      60_000,
      "the reply to reach its end",
    )
    const said = await lastReply(chatId)
    assert.match(said.content, /from the fence to the picture\./, "the reply reached its last words")

    // The finished reply: the fence's frame where the fence stood, and the code block it is not.
    assert.equal(
      await reply.locator(FENCE_CODE).count(),
      0,
      "the fence that closed draws no code block",
    )

    const order = await reply.evaluate((row) => {
      const drawn = row.querySelector("[data-slot=diagram]")
      const paragraph = (start) =>
        [...row.querySelectorAll("p")].find((p) => (p.textContent ?? "").startsWith(start))
      const intro = paragraph("Here's the flow")
      const outro = paragraph("That's every step")
      const follows = (one, other) =>
        Boolean(one.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING)
      return {
        found: Boolean(intro) && Boolean(outro),
        stands: Boolean(intro && outro && follows(intro, drawn) && follows(drawn, outro)),
      }
    })
    assert.ok(order.found, "the reply's words stand on either side of the fence")
    assert.ok(order.stands, "the frame stands where the fence stood, between the words around it")

    const label = await frame.locator("span").first().textContent()
    assert.equal(label, "mermaid", "the frame is labelled with the fence's own language")
    assert.equal(
      await frame.getByRole("button", { name: "Copy code" }).count(),
      1,
      "and carries the copy control a code block does",
    )
    const path = await shot("frame")
    pass(
      `a closed fence drew its frame${path ? ` (${path})` : ""}: named ${label}, its copy control there, and no code block left`,
    )

    // The fence while it was still arriving, as the page committed it.
    const states = await page.evaluate(() => window.__fenceRead())
    assert.ok(states.length > 0, "the page committed the reply as it arrived")
    const words = Math.max(...states.map((state) => state.words))
    const asCode = states.filter((state) => state.code > 0 && state.frame === 0)
    assert.ok(
      asCode.length > 0,
      `the fence drew as code while it arrived (${states.length} states, ${states
        .map((state) => `${state.code}/${state.frame}`)
        .join(" ")})`,
    )
    assert.ok(
      asCode.some((state) => state.words < words),
      `and while its words were still coming (${asCode
        .map((state) => state.words)
        .join(", ")} of ${words} characters)`,
    )
    const framed = states.findIndex((state) => state.frame > 0)
    assert.ok(framed > 0, "the frame arrives after the fence's code, never before it")
    assert.ok(
      states[framed].words < words,
      `and while the reply still had words to come (${states[framed].words} of ${words} characters)`,
    )
    assert.deepEqual(
      states.slice(framed).map((state) => `${state.code}/${state.frame}`),
      states.slice(framed).map(() => "0/1"),
      "and no code block is drawn again once the frame has",
    )
    pass(
      `the fence was code for ${asCode.length} of ${states.length} states while the reply arrived, then a frame for the ${states.length - framed} after its closer landed`,
    )
  },
  { viewport: { width: 390, height: 844 } },
)
