import { app, assert, flow, long, pass, settled } from "./lib.mjs"

const REPLY = "[data-slot=message][data-align=start]"
const FRAME = "[data-slot=diagram]"
const DRAWING = "[data-slot=diagram-drawing]"
const SHEET = "[data-slot=diagram-sheet]"
const THREAD = "[data-slot=message-scroller-viewport]"
const LINE = "[data-slot=diagram-line]"
const FENCE_CODE = "[data-slot=markdown] div[data-md-code]"

const watchFence = (page) =>
  page.evaluate(() => {
    window.__fence = []
    window.__frameAt = null
    window.__mermaidChunks = []
    // Resource timing is the page's own clock, so a chunk's start and the frame's first commit can
    // be told apart: an observer sees each entry as it is recorded, whatever the buffer later holds.
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (/mermaid/i.test(entry.name) && /\.m?js(?:\?|$)/.test(entry.name))
            window.__mermaidChunks.push(Math.round(entry.startTime))
      }).observe({ type: "resource", buffered: true })
    } catch {
      /* no resource timing: the chunk count is then asserted by the flow's own request log */
    }
    const replyNow = () =>
      [...document.querySelectorAll("[data-slot=message][data-align=start]")].at(-1)
    // Marked on the mutation itself, not on the next frame: the import starts after this commit.
    const markFrame = () => {
      if (window.__frameAt !== null) return
      if (replyNow()?.querySelector("[data-slot=diagram]"))
        window.__frameAt = Math.round(performance.now())
    }
    let waiting = false
    const read = () => {
      const reply = replyNow()
      if (!reply) return
      window.__fence.push({
        code: reply.querySelectorAll("[data-slot=markdown] div[data-md-code]").length,
        frame: reply.querySelectorAll("[data-slot=diagram]").length,
        words: (reply.textContent ?? "").length,
      })
    }
    const observer = new MutationObserver(() => {
      markFrame()
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
    window.__chunkRead = () => ({ frameAt: window.__frameAt, chunks: [...window.__mermaidChunks] })
  })

