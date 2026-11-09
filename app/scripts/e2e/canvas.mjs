// A canvas on a phone, end to end: the page a bot writes, its own chat raised over it as a half
// sheet, and the loop between them — a box ticked on the page, an edit sent from the sheet, Undo, a
// point tagged while the sheet is up, a page that asks to leave and is drawn again, and the sheet
// swiped down to leave the page whole. A browser is the tier that holds it: the sheet's stops and
// the strip of page above it are geometry, the frame's sandbox and the app's `frame-src 'self'` are
// the browser's own, and a swipe is its input pipeline.
import { app, assert, flow, pass, SEND_CHORD, swipeBy } from "./lib.mjs"

const PROMPT = "A checklist for the deck"
const EDIT = "Make it say the deck is done."
// The chat's own sheet, by the name it carries: the `+` menu is a sheet too, and this is the one
// conversation the page is edited in.
const SHEET = /^Edit with/

const FRAME = "iframe[data-canvas-frame]"

await flow(
  "canvas",
  async ({ page, until, shot }) => {
    const frame = () => page.frameLocator(FRAME)
    const sheet = () => page.getByRole("dialog", { name: SHEET })
    const { width, height } = page.viewportSize()
    /** What a press at a point of the screen reaches: the page, or what stands over it. */
    const at = (x, y) =>
      page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase() ?? null,
        { x, y },
      )
    const frameBox = async () => {
      const box = await page.locator(FRAME).boundingBox()
      assert.ok(box, "the page is drawn")
      return box
    }
    /** Where the sheet's own top edge stands on the screen. */
    const sheetTop = async () => {
      const box = await sheet().boundingBox()
      assert.ok(box, "the sheet has a box")
      return box.y
    }

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
    // Both read in one turn of the page, so no later moment can answer for the one it opened at.
    const building = await page.evaluate((frame) => ({
      said: document.body.innerText.includes("Your bot is building it…"),
      frame: Boolean(document.querySelector(frame)),
    }), FRAME)
    assert.deepEqual(building, { said: true, frame: false }, "the page is still building, no frame")
    const field = sheet().getByLabel("Message", { exact: true })
    await field.waitFor({ timeout: 20_000 })
    // Non-modal, which no attribute can say: the page above the sheet's top edge takes a press
    // rather than a scrim or the sheet's full-height viewport. The frame's sandbox and policy are
    // the component tier's (`test-canvas-screen.tsx`).
    await frame().locator("h1").waitFor({ timeout: 20_000 })
    const firstTop = await sheetTop()
    assert.equal(
      await at(width / 2, Math.round((await frameBox()).y + 40)),
      "iframe",
      "the canvas above the sheet's top edge takes a press",
    )
    assert.ok(
      Math.abs(firstTop - height / 2) <= 2,
      `the sheet rests at half the ${height}px screen (its top at ${firstTop}px)`,
    )
    // The chat is laid out in the stop the sheet rests at, so its composer is on the screen: the
    // sheet's own visible height is what the content fills, not the full height it is dragged in.
    const form = await sheet().locator("form").last().boundingBox()
    assert.ok(form, "the sheet draws a composer")
    assert.ok(
      Math.abs(height - (form.y + form.height)) <= 24 && form.y > firstTop,
      `the composer stands in the stop the sheet rests at, on the screen's bottom (${Math.round(form.y)}px to ${Math.round(form.y + form.height)}px)`,
    )
    await shot("sheet-building")
    pass("the page builds under a non-modal sheet held at half the screen")

    // The tap crosses the sheet's invisible half and lands on the page; the tick is the canvas's own
    // data, so the host is what keeps it.
    const box = await frame().locator("#done").boundingBox()
    assert.ok(box, "the page draws its box")
    assert.ok(
      box.y + box.height <= firstTop,
      `the box stands above the sheet, at ${Math.round(box.y)}px`,
    )
    const [kept] = await Promise.all([
      page.waitForResponse(
        (answer) => /\/canvases\/[^/]+\/call$/.test(answer.url()) && answer.request().method() === "POST",
        { timeout: 15_000 },
      ),
      frame().locator("#done").check(),
    ])
    assert.equal(
      (await kept.json()).result?.doc?.done,
      true,
      "the host kept the tick the page wrote",
    )
    pass("a box ticked on the page above the sheet is kept by the host")

    // A page that asks to leave: the app's own `frame-src 'self'` refuses it, and the screen draws
    // the version again rather than leaving the browser's error page in the frame.
    const asked = []
    page.on("request", (request) => {
      if (request.url().startsWith("https://example.com")) asked.push(request.url())
    })
    const before = page.url()
    // A mark in the document that answers: the page drawn again is a new document, so the mark's
    // absence is the proof that the frame really was replaced and the screen really redrew it.
    await frame().locator("body").evaluate((body) => {
      body.dataset.e2eProbe = "1"
    })
    await frame().locator("#leave").click()
    await until(
      async () => (await frame().locator("body").getAttribute("data-e2e-probe")) !== "1",
      15_000,
      "the page to be replaced and drawn again",
    )
    assert.equal(asked.length, 0, "the browser never fetched the outside URL")
    assert.equal(page.url(), before, "the app stayed on the canvas's own address")
    await frame().locator("h1").waitFor({ timeout: 10_000 })
    assert.ok(
      Math.abs((await sheetTop()) - firstTop) <= 1,
      "the sheet is where it was",
    )
    const drawnFrame = await (await page.locator(FRAME).elementHandle())?.contentFrame()
    assert.equal(
      drawnFrame?.url(),
      "about:srcdoc",
      "the frame is the canvas's own document again",
    )
    await shot("held")
    pass("a page that sets location to an outside URL stays put, and the app with it")

    await field.fill(EDIT)
    await field.press(SEND_CHORD)
    await page.getByText("v2", { exact: true }).waitFor({ timeout: 40_000 })
    await frame().getByText("Version 2 of this canvas", { exact: false }).waitFor({ timeout: 20_000 })
    assert.equal(
      await frame().getByText(EDIT, { exact: true }).isVisible(),
      true,
      "the version drawn holds the words the edit was asked with",
    )
    await until(() => frame().locator("#done").isChecked(), 10_000, "the edit to keep the box ticked")
    await shot("edited")
    pass("an edit lands as version 2 with the box still ticked")

    await page.getByRole("button", { name: "Undo", exact: true }).click()
    await page.getByText("v1", { exact: true }).waitFor({ timeout: 20_000 })
    await frame().getByText("Version 1 of this canvas", { exact: false }).waitFor({ timeout: 20_000 })
    await until(() => frame().locator("#done").isChecked(), 10_000, "Undo to keep the box ticked")
    await shot("undone")
    pass("Undo draws the first version with the box still ticked")

    // The chip is the composer's, and the element tapped stands above the sheet's top edge.
    // Pointing is asked for in the composer's `+` sheet, where the other ways to add context are.
    await sheet().getByRole("button", { name: "Add context", exact: true }).click()
    await page.getByRole("button", { name: "Point at the page", exact: true }).click()
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
    assert.equal(label, "Deck checklist", `the chip carries the element's own words (${label})`)
    assert.equal(await sheet().isVisible(), true, "the sheet stayed up through the point")
    await shot("pointed")
    pass("a point tagged on the page over the open sheet reaches the composer's chip")

    // Swipe the sheet down from its handle: the page is left in view, whole. The sheet is an overlay
    // over a page that always filled the screen, so what changes is what a press below its top edge
    // reaches — the sheet's own content before, the canvas after.
    const lower = { x: width / 2, y: Math.round(firstTop + 60) }
    assert.notEqual(
      await at(lower.x, lower.y),
      "iframe",
      "the sheet covers the lower half before the swipe",
    )
    // The sheet's own close control is its grab target: the bar the reader drags.
    const handle = await sheet().locator("[aria-label=Close]").boundingBox()
    assert.ok(handle, "the sheet has a drag handle")
    await swipeBy(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, 320)
    await sheet().waitFor({ state: "detached", timeout: 10_000 })
    assert.equal(
      await at(lower.x, lower.y),
      "iframe",
      "the page is what a press below the old stop reaches",
    )
    const left = await frameBox()
    assert.ok(
      Math.abs(left.y + left.height - (height - 8)) <= 8,
      `the page fills the screen under the header (its bottom at ${Math.round(left.y + left.height)}px)`,
    )
    assert.equal(await page.locator("[data-canvas-edit-pill]").isVisible(), true, "Edit is back")
    await shot("left")
    pass("swiping the sheet down leaves the page in view, whole")
  },
  { viewport: { width: 390, height: 844 }, touch: true },
)
