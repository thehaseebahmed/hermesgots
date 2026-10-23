// An interface in a real thread: the reply's block draws from the library at a phone's width and a
// tablet's, in both themes; the block no component answers for draws as the code the model sent;
// and a patch that lands while the reader is scrolled up leaves their place where it was.
import { app, assert, flow, pass, settled } from "./lib.mjs"

const VIEWPORT = "[data-slot=message-scroller-viewport]"
const TO_END = "[data-slot=message-scroller-button][data-direction=end]"
const REPLY = "[data-slot=message][data-align=start]"

/**
 * One walk of the page for every fact this flow reads: the thread's scroll, the interface's box and
 * the rows the table under it draws. `place` first puts the reader just above the card, the way
 * someone who has scrolled to it would sit.
 */
const facts = (page, place = false) =>
  page.evaluate((place) => {
    const viewport = document.querySelector("[data-slot=message-scroller-viewport]")
    const card = document.querySelector("[data-slot=card]")
    if (place) {
      const top =
        card.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop
      viewport.scrollTop = Math.max(8, Math.round(top) - 80)
    }
    const row = card.closest("[data-slot=message]")
    const table = row.querySelector("table")
    const box = card.getBoundingClientRect()
    return {
      scrollTop: viewport.scrollTop,
      end: viewport.scrollHeight - viewport.clientHeight,
      top: Math.round(box.top),
      width: Math.round(box.width),
      height: Math.round(box.height),
      left: Math.round(box.left),
      right: Math.round(box.right),
      column: viewport.clientWidth,
      screen: window.innerWidth,
      page: document.documentElement.scrollWidth,
      sideways: table.parentElement.scrollWidth - table.parentElement.clientWidth,
      rows: row.querySelectorAll("tbody tr").length,
      aside: Boolean(row.querySelector("[data-slot=alert]")),
      dark: document.documentElement.classList.contains("dark"),
    }
  }, place)

await flow(
  "openui",
  async ({ page, send, lastReply, until, shot }) => {
    await page.goto(app)
    await send("draw the interface")
    await page.waitForURL("**/c/**", { timeout: 15_000 })
    const chatId = new URL(page.url()).pathname.split("/").at(-1)

    const reply = page.locator(REPLY).last()
    const card = reply.locator("[data-slot=card]")
    const thread = page.locator(VIEWPORT)

    await until(() => card.count().then((count) => count === 1), 25_000, "the interface to draw")
    assert.equal(
      await card.locator("[data-slot=card-title]").textContent(),
      "Quarterly sales",
      "the reply's block drew an interface from the library",
    )
    await until(
      async () => /Up 12%/.test((await card.textContent()) ?? ""),
      10_000,
      "the first block's own card",
    )
    assert.equal(
      await reply.locator("div[data-md-code]").count(),
      0,
      "with none of its source left on the page",
    )

    await until(
      async () =>
        (await reply.textContent())?.includes("closing inside the last ten days") ?? false,
      30_000,
      "the receipt under the interface",
    )

    await facts(page, true)
    await thread.hover()
    await page.mouse.wheel(0, -8)
    await until(
      async () => (await page.locator(TO_END).getAttribute("data-active")) === "true",
      10_000,
      "the thread to stop following its end",
    )
    await settled(page)
    const before = await facts(page)
    assert.ok(before.end > 300, `the reply overflows a phone's thread (${before.end}px of scroll)`)
    assert.ok(
      before.scrollTop > 0 && before.scrollTop < before.end - 200,
      `the reader is scrolled up, between the ends (${before.scrollTop}px of ${before.end}px)`,
    )
    assert.equal(before.rows, 3, "the table as the first block drew it")

    await until(async () => (await facts(page)).rows === 4, 40_000, "the patch to land")
    await settled(page)

    const after = await facts(page)
    assert.match(await card.textContent(), /Up 18%/, "the patch changed the interface it names")
    assert.ok(after.end > before.end, "the thread grew under the reader while it landed")
    assert.equal(after.scrollTop, before.scrollTop, "and the reader's scroll offset held")
    assert.ok(
      Math.abs(after.top - before.top) <= 1,
      `the interface stayed where the reader had it (${before.top}px to ${after.top}px)`,
    )
    pass(
      `a patch landed while the thread was scrolled up (${before.scrollTop}px of ${before.end}px, then ${after.end}px): the reader's place held, the card at ${after.top}px of the screen`,
    )

    await until(
      async () => (await lastReply(chatId))?.status === "done",
      90_000,
      "the reply to reach its end",
    )
    const said = await lastReply(chatId)
    assert.match(
      said.content,
      /That's the quarter, from the first read to this one\.$/,
      "the reply reached its last sentence with the blocks in it",
    )

    const code = reply.locator("div[data-md-code]")
    await until(() => code.count().then((count) => count === 1), 10_000, "the fallback to draw")
    assert.equal(
      await code.locator("span").first().textContent(),
      "openui-lang",
      "the block that can't be drawn draws as code, under the fence's own label",
    )
    assert.match(
      await code.textContent(),
      /Sparkline\("Revenue by month"/,
      "holding the source the model sent",
    )
    assert.equal(await page.locator("[data-slot=card]").count(), 1, "one interface in the thread")
    assert.equal(
      await reply.locator("pre").count(),
      1,
      "and one code block: the interface itself left none behind",
    )
    pass("a block no component answers for drew as code, and the reply still reached its end")

    const widths = new Map()
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 768 })
      for (const dark of [false, true]) {
        await page.emulateMedia({ colorScheme: dark ? "dark" : "light" })
        await card.scrollIntoViewIfNeeded()
        await settled(page)
        const seen = await facts(page)
        const at = `${width}px in ${dark ? "dark" : "light"}`
        assert.equal(seen.dark, dark, `the screen is ${dark ? "dark" : "light"} at ${at}`)
        assert.ok(
          seen.width >= seen.column - 56 && seen.width <= seen.column,
          `the interface takes the thread's own column at ${at} (${seen.width}px of ${seen.column}px)`,
        )
        assert.ok(seen.left >= 0 && seen.right <= seen.screen, `it sits inside the screen at ${at}`)
        assert.ok(seen.page <= seen.screen, `the page doesn't scroll sideways at ${at}`)
        assert.equal(seen.rows, 4, `the table's patched rows draw at ${at}`)
        assert.ok(seen.aside, `and its callout draws at ${at}`)
        assert.equal(seen.sideways, 0, `the table keeps its columns inside the interface at ${at}`)
        assert.match(await card.textContent(), /Up 18%/, `the patched card draws at ${at}`)
        widths.set(`${width}-${dark ? "dark" : "light"}`, `${seen.width}×${seen.height}`)
        const path = await shot(`interface-${width}-${dark ? "dark" : "light"}`)
        pass(
          `the interface drew at ${at}: ${seen.width}×${seen.height}px${path ? ` (${path})` : ""}`,
        )
      }
    }
    pass(
      `the interface takes the width it is given: ${widths.get("390-light")} at 390, ${widths.get("768-light")} at 768`,
    )
  },
  { viewport: { width: 390, height: 844 } },
)