const drawnFacts = (page) =>
  page.evaluate(() => {
    const frame = [...document.querySelectorAll("[data-slot=diagram]")].at(-1)
    if (!frame) return { frame: false }
    // mermaid's svg carries the id it was rendered under; the frame's lucide icons carry none.
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

// mermaid removes the svg it drew, by id, for the length of a render: that gap is mermaid's own.
const watchDrawing = (page) =>
  page.evaluate(() => {
    const frame = [...document.querySelectorAll("[data-slot=diagram]")].at(-1)
    window.__drawn = []
    const read = () => {
      window.__drawn.push({
        drawing: Boolean(frame.querySelector("[data-slot=diagram-drawing]")),
        svg: frame.querySelectorAll("svg[id]").length,
      })
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(frame, { childList: true, subtree: true })
    window.__drawnRead = () => {
      observer.disconnect()
      return window.__drawn
    }
  })

/**
 * One drawing, as a reader's eye can judge it: the box a node is filled with against the words on
 * it, and the colour the drawing was told it stands on. The app's own colours come back through a
 * 1px canvas, since the tokens compute to `oklch()`.
 */
const readDrawing = (row) =>
  row.evaluate((el) => {
    const frame = el.querySelector("[data-slot=diagram]")
    const svg = frame?.querySelector("svg[id]")
    if (!frame || !svg) return { drawn: false }
    const canvas = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext(
      "2d",
      { willReadFrequently: true },
    )
    const channels = (colour) => {
      if (!colour || !canvas) return null
      canvas.clearRect(0, 0, 1, 1)
      canvas.fillStyle = colour
      canvas.fillRect(0, 0, 1, 1)
      const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data
      return [r, g, b]
    }
    const hex = (colour) => {
      const read = channels(colour)
      return read ? `#${read.map((n) => n.toString(16).padStart(2, "0")).join("")}` : ""
    }
    const luminance = (colour) => {
      const read = channels(colour)
      if (!read) return 0
      const [r, g, b] = read.map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const ratio = (one, other) => {
      const [high, low] = [luminance(one), luminance(other)].sort((a, b) => b - a)
      return (high + 0.05) / (low + 0.05)
    }
    // mermaid's root rule, first in the style it writes: `#id{font-family:…;fill:<textColor>;}`.
    const rule = /#[\w-]+\{([^}]*)\}/.exec(svg.querySelector("style")?.textContent ?? "")?.[1] ?? ""
    const ink = /fill:\s*(#[0-9a-f]{6})/i.exec(rule)?.[1]?.toLowerCase() ?? ""
    const box = svg.querySelector(".node rect")
    const labelRect = svg.querySelector(".edgeLabel rect")
    const labelBkg = svg.querySelector(".labelBkg")
    const labelGroup = svg.querySelector(".edgeLabel")
    // The surface a diagram was told it stands on is painted on its edge labels, which is the one
    // place mermaid draws it: a rect's fill, an html label's background, or the group's own.
    const labelPaint = labelRect
      ? getComputedStyle(labelRect).fill
      : labelBkg
        ? getComputedStyle(labelBkg).backgroundColor
        : labelGroup
          ? getComputedStyle(labelGroup).backgroundColor
          : ""
    const boxFill = box ? getComputedStyle(box).fill : ""
    return {
      drawn: true,
      dark: document.documentElement.classList.contains("dark"),
      ink,
      expected: hex(getComputedStyle(el.querySelector("[data-slot=markdown]") ?? el).color),
      box: hex(boxFill),
      boxVsInk: ink && boxFill ? ratio(boxFill, ink) : 0,
      plate: hex(getComputedStyle(frame).backgroundColor),
      page: hex(getComputedStyle(document.body).getPropertyValue("--background")),
      label: hex(labelPaint),
    }
  })

const flipping = (page) =>
  page.evaluate(
    () =>
      [...document.querySelectorAll("[data-slot=diagram]")]
        .at(-1)
        ?.querySelectorAll("svg[id]").length === 1,
  )

const dark = (page) => page.evaluate(() => document.documentElement.classList.contains("dark"))

await flow(
  "mermaid",
  async ({ page, send, lastReply, newChat, until, shot, centreOf }) => {
    const chunks = []
    page.on("request", (request) => {
      const url = request.url()
      if (/mermaid/i.test(url) && /\.m?js(?:[?#]|$)/.test(url)) chunks.push(url)
    })
    await page.goto(app)
    const chatId = await newChat()
    await watchFence(page)
    await send("draw a diagram")
    const reply = page.locator(REPLY).last()
    const frame = reply.locator(FRAME)

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

    // The promise that whether a fence is worth a chunk is answered before any import: a chunk's
    // request and the frame's first commit are both on the page's own clock.
    const asked = await until(
      async () => {
        const read = await page.evaluate(() => window.__chunkRead())
        return read.frameAt !== null && read.chunks.length > 0 ? read : null
      },
      20_000,
      "mermaid's chunk to be asked for",
    )
    const early = asked.chunks.filter((at) => at < asked.frameAt).length
    assert.equal(
      early,
      0,
      `no mermaid chunk was asked for while the fence was still arriving (${early} of ${asked.chunks.length} came before the frame)`,
    )
    pass(
      `the fence was code with nothing fetched: the first of ${asked.chunks.length} chunk requests came ${asked.chunks[0] - asked.frameAt}ms after the frame appeared`,
    )

    const seen = new Map()
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 768 })
      for (const theme of ["light", "dark"]) {
        const at = `${width}px in ${theme}`
        const watched = (await flipping(page)) && (await dark(page)) !== (theme === "dark")
        if (watched) await watchDrawing(page)
        await page.emulateMedia({ colorScheme: theme })
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
        if (watched) {
          const states = await page.evaluate(() => window.__drawnRead())
          const shape = states.map((state) => `${state.drawing ? "drawn" : "source"}/${state.svg}`)
          assert.ok(
            states.length > 1,
            `the flip redrew the drawing at ${at} (${states.length} states)`,
          )
          assert.ok(
            states.every((state) => state.drawing),
            `and never put the source back on the frame on its way: ${shape.join(",")}`,
          )
          assert.ok(
            states.some((state) => state.svg > 0),
            `with a drawing on the frame before and after: ${shape.join(",")}`,
          )
          pass(`the mode change redrew the drawing through ${shape.join(" → ")} at ${at}`)
        }
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

    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: "light" })
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
    const drawing = page.locator(FRAME).last()
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

    // A page-tone drawing stands on the frame's own plate, never on the page behind it: the frame is
    // `bg-muted` and the page's background is not, and mermaid's edge-label plate is filled with the
    // surface the app told it about, so the two agree only when the plate is what was read.
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: "light" })
    const plateReply = page.locator(`${REPLY}:has([data-slot=diagram])`).first()
    const plate = await until(
      async () => {
        const facts = await readDrawing(plateReply)
        return facts.drawn && facts.label && facts.ink === facts.expected ? facts : null
      },
      30_000,
      "the drawing's labelled edges",
    )
    assert.notEqual(
      plate.plate,
      plate.page,
      `the frame stands on a plate of its own (${plate.plate} against the page's ${plate.page})`,
    )
    assert.equal(
      plate.label,
      plate.plate,
      `and the drawing was told it stands on that plate, not on the page (${plate.label})`,
    )
    pass(
      `a page-tone drawing was drawn on its frame's plate: ${plate.plate}, where the page's own background is ${plate.page}`,
    )

    // And one in the reader's own bubble: the fill tone's surface, whose words are near-white.
    await send(["```mermaid", "flowchart LR", "  Ask[The fence] -->|closes| Draw[Drawn]", "```"].join("\n"))
    const mine = page.locator("[data-slot=message][data-align=end]").last()
    await until(
      () => mine.locator("[data-slot=diagram] svg[id] .node").count().then((count) => count > 0),
      30_000,
      "the bubble's own diagram to draw",
    )
    const bubbleSeen = []
    for (const theme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: theme })
      const facts = await until(
        async () => {
          const read = await readDrawing(mine)
          return read.box && read.dark === (theme === "dark") && read.ink === read.expected ? read : null
        },
        25_000,
        `the bubble's diagram in ${theme}`,
      )
      assert.ok(
        facts.boxVsInk >= 4.5,
        `the bubble's box carries its words at ${facts.boxVsInk.toFixed(2)}:1 in ${theme} (${facts.box} under ${facts.ink})`,
      )
      if (theme === "light")
        assert.notEqual(
          facts.box,
          "#ffffff",
          `the page's white is no box inside a filled bubble (${facts.box})`,
        )
      bubbleSeen.push(`${theme} ${facts.box} under ${facts.ink} at ${facts.boxVsInk.toFixed(2)}:1`)
    }
    const bubblePath = await shot("bubble")
    pass(
      `a diagram in the user's own bubble reads: ${bubbleSeen.join("; ")}${bubblePath ? ` (${bubblePath})` : ""}`,
    )
  },
  { viewport: { width: 390, height: 844 } },
)
