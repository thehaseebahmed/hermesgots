// A reply's closed ```mermaid fence is a picture where the fence stood, drawn in the app's own
// colours at a phone's width and a tablet's, in both themes — and the same fence, still arriving, is
// drawn as the code it is until its closer lands. Only a reply that is really streaming can show
// the second half: the app writes a reply as its pieces land, so a fence's body and its closer are
// two states of the page, and a component test handed the finished string has only one. The drawing
// itself is this flow's, because mermaid measures a diagram with `getBBox` and no DOM without layout
// has one.
import { app, assert, flow, long, pass, settled } from "./lib.mjs"

const REPLY = "[data-slot=message][data-align=start]"
const FRAME = "[data-slot=diagram]"
// The drawing, as the frame's body draws it once mermaid has made it: a control, and the sheet a
// tap on it opens the same drawing in.
const DRAWING = "[data-slot=diagram-drawing]"
const SHEET = "[data-slot=diagram-sheet]"
/** A thread's own scroller: where a reader was when they opened a sheet over it. */
const THREAD = "[data-slot=message-scroller-viewport]"
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

/**
 * The drawing as a reader can reach it, and the sheet a tap opens it in, measured in the browser:
 * the control the frame's body is, the one svg the frame holds and the width it was made at, the
 * thread's own scroll, and — while one is open — the sheet's scrolling body, the drawing inside it
 * and whether that drawing is wider than the room the body is given.
 */
const sheetFacts = (page) =>
  page.evaluate(
    ({ frame: frameSel, drawing: drawingSel, sheet: sheetSel, thread: threadSel }) => {
      const boxOf = (node) => {
        const box = node.getBoundingClientRect()
        return {
          width: Math.round(box.width),
          height: Math.round(box.height),
          top: Math.round(box.top),
        }
      }
      const drawn = [...document.querySelectorAll(frameSel)].at(-1)
      const control = drawn?.querySelector(drawingSel)
      const own = drawn?.querySelector("svg[id]")
      const view = document.querySelector(threadSel)
      const sheet = document.querySelector(sheetSel)
      const inside = sheet?.querySelector("svg[id]")
      return {
        control: control && {
          tag: control.tagName,
          type: control.getAttribute("type"),
          name: control.getAttribute("aria-label"),
          expands: control.getAttribute("aria-expanded"),
        },
        // The drawing is a picture, not a pair of them: one svg in the frame, whatever is open.
        drawings: drawn ? drawn.querySelectorAll("svg[id]").length : -1,
        id: own?.id ?? "",
        natural: own?.viewBox.baseVal.width ?? 0,
        box: own ? boxOf(own) : null,
        column: drawn?.closest("[data-slot=markdown]")?.getBoundingClientRect().width ?? 0,
        thread: view && {
          top: view.scrollTop,
          height: view.clientHeight,
          total: view.scrollHeight,
        },
        screen: window.innerWidth,
        sheet: sheet && {
          frame: boxOf(sheet),
          // The room the body gives its content, and what it really holds — the gap is what pans.
          room: sheet.clientWidth,
          total: sheet.scrollWidth,
          drawings: sheet.querySelectorAll("svg[id]").length,
          id: inside?.id ?? "",
          natural: inside?.viewBox.baseVal.width ?? 0,
          box: inside ? boxOf(inside) : null,
          left: sheet.scrollLeft,
        },
      }
    },
    { frame: FRAME, drawing: DRAWING, sheet: SHEET, thread: THREAD },
  )

