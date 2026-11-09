// A canvas on a phone, end to end: the page a bot writes, its own chat raised over it as a
// non-modal half sheet, and the loop between them — a box ticked on the page, an edit sent from the
// sheet that lands without losing it, Undo walking the version back, a point tagged on the page while
// the sheet is up, a page that asks to leave for an outside URL and is held, and the sheet swiped
// down to leave the page whole.
//
// Why a browser: the sheet's stops and the strip of page above it are geometry with no proxy below
// one, the frame's sandbox and the app's `frame-src 'self'` are the browser's own, a swipe is the
// browser's input pipeline, and the host's versions land on its clock.
import { app, assert, flow, mock, mockAuth, pass, settled } from "./lib.mjs"

const PROMPT = "A checklist for the deck"
const EDIT = "Make it say the deck is done."
const SHEET = "[data-popup-form=sheet]"
const FRAME = "iframe[data-canvas-frame]"

/** The canvas as its host answers it: the record, the version drawn and the data the page wrote. */
async function canvasOf(id) {
  const res = await fetch(`${mock}/api/plugins/gots/canvases/${id}`, { headers: mockAuth })
  assert.equal(res.status, 200, "the host answers for the canvas")
  return (await res.json()).canvas
}

/** One finger on the page, moving `dy` px: a thumb's swipe, through the browser's own pipeline. */
async function swipe(page, at, dy) {
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

await flow(
  "canvas",
  async ({ page, until, shot }) => {
    // The frame's page, as the reader sees it: a frame's own locator reaches inside the sandbox.
    const frame = () => page.frameLocator(FRAME)
    const sheet = () => page.locator(SHEET)
    const frameBox = async () => {
      const box = await page.locator(FRAME).boundingBox()
      assert.ok(box, "the page is drawn")
      return box
    }
    const above = async (box) => {
      const box2 = await box()
      const hit = await page.evaluate(
        ({ x, y }) => {
          const at = document.elementFromPoint(x, y)
          return at?.tagName.toLowerCase() ?? null
        },
        { x: 195, y: Math.round(box2.y + 40) },
      )
      return hit
    }
    /** Where the sheet's own top edge stands on the screen. */
    const sheetTop = async () => {
      const box = await sheet().boundingBox()
      assert.ok(box, "the sheet has a box")
      return box.y
    }

    // A canvas is asked for on the list and made: the screen opens its own address, the record at
    // version 0 while the bot builds.
    await page.goto(`${app}/canvas`)
    await page.getByRole("textbox", { name: "What the canvas should be" }).fill(PROMPT)
    await page.getByRole("button", { name: "Make it", exact: true }).click()
    await page.waitForURL(/\/canvas\/c_/, { timeout: 20_000 })
    const id = new URL(page.url()).pathname.split("/").pop()
    await page.getByText("Your bot is building it…").waitFor({ timeout: 20_000 })
    pass("a canvas is made from a prompt and opens on its own address")

    // The sheet is raised while the page is still building: a phone has room for one of them, so
    // this is the one state where the loop is proved — the page lands under a sheet that is up.
    await page.locator("[data-canvas-edit-pill]").click()
    await sheet().waitFor({ timeout: 10_000 })
    // The sheet is raised before the page has landed: the building line is still what the screen
    // says, and no frame is drawn yet.
    assert.equal(
      await page.getByText("Your bot is building it…").isVisible(),
      true,
      "the page is still building when the sheet opens",
    )
    assert.equal(await page.locator(FRAME).count(), 0, "the page had not landed when the sheet opened")
    const field = sheet().getByLabel("Message", { exact: true })
    await field.waitFor({ timeout: 20_000 })
    // Non-modal, by the browser's own rules: no `aria-modal`, and the page above the sheet's top
    // edge is what a press lands on rather than a scrim or the sheet's full-height viewport.
    assert.notEqual(
      await sheet().getAttribute("aria-modal"),
      "true",
      "the sheet is not a modal dialog",
    )
    assert.equal(await page.locator("[role=dialog][aria-modal=true]").count(), 0, "no modal is up")
    await frame().locator("h1").waitFor({ timeout: 20_000 })
    assert.equal(
      await above(frameBox),
      "iframe",
      "the canvas above the sheet's top edge takes a press",
    )
    const firstTop = await sheetTop()
    assert.ok(
      firstTop > 300 && firstTop < 844 - 100,
      `the sheet rests at half the screen (its top at ${firstTop}px)`,
    )
    await shot("sheet-building")
    pass("the page builds under a non-modal sheet held at half the screen")

    // A box on the page is ticked while the sheet is up: the tap crosses the sheet's invisible half
    // and lands on the page, and the tick is the canvas's own data on the host.
    const box = await frame().locator("#done").boundingBox()
    assert.ok(box, "the page draws its box")
    assert.ok(
      box.y + box.height <= firstTop,
      `the box stands above the sheet, at ${Math.round(box.y)}px`,
    )
    await frame().locator("#done").check()
    await until(
      async () =>
        (await canvasOf(id)).data.some(
          (row) => row.collection === "checks" && row.id === "done" && row.doc?.done === true,
        ),
      15_000,
      "the host to keep the tick",
    )
    pass("a box ticked on the page above the sheet is kept by the host")

    // A page that asks to leave: it sets `location` to an outside URL, and neither the app nor the
    // page goes anywhere — the app's own `frame-src 'self'` is what holds it.
    const asked = []
    page.on("request", (request) => {
      if (request.url().startsWith("https://example.com")) asked.push(request.url())
    })
    const before = page.url()
    await frame().locator("#leave").click()
    await page.waitForTimeout(1_000)
    assert.equal(asked.length, 0, "the browser never fetched the outside URL")
    assert.equal(page.url(), before, "the app stayed on the canvas's own address")
    // The browser refuses the navigation and leaves the frame on its error page; the app draws the
    // canvas's own version there again, so the page the reader had is the page still on screen.
    await frame().locator("h1").waitFor({ timeout: 10_000 })
    assert.equal(await sheet().isVisible(), true, "the sheet is where it was")
    const frames = page.frames().filter((one) => one !== page.mainFrame())
    assert.deepEqual(
      frames.map((one) => one.url()),
      ["about:srcdoc"],
      "the frame is the canvas's own document again",
    )
    await shot("held")
    pass("a page that sets location to an outside URL stays put, and the app with it")

    // An edit sent from the sheet lands as the host's next version, drawn under the sheet with the
    // box still ticked: the data is the canvas's, not a version's.
    await field.fill(EDIT)
    await field.press("Control+Enter")
    await page.getByText("v2", { exact: true }).waitFor({ timeout: 40_000 })
    await frame().getByText("Version 2 of this canvas", { exact: false }).waitFor({ timeout: 20_000 })
    assert.equal(await frame().locator("#done").isChecked(), true, "the edit kept the box ticked")
    await shot("edited")
    pass("an edit lands as version 2 with the box still ticked")

    // Undo walks the pointer back one, and the data survives it too.
    await page.getByRole("button", { name: "Undo", exact: true }).click()
    await page.getByText("v1", { exact: true }).waitFor({ timeout: 20_000 })
    await frame().getByText("Version 1 of this canvas", { exact: false }).waitFor({ timeout: 20_000 })
    assert.equal(await frame().locator("#done").isChecked(), true, "Undo kept the box ticked")
    await shot("undone")
    pass("Undo draws the first version with the box still ticked")

    // Point, then tap an element on the page while the sheet is open: the chip is the composer's,
    // and the element tapped stood above the sheet's top edge.
    await sheet().getByRole("button", { name: "Point", exact: true }).click()
    const heading = await frame().locator("h1").boundingBox()
    assert.ok(heading, "the page's heading has a box")
    assert.ok(
      heading.y + heading.height <= (await sheetTop()),
      "the element to point at stands above the sheet",
    )
    await page.touchscreen.tap(heading.x + heading.width / 2, heading.y + heading.height / 2)
    const chip = page.locator("[data-draft-point]").first()
    await chip.waitFor({ timeout: 10_000 })
    const label = (await chip.innerText()).trim()
    assert.equal(label, PROMPT, `the chip carries the element's own words (${label})`)
    assert.equal(await sheet().isVisible(), true, "the sheet stayed up through the point")
    await shot("pointed")
    pass("a point tagged on the page over the open sheet reaches the composer's chip")

    // Swipe the sheet down from its handle: the page is left in view, whole.
    const handle = await sheet().locator("[aria-label=Close]").boundingBox()
    assert.ok(handle, "the sheet has a drag handle")
    await swipe(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, 320)
    await sheet().waitFor({ state: "detached", timeout: 10_000 })
    assert.equal(await sheet().count(), 0, "the sheet is gone")
    const left = await frameBox()
    assert.ok(
      left.height > firstTop,
      `the page took the room the sheet gave back (${Math.round(left.height)}px tall)`,
    )
    assert.equal(await page.locator("[data-canvas-edit-pill]").isVisible(), true, "Edit is back")
    await shot("left")
    pass("swiping the sheet down leaves the page in view, whole")
  },
  { viewport: { width: 390, height: 844 }, touch: true },
)
