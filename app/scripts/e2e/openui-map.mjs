// A reply's places, drawn: a real map fitted to its own points at a phone's width and a tablet's, in
// both themes, its basemap following the theme and the provider's attribution in its chrome — and
// the gesture contract no DOM without layout can hold: one finger scrolls the thread over an
// untouched map, a tap takes pan and zoom, and the map's own button hands the gestures back.
import { app, assert, flow, pass, settled } from "./lib.mjs"

const REPLY = "[data-slot=message][data-align=start]"
const MAP = "[data-slot=map]"
const SUMMARY = "Four stops on the north waterfront walk."
const LABELS = ["Ferry Building", "Coit Tower", "Pier 39", "Ghirardelli Square"]
const HAND_BACK = "Let the thread scroll again"

/**
 * One walk of the page for every fact this flow reads: the thread's scroll, the map's box, where each
 * label sits inside it, the tiles it asked for and the chrome's attribution. `place` first puts the
 * reader with the map below the top of the screen, so a scroll gesture has room either way.
 */
const facts = (page, place = false) =>
  page.evaluate(
    ({ place, selector }) => {
      const viewport = document.querySelector("[data-slot=message-scroller-viewport]")
      const wrapper = document.querySelector(selector)
      const frame = wrapper?.querySelector("[role=img]")
      const round = (value) => Math.round(value * 10) / 10
      if (place && wrapper) {
        const top =
          wrapper.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop
        viewport.scrollTop = Math.max(0, Math.round(top) - 200)
      }
      const box = frame.getBoundingClientRect()
      const labels = [...frame.querySelectorAll(".openui-map-label")].map((label) => {
        const at = label.getBoundingClientRect()
        return {
          text: label.textContent?.trim() ?? "",
          title: label.getAttribute("title"),
          left: round(at.left - box.left),
          top: round(at.top - box.top),
          width: round(at.width),
          height: round(at.height),
          inside:
            at.left >= box.left - 0.5 &&
            at.right <= box.right + 0.5 &&
            at.top >= box.top - 0.5 &&
            at.bottom <= box.bottom + 0.5,
        }
      })
      const tiles = [...frame.querySelectorAll("img.leaflet-tile")].map(
        (tile) => tile.getAttribute("src") ?? "",
      )
      const attribution = frame.querySelector(".leaflet-control-attribution")
      const credited = attribution?.getBoundingClientRect()
      return {
        scrollTop: Math.round(viewport.scrollTop),
        end: Math.round(viewport.scrollHeight - viewport.clientHeight),
        column: viewport.clientWidth,
        screen: window.innerWidth,
        page: document.documentElement.scrollWidth,
        box: {
          left: round(box.left),
          top: round(box.top),
          width: round(box.width),
          height: round(box.height),
        },
        active: wrapper.getAttribute("data-active"),
        summary: frame.getAttribute("aria-label"),
        labels,
        tiles: tiles.length,
        basemap: tiles.some((src) => src.includes("World_Dark_Gray_Base"))
          ? "dark"
          : tiles.some((src) => src.includes("World_Street_Map"))
            ? "light"
            : "none",
        attribution: attribution?.textContent ?? "",
        credited:
          credited && credited.width > 0 && credited.height > 0
            ? {
                inside:
                  credited.left >= box.left - 0.5 &&
                  credited.right <= box.right + 0.5 &&
                  credited.top >= box.top - 0.5 &&
                  credited.bottom <= box.bottom + 0.5,
              }
            : null,
        affordance: Boolean(wrapper.querySelector("button")),
        dark: document.documentElement.classList.contains("dark"),
      }
    },
    { place, selector: MAP },
  )

/** The middle of the map, where a finger goes. */
const middle = (page) =>
  page.evaluate((selector) => {
    const box = document.querySelector(selector).getBoundingClientRect()
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
  }, MAP)

/** A wheel over the map, down the page for a positive `dy`. */
async function wheel(page, dy) {
  const at = await middle(page)
  await page.mouse.move(at.x, at.y)
  await page.mouse.wheel(0, dy)
  await settled(page)
}

/**
 * One finger over the map, moving `dy` pixels: a thumb's swipe, sent through the browser's own input
 * pipeline so `touch-action` decides what it does — scrolling the thread, or the map's pan.
 */
