// A reply's closed ```mermaid fence is a picture where the fence stood, drawn in the app's own
// colours at a phone's width and a tablet's, in both themes — and the same fence, still arriving, is
// drawn as the code it is until its closer lands. Only a reply that is really streaming can show
// the second half: the app writes a reply as its pieces land, so a fence's body and its closer are
// two states of the page, and a component test handed the finished string has only one. The drawing
// itself is this flow's, because mermaid measures a diagram with `getBBox` and no DOM without layout
// has one.
import { app, assert, flow, pass } from "./lib.mjs"

const REPLY = "[data-slot=message][data-align=start]"
const FRAME = "[data-slot=diagram]"
// The source a fence mermaid refused is drawn as the code it is, and one quiet line says why.
const LINE = "[data-slot=diagram-line]"
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

/**
 * The drawing as the page holds it: the svg inside the last frame, how wide it is beside its column,
 * its own natural width, and the colour mermaid was told to draw its words in — read off the rule
 * mermaid writes for its own root, which is the app's foreground or a colour of mermaid's own. The
 * page's foreground is read beside it, as hex, so the two can be held against each other in either
 * mode: a diagram's colours are the app's own, which is what the theme map is for.
 */
const drawnFacts = (page) =>
  page.evaluate(() => {
    const frame = [...document.querySelectorAll("[data-slot=diagram]")].at(-1)
    if (!frame) return { frame: false }
    // The drawing names itself: mermaid's svg carries the id it was rendered under, and the frame's
    // chrome carries lucide icons, which carry none.
    const svg = frame.querySelector("svg[id]")
    if (!svg) return { frame: true, svg: false }
    const column = frame.closest("[data-slot=markdown]") ?? frame.parentElement
    // mermaid's root rule, first in the style it writes: `#id{font-family:…;fill:<textColor>;}`.
    const rule = /#[\w-]+\{([^}]*)\}/.exec(svg.querySelector("style")?.textContent ?? "")?.[1] ?? ""
    const ink = /fill:\s*(#[0-9a-f]{6})/i.exec(rule)?.[1]?.toLowerCase() ?? ""
    const canvas = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext(
      "2d",
      { willReadFrequently: true },
    )
    const hex = (colour) => {
      if (!colour || !canvas) return ""
      canvas.fillStyle = colour
      canvas.fillRect(0, 0, 1, 1)
      const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data
      return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`
    }
    const box = svg.getBoundingClientRect()
    return {
      frame: true,
      svg: true,
      width: box.width,
      height: box.height,
      natural: svg.viewBox.baseVal.width,
      column: column.getBoundingClientRect().width,
      // The body's content width, its padding taken out: what the drawing is given to fill.
      inner: (() => {
        const body = svg.parentElement
        const style = getComputedStyle(body)
        return (
          body.clientWidth -
          parseFloat(style.paddingLeft || "0") -
          parseFloat(style.paddingRight || "0")
        )
      })(),
      screen: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
      dark: document.documentElement.classList.contains("dark"),
      id: svg.id,
      ink,
      expected: hex(getComputedStyle(document.body).getPropertyValue("--foreground").trim()),
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

    // The drawing: an svg in the frame, in the app's own colours, at a phone's width and a tablet's,
    // in both themes. It is never wider than the column it stands in, and a diagram too wide for that
    // column is scaled into it while a narrower one is left at its own size.
    const seen = new Map()
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 768 })
      for (const theme of ["light", "dark"]) {
        const at = `${width}px in ${theme}`
        await page.emulateMedia({ colorScheme: theme })
        // A theme flip redraws the drawing: wait for the svg drawn in this mode's foreground, rather
        // than reading the one drawn for the mode before.
        await until(
          async () => {
            const facts = await drawnFacts(page)
            return facts.svg && facts.ink === facts.expected
          },
          20_000,
          `the ${theme} drawing at ${at}`,
        )
        await frame.scrollIntoViewIfNeeded()
        const facts = await drawnFacts(page)
        const drawn = `${Math.round(facts.width)}×${Math.round(facts.height)}px`
        assert.ok(
          facts.width <= facts.column,
          `the drawing fits its column at ${at} (${drawn} in ${Math.round(facts.column)}px)`,
        )
        assert.ok(
          facts.width >= Math.min(facts.natural, facts.inner) - 2,
          `it is drawn at its own size, or as wide as the frame lets it at ${at} (${Math.round(facts.natural)}px wide, drawn ${drawn} in ${Math.round(facts.inner)}px)`,
        )
        assert.ok(facts.width <= facts.natural + 2, `and never stretched past it at ${at}`)
        assert.ok(
          facts.scroll <= facts.screen,
          `the thread doesn't scroll sideways at ${at} (${facts.scroll}px of ${facts.screen}px)`,
        )
        assert.equal(facts.dark, theme === "dark", `the screen is ${theme} at ${at}`)
        assert.match(
          facts.id,
          /^[A-Za-z][\w-]*$/,
          `the drawing is a node the page can select at ${at} (${facts.id})`,
        )
        assert.equal(
          facts.ink,
          facts.expected,
          `its words are drawn in the page's own foreground at ${at}, not a colour of mermaid's`,
        )
        seen.set(`${width}-${theme}`, `${drawn}, ${facts.ink}`)
        const path = await shot(`drawn-${width}-${theme}`)
        pass(
          `the diagram drew at ${at}: ${drawn} in a ${Math.round(facts.column)}px column, its words in ${facts.ink}${path ? ` (${path})` : ""}`,
        )
      }
    }
    assert.notEqual(
      seen.get("390-light"),
      seen.get("390-dark"),
      "the drawing is redrawn in the other mode's colours, not left as it was",
    )
    pass(
      `the drawing followed the page: ${[...seen.entries()].map(([at, what]) => `${at} ${what}`).join("; ")}`,
    )

    // A fence mermaid refuses: its source, drawn as the code it is, and one quiet line saying why —
    // never a stack trace, and never a frame pretending to be a drawing. The reply is read once it has
    // finished: while it arrives its fence is drawn as code anyway, so the fallback is the block that
    // is still there when the words are.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: "light" })
    await send("draw a diagram that won't parse")
    const broken = page.locator(REPLY).last()
    await until(
      async () => (await lastReply(chatId))?.status === "done",
      60_000,
      "the refused reply to reach its end",
    )
    await until(
      async () => (await broken.locator(LINE).count()) === 1,
      30_000,
      "the line saying why the fence didn't draw",
    )
    assert.equal(await broken.locator(FRAME).count(), 0, "a fence that will not draw draws no frame")
    const refused = await broken.locator(`${FENCE_CODE} pre`).textContent()
    assert.equal(
      refused,
      "flowchart TD\n  Request --> Parse\n  Parse -->",
      `the source is drawn whole, as it was written (${JSON.stringify(refused)})`,
    )
    assert.equal(await broken.locator(LINE).count(), 1, "one line, and no second")
    const line = (await broken.locator(LINE).innerText()).trim()
    assert.match(line, /parse error/i, `the line is mermaid's own words (${line})`)
    assert.ok(
      !/\bat\s+\S+\s*:\d+|:\d+:\d+|TypeError|ReferenceError|Evaluating/.test(line) &&
        !line.includes("\n"),
      `and never a stack trace (${line})`,
    )
    const refusedPath = await shot("refused")
    pass(
      `a fence mermaid refused drew its source and one line: "${line}"${refusedPath ? ` (${refusedPath})` : ""}`,
    )
  },
  { viewport: { width: 390, height: 844 } },
)