await flow(
  "mermaid",
  async ({ page, send, lastReply, newChat, until, shot, centreOf }) => {
    // Every chunk the page asks for that carries mermaid: a drawing made once is never fetched
    // again, whatever a reader opens over it.
    const chunks = []
    page.on("request", (request) => {
      const url = request.url()
      if (/mermaid/i.test(url) && /\.m?js(?:[?#]|$)/.test(url)) chunks.push(url)
    })
    await page.goto(app)
    const chatId = await newChat()
    // Watched from here, so the record is the diagram's own reply and no other.
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

    // A reader opens the drawing larger (F4). A phone is where it matters: the diagram is wider than
    // the column it is drawn in, so a sheet that held it at the column's width would be a smaller
    // copy of what the thread already shows. It opens the same drawing at the width it was made, in
    // a body that pans both ways, and closing it leaves the thread where the reader left it — the
    // same svg, never a second one, and no second ask for mermaid's chunk.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: "light" })
    // An answer below the diagram first, so the thread is longer than the phone's pane: "the thread
    // is where it was" is then a measurement, not a zero against a zero. The fence's own record is
    // read by now, so a turn under it cannot disturb it.
    await send(long("After the diagram", 8))
    await until(
      async () => (await lastReply(chatId))?.status === "done",
      60_000,
      "the answer below the diagram to reach its end",
    )
    await until(
      async () => {
        const facts = await drawnFacts(page)
        return facts.svg && facts.ink === facts.expected
      },
      20_000,
      "the light drawing at a phone's width",
    )
    // The diagram is the last frame on the page, whatever reply the thread ends on: the `frame`
    // locator above follows the thread's last reply, which is now the answer below it.
    const drawing = page.locator(FRAME).last()
    // The answer types itself out once its turn has ended, and the thread follows it down as it
    // grows: an answer still typing is a thread still moving, and a position read inside that is no
    // place a reader was. It is finished when its stats land, and the thread has come to rest a
    // moment after.
    await page
      .locator(REPLY)
      .last()
      .getByText(/\d+ tokens/)
      .first()
      .waitFor({ timeout: 20_000 })
    await drawing.scrollIntoViewIfNeeded()
    const rest = async (what) => {
      let was = ""
      return until(
        async () => {
          const facts = await sheetFacts(page)
          const now = `${facts.thread?.top}/${facts.thread?.total}`
          const still = now === was
          was = now
          return still ? facts : null
        },
        15_000,
        what,
      )
    }
    const shut = await rest("the thread to come to rest")
    assert.equal(shut.sheet, null, "no sheet stands over the thread to begin with")
    assert.ok(shut.thread && shut.thread.total > shut.thread.height, "the thread is longer than its pane")
    assert.ok(
      (shut.thread?.top ?? 0) > 0,
      `and the reader is partway down it (${shut.thread?.top}px)`,
    )
    assert.ok(shut.control, "the drawing is a control, not only a picture")
    assert.equal(shut.control?.tag, "BUTTON", `it is a real button (${shut.control?.tag})`)
    assert.equal(shut.control?.type, "button", "that submits no form")
    assert.ok(
      /diagram/i.test(shut.control?.name ?? ""),
      `named for what it opens ("${shut.control?.name}")`,
    )
    assert.equal(shut.drawings, 1, "the frame holds one svg, never two")
    assert.ok(
      shut.natural > shut.column,
      `and the diagram is wider than the column it is drawn in (${Math.round(shut.natural)}px made, ${Math.round(shut.column)}px given)`,
    )

    // The ring is the keyboard's: the copy control is the step before the drawing in the frame, so
    // one Tab from it lands on the drawing — which is what draws the ring.
    await page.evaluate(
      ({ frame: frameSel }) =>
        [...document.querySelectorAll(frameSel)]
          .at(-1)
          ?.querySelector('button[aria-label="Copy code"]')
          ?.focus(),
      { frame: FRAME },
    )
    await page.keyboard.press("Tab")
    const reached = await page.evaluate(
      ({ frame: frameSel, drawing: drawingSel }) => {
        const control = [...document.querySelectorAll(frameSel)]
          .at(-1)
          ?.querySelector(drawingSel)
        const style = control && getComputedStyle(control)
        return {
          focused: document.activeElement === control,
          which:
            document.activeElement?.getAttribute("aria-label") ??
            document.activeElement?.tagName ??
            "",
          visible: control?.matches(":focus-visible") ?? false,
          ring: style?.boxShadow ?? "none",
        }
      },
      { frame: FRAME, drawing: DRAWING },
    )
    assert.equal(reached.focused, true, `a keyboard reaches the drawing (${reached.which})`)
    assert.equal(reached.visible, true, "as a keyboard reader's focus, which is what wears the ring")
    assert.notEqual(reached.ring, "none", `and the ring is really drawn there (${reached.ring})`)

    const chunksBefore = chunks.length
    assert.ok(
      chunksBefore > 0,
      `mermaid's chunk was fetched to make the drawing (${chunksBefore} requests)`,
    )
    await drawing.locator(DRAWING).click()
    await until(
      async () => {
        const facts = await sheetFacts(page)
        return facts.sheet ? facts : null
      },
      10_000,
      "the sheet to open on the drawing",
    )
    await settled(page)
    const shown = await rest("the thread under the sheet to stay put")
    assert.equal(shown.drawings, 1, "the frame keeps its one drawing behind the sheet")
    assert.equal(shown.sheet?.drawings, 1, "and the sheet holds one")
    assert.ok(
      Math.abs((shown.sheet?.natural ?? 0) - shown.natural) < 1,
      `the sheet holds the drawing that was made (${shown.sheet?.natural}px against ${shown.natural}px)`,
    )
    assert.ok(
      (shown.sheet?.box?.width ?? 0) >= shown.natural - 2,
      `at its own width, not scaled to the phone (${shown.sheet?.box?.width}px of ${Math.round(shown.natural)}px)`,
    )
    assert.ok(
      (shown.sheet?.frame.width ?? 0) <= shown.screen,
      `the sheet itself fits the phone it is opened on (${shown.sheet?.frame.width}px of ${shown.screen}px)`,
    )
    assert.ok(
      (shown.sheet?.total ?? 0) > (shown.sheet?.room ?? 0) + 8,
      `its body holds more than it shows, so it pans (${shown.sheet?.total}px of ${shown.sheet?.room}px)`,
    )
    assert.equal(shown.control?.expands, "true", "the control says the drawing stands open")
    assert.equal(
      shown.thread?.top,
      shut.thread?.top,
      `the thread behind it did not move (${shown.thread?.top}px of ${shut.thread?.top}px)`,
    )

    // The pan is the reader's own: a sideways scroll over the body carries the drawing across, which
    // is what makes a diagram wider than the phone readable at all.
    const at = await centreOf(SHEET)
    await page.mouse.move(at.x, at.y)
    await page.mouse.wheel(160, 0)
    const panned = await until(
      async () => {
        const left = (await sheetFacts(page)).sheet?.left ?? 0
        return left > 8 ? left : null
      },
      5_000,
      "the sheet to pan sideways",
    )
    assert.ok(panned > 8, `a sideways scroll carries the drawing across (${Math.round(panned)}px)`)
    const panningPath = await shot("sheet")

    // Closing returns to the thread exactly where it was, on the very node that was drawn: marked
    // here, and read back after the sheet has gone.
    await page.evaluate(
      ({ frame: frameSel }) => {
        const svg = [...document.querySelectorAll(frameSel)].at(-1)?.querySelector("svg[id]")
        if (svg) svg.dataset.kept = "1"
      },
      { frame: FRAME },
    )
    await page.keyboard.press("Escape")
    await until(
      async () => {
        const facts = await sheetFacts(page)
        return facts.sheet ? null : true
      },
      5_000,
      "the sheet to close",
    )
    await settled(page)
    const after = await rest("the thread to come to rest again")
    assert.equal(after.sheet, null, "the sheet is gone")
    assert.equal(after.drawings, 1, "the frame still holds one drawing, never two")
    assert.equal(after.id, shut.id, "drawn as it was: the same svg, under the same id")
    assert.equal(
      await page.evaluate(
        ({ frame: frameSel }) =>
          [...document.querySelectorAll(frameSel)]
            .at(-1)
            ?.querySelector("svg[id]")
            ?.getAttribute("data-kept") ?? "",
        { frame: FRAME },
      ),
      "1",
      "the very node the thread drew, not one made again to replace it",
    )
    assert.ok(
      Math.abs((after.box?.width ?? 0) - (shut.box?.width ?? 0)) <= 1,
      `at the size it was drawn (${after.box?.width}px against ${shut.box?.width}px)`,
    )
    assert.equal(after.box?.top, shut.box?.top, "where the reader left it in the thread")
    assert.equal(after.thread?.top, shut.thread?.top, `and the thread at ${shut.thread?.top}px, as it was`)
    assert.equal(chunks.length, chunksBefore, "mermaid was asked for nothing while the sheet was open")
    pass(
      `a tap opened the drawing at its own ${Math.round(shown.natural)}px in a ${Math.round(shown.sheet?.room ?? 0)}px body that pans (${Math.round(shown.sheet?.total ?? 0)}px wide), and closing it left the thread at ${shut.thread?.top}px${panningPath ? ` (${panningPath})` : ""}`,
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