async function swipe(page, dy) {
  const at = await middle(page)
  const client = await page.context().newCDPSession(page)
  const steps = 10
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: at.x, y: at.y }],
  })
  for (let step = 1; step <= steps; step += 1) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: at.x, y: Math.round(at.y + (dy * step) / steps) }],
    })
    await page.waitForTimeout(16)
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await client.detach()
  await settled(page)
}

/** A mouse drag across the map, for the pan an active map takes. */
async function drag(page, dx, dy) {
  const at = await middle(page)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + dx, at.y + dy, { steps: 10 })
  await page.mouse.up()
  await settled(page)
}

/** Where the labels sat, as one string, so a gesture's effect on the view reads in one comparison. */
const view = (seen) => seen.labels.map((label) => `${label.left},${label.top}`).join(" ")

await flow(
  "openui-map",
  async ({ page, send, lastReply, until, shot }) => {
    await page.goto(app)
    await send("draw the map")
    await page.waitForURL("**/c/**", { timeout: 15_000 })
    const chatId = new URL(page.url()).pathname.split("/").at(-1)

    const reply = page.locator(REPLY).last()
    await until(
      () =>
        reply
          .locator(`${MAP} .openui-map-label`)
          .count()
          .then((count) => count === 4),
      25_000,
      "the map to draw",
    )
    await until(
      async () => (await lastReply(chatId))?.status === "done",
      90_000,
      "the reply to reach its end",
    )
    assert.equal(
      await reply.locator("div[data-md-code]").count(),
      0,
      "the block drew a map: none of its source is left on the page",
    )
    pass("a reply's block drew a map from the library, with no code left behind")

    await settled(page)
    const fitted = await facts(page, true)
    assert.equal(fitted.summary, SUMMARY, "the map's required summary is its accessible name")
    assert.deepEqual(
      fitted.labels.map((label) => label.text),
      LABELS,
      "every point's label draws on the map",
    )
    assert.deepEqual(
      fitted.labels.map((label) => label.title),
      [
        "Market Street at the Embarcadero",
        "Telegraph Hill, up the steps",
        "The Embarcadero at Beach Street",
        "Larkin and Beach",
      ],
      "and each point's detail rides its marker",
    )
    for (const label of fitted.labels)
      assert.ok(
        label.inside,
        `the view is fitted: "${label.text}" lies wholly inside the map (${label.left},${label.top} ${label.width}×${label.height} in ${fitted.box.width}×${fitted.box.height})`,
      )
    assert.ok(
      fitted.attribution.includes("OpenStreetMap") && fitted.attribution.includes("Esri"),
      `the tiles' attribution is in the map's chrome ("${fitted.attribution.trim()}")`,
    )
    assert.ok(fitted.credited?.inside, "and sits inside the map's own box")
    assert.equal(fitted.active, "false", "an untouched map is not taking gestures")
    assert.equal(fitted.affordance, false, "and offers nothing to hand back yet")
    pass(
      `the map drew fitted to its four points (${fitted.box.width}×${fitted.box.height}px), their labels all inside it, its summary the accessible name, the attribution in its chrome`,
    )

    // The basemap follows the theme and the map stays fitted at a phone's width and a tablet's.
    const seen = new Map()
    for (const width of [390, 768]) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 768 })
      for (const dark of [false, true]) {
        const theme = dark ? "dark" : "light"
        const at = `${width}px in ${theme}`
        await page.emulateMedia({ colorScheme: theme })
        await until(
          async () => (await facts(page)).basemap === theme,
          10_000,
          `the ${theme} basemap at ${at}`,
        )
        await page.locator(MAP).scrollIntoViewIfNeeded()
        await settled(page)
        const shape = await facts(page)
        assert.equal(shape.dark, dark, `the screen is ${theme} at ${at}`)
        assert.ok(
          shape.box.width >= shape.column - 60 && shape.box.width <= shape.column,
          `the map takes the thread's own column at ${at} (${shape.box.width}px of ${shape.column}px)`,
        )
        assert.ok(shape.page <= shape.screen, `the page doesn't scroll sideways at ${at}`)
        for (const label of shape.labels)
          assert.ok(
            label.inside,
            `"${label.text}" still lies inside the map at ${at} (${label.left},${label.top})`,
          )
        assert.equal(shape.basemap, theme, `the ${theme} tiles are the ones asked for at ${at}`)
        assert.match(shape.attribution, /OpenStreetMap/, `the attribution draws at ${at}`)
        seen.set(`${width}-${theme}`, `${shape.box.width}×${shape.box.height}`)
        const path = await shot(`map-${width}-${theme}`)
        pass(
          `the map drew at ${at}: ${shape.box.width}×${shape.box.height}px, ${shape.tiles} ${theme} tiles asked for${path ? ` (${path})` : ""}`,
        )
      }
    }
    pass(
      `the map takes the width it is given and follows the theme: ${seen.get("390-light")} at 390, ${seen.get("768-light")} at 768, light tiles in light and dark in dark`,
    )

    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: "light" })
    await until(
      async () => (await facts(page)).basemap === "light",
      10_000,
      "the light basemap again",
    )
    await facts(page, true)
    await settled(page)

    // Untouched: the thread keeps its scroll, and the map keeps its view.
    let before = await facts(page)
    const reached = before.scrollTop
    await wheel(page, 320)
    let after = await facts(page)
    assert.ok(
      after.scrollTop > reached,
      `a wheel over an untouched map scrolls the thread (${reached}px to ${after.scrollTop}px)`,
    )
    assert.equal(after.active, "false", "and the map never became active")
    assert.equal(view(after), view(before), "the map's view held: its labels didn't move")

    // The wheel carried the map up the screen, so it is placed again under the finger.
    await facts(page, true)
    await settled(page)
    before = await facts(page)
    await swipe(page, -260)
    after = await facts(page)
    assert.ok(
      after.scrollTop > before.scrollTop,
      `one finger over an untouched map scrolls the thread (${before.scrollTop}px to ${after.scrollTop}px)`,
    )
    assert.equal(after.active, "false", "still untouched")
    assert.equal(view(after), view(before), "and the map's view held through the swipe")
    pass(
      `one finger and a wheel both scroll the thread over an untouched map (${reached}px → ${after.scrollTop}px), the map's own view unmoved`,
    )

    // A tap takes the gestures: the map pans and zooms, the thread holds still, and a button hands
    // them back.
    await facts(page, true)
    await settled(page)
    const at = await middle(page)
    await page.touchscreen.tap(at.x, at.y)
    await until(
      async () => (await facts(page)).active === "true",
      5_000,
      "the tap to take the map's gestures",
    )
    await settled(page)
    await facts(page, true)
    await settled(page)
    const taken = await facts(page)
    assert.ok(
      taken.box.top > 0 && taken.box.top + taken.box.height < 844,
      `the map is on the screen it was tapped on (${taken.box.top}px to ${taken.box.top + taken.box.height}px)`,
    )
    assert.ok(taken.affordance, "the active map offers a button to hand the gestures back")
    const handBack = page.getByRole("button", { name: HAND_BACK })
    const target = await handBack.boundingBox()
    assert.ok(target && target.width >= 44 && target.height >= 44, "and the button is 44px or more")

    before = taken
    await wheel(page, -240)
    await until(
      async () => view(await facts(page)) !== view(before),
      3_000,
      "the wheel to zoom the active map",
    )
    after = await facts(page)
    assert.notEqual(view(after), view(before), "a wheel zooms the active map")
    assert.equal(after.scrollTop, before.scrollTop, "and the thread's scroll held while it zoomed")

    before = after
    await drag(page, 70, 50)
    await until(
      async () => view(await facts(page)) !== view(before),
      3_000,
      "the drag to pan the active map",
    )
    after = await facts(page)
    assert.notEqual(view(after), view(before), "a drag pans the active map")
    assert.equal(after.scrollTop, before.scrollTop, "and the thread's scroll held while it panned")
    pass(
      `a tap took the map: a wheel zoomed and a drag panned it, the thread's scroll holding at ${after.scrollTop}px`,
    )

    await handBack.click()
    await until(
      async () => (await facts(page)).active === "false",
      5_000,
      "the button to hand the gestures back",
    )
    assert.equal((await facts(page)).affordance, false, "the button goes with the gestures")
    await facts(page, true)
    await settled(page)
    before = await facts(page)
    await wheel(page, 260)
    after = await facts(page)
    assert.ok(
      after.scrollTop > before.scrollTop,
      `and the thread scrolls over the map again (${before.scrollTop}px to ${after.scrollTop}px)`,
    )
    assert.equal(view(after), view(before), "the map's view where the pan left it")
    pass(
      `the map's button handed the gestures back: the thread scrolls over it again (${before.scrollTop}px to ${after.scrollTop}px)`,
    )
  },
  { viewport: { width: 390, height: 844 }, touch: true },
)
