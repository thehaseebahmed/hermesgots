// A canvas on a phone, end to end: the page its bot writes and the chat it is edited in, each on a
// screen of its own with one flip between them — a canvas made from a prompt opens on its chat
// while the bot builds, Preview appears with the first version and draws the page, its head's asks
// for Chart.js and d3 answered so both libraries run inside the frame (the drawn page a refactor
// has to leave as it was), a box ticked on the page is kept by the host, an edit sent from the chat
// lands as a new version, Preview is where Undo is pressed, a page that asks to leave is refused and
// drawn again, and the chat's Point row sends the reader to the page
// and takes the element they tap back as the field's chip — and a visit costs only what its page
// asked: a page that asks for no library fetches none of one, and one that asks for three fetches
// each of those chunks once.
// The mark's own box at the head of the options' Name block opens the mark picker (issue #1065) as
// a sheet on the phone and a menu anchored to it on a wide screen, lucide's icons listed eight to a
// row and narrowed by the field, an icon then an emoji picked as the mark its row draws, and the one
// Remove Icon button under the grid clearing it back to the app's frame — and a pinned canvas's row
// in the docked sidebar wearing the mark it chose.
// A wide screen is the same canvas in two panes, and only boxes say where they are: no DOM without
// layout can measure which pane a header spans.
// The head is the last thing it reads, and only a browser can: how tight its line sits under its
// title's words, against a code session's head drawn in the same browser; whether the drawer or the
// way back to the list leads it, for a canvas the browser opened as the app's own entry and one the
// list opened; and the app's back press arming its exit at that entry, with the press after it
// leaving.

// A browser is the tier that holds it: the page is a sandboxed `srcdoc` document with an opaque
// origin of its own, the refusal of an outside navigation is the browser's own policy, the outline
// and the tap that answer a point are that document's own script, a library's source is a chunk
// only the browser runs (the component tier loads the sources, but no page makes a request), what a visit
// fetches is the browser's own request log rather than anything the build's output says, and the
// versions land from the mock's clock rather than a component test's single step. The mark's grid is
// boxes — eight to a row is a fact about layout — and which form the picker takes is the window's
// width, which a component test stands in for with a matchMedia stub and a browser answers itself.
import { app, assert, flow, mockJson, pass, SEND_CHORD, settled } from "./lib.mjs"

const PROMPT = "A checklist for the deck"
const EDIT = "Make it say the deck is done."

// The mock's check report (`mock-canvas.mjs`'s `checkOf`): the one turn a published version's
// checking visit holds, named for the version it read.
const checkReport = (version) => `Version ${version} drew its heading and its box.`

const FRAME = "iframe[data-canvas-frame]"

await flow(
  "canvas",
  async ({ page, seed, until, shot }) => {
    const frame = () => page.frameLocator(FRAME)
    /** The header's one flip, by the screen it goes to: `edit` from the page, `preview` from the chat. */
    const flip = (to) => page.locator(`[data-canvas-flip="${to}"]`)

    await page.goto(`${app}/canvas`)
    await page.getByRole("textbox", { name: "What the canvas should be" }).fill(PROMPT)
    await page.getByRole("button", { name: "Make it", exact: true }).click()
    // A canvas with no version has no page to preview, so its own address is the chat's: a phone
    // lands on the edit screen, and there is nothing in the header to flip to yet.
    await page.waitForURL(/\/canvas\/c_[^/]+\/edit$/, { timeout: 20_000 })
    const id = new URL(page.url()).pathname.split("/")[2]
    await page.getByLabel("Message", { exact: true }).waitFor({ timeout: 20_000 })
    // Both read in one turn of the page, so no later moment can answer for the one it opened at. The
    // chat is the whole of what this screen draws: the empty page, its icon and its line are the
    // preview's, and a phone is sent here once the record lands — a cold open draws that pane for a
    // frame before the address is replaced, which is the one moment it is seen at this width.
    const building = await page.evaluate(
      (frame) => ({
        said: document.body.innerText.includes("Canvas is building…"),
        empty: Boolean(document.querySelector("[data-slot=canvas-empty]")),
        frame: Boolean(document.querySelector(frame)),
        flip: Boolean(document.querySelector('[data-canvas-flip="preview"]')),
      }),
      FRAME,
    )
    assert.deepEqual(
      building,
      { said: false, empty: false, frame: false, flip: false },
      "the edit screen is the chat alone: nothing about the build, no page and no Preview",
    )
    await shot("edit-no-build")
    pass("the edit screen: a canvas made from a prompt lands on its chat, with no page and no Preview")
    // The lane while the build works: the block it is in — its request, the visits behind it and the
    // line saying what it is doing — over the composer. The mock holds its check a beat, so this is
    // the window it is drawn in.
    await shot("building")

    // The first version lands through the live record, so Preview is drawn without a reload, and
    // the flip replaces the chat's entry: the page stands where the chat stood, so the next back
    // press leaves the canvas for the list rather than landing on the screen it just left (ADR 0130).
    const preview = flip("preview")
    await preview.waitFor({ timeout: 30_000 })
    await preview.click()
    await page.waitForURL(new RegExp(`/canvas/${id}$`), { timeout: 20_000 })
    await frame()
      .getByText("Version 1 of this canvas", { exact: false })
      .waitFor({ timeout: 20_000 })
    assert.equal(
      await frame().locator("#done").isChecked(),
      false,
      "the page opens with its box unticked",
    )
    // The page asks for Chart.js by name, and the source it asked for is in the document where the
    // ask stood: a page drawn from the bundle's copies and one drawn from a source fetched for its
    // ask are the same page, which is the leg that makes the fetch a refactor rather than a change.
    assert.equal(
      await frame()
        .locator("body")
        .evaluate(() => typeof window.Chart),
      "function",
      "the page's ask for chart drew Chart.js inside the frame",
    )
    // And a second ask in the same head is a second library, fetched as its own chunk: the page
    // drew with `d3.select`, so what arrived is the library and not only a name on `window`.
    assert.equal(
      await frame()
        .locator("#value")
        .evaluate((el) => el.getAttribute("data-drawn-by")),
      "d3",
      "the page's ask for d3 drew with d3.select inside the frame",
    )
    await shot("preview-first")
    pass("the preview screen: Preview appears with the first version and draws the page")
    pass("the preview screen: a page that asks for chart draws with Chart.js in the frame")
    pass("the preview screen: a page that asks for d3 draws with d3.select in the frame")

    // The page's box is the canvas's own data, so the host is what keeps the tick.
    const [kept] = await Promise.all([
      page.waitForResponse(
        (answer) =>
          /\/canvases\/[^/]+\/call$/.test(answer.url()) && answer.request().method() === "POST",
        { timeout: 15_000 },
      ),
      frame().locator("#done").check(),
    ])
    assert.equal(
      (await kept.json()).result?.doc?.done,
      true,
      "the host kept the tick the page wrote",
    )
    pass("the preview screen: a box ticked on the page is kept by the host")

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
    const drawnFrame = await (await page.locator(FRAME).elementHandle())?.contentFrame()
    assert.equal(
      drawnFrame?.url(),
      "about:srcdoc",
      "the frame is the canvas's own document again",
    )
    await shot("held")
    pass(
      "the preview screen: a page that sets location to an outside URL stays put, and the app with it",
    )

    // Edit is the other screen, on its own address: a canvas's chat fills it, and the page it edits
    // is not drawn there at all.
    await flip("edit").click()
    await page.waitForURL(new RegExp(`/canvas/${id}/edit$`), { timeout: 20_000 })
    // The flip stands on the page's own entry rather than pushing a second one: the page is the
    // corner's way back, not a step, so the one canvas keeps one entry and the head's way back leaves
    // for the list instead of landing on the screen the chat was flipped from (ADR 0130).
    assert.equal(
      await page.evaluate(() => window.history.state?.idx ?? 0),
      1,
      "the flip to the chat stands on the page's own entry",
    )
    const field = page.getByLabel("Message", { exact: true })
    await field.waitFor({ timeout: 20_000 })
    assert.equal(await page.locator(FRAME).count(), 0, "the edit screen draws no page")
    await field.fill(EDIT)
    await field.press(SEND_CHORD)
    // The lane draws the build it is in while it works: the host's listing carries the working build,
    // so its request and the one row saying what it is doing are drawn before it publishes. The mock
    // holds its check a beat, which is this window.
    const working = page.locator("[data-canvas-build]").filter({ hasText: EDIT })
    await working.locator("[data-build-details]").waitFor({ timeout: 30_000 })
    assert.equal(
      await working.locator("[data-build-step]").count(),
      0,
      "the build draws one row, never a row for each visit it made",
    )
    assert.match(
      (await working.locator("[data-build-state]").innerText()).trim(),
      /^(Planning|Building|Checking|Publishing)\b/,
      "and that row says what the build is doing",
    )
    await shot("edit-building")
    pass("the edit screen: the working build is one row saying what it is doing")
    await page.getByText("v2", { exact: true }).waitFor({ timeout: 40_000 })
    // The lane is builds, not the transcript (G9, G10): the request it took is the row's line, and
    // the version it wrote is the row's version, drawn on the edit screen itself.
    const builds = page.locator("[data-canvas-builds]")
    await builds.waitFor({ timeout: 20_000 })
    await builds.getByText(EDIT, { exact: true }).waitFor({ timeout: 20_000 })
    assert.equal(
      await page.locator("[data-canvas-builds] [data-build-details]").count() > 0,
      true,
      "each build offers ready",
    )
    // The row the build was while it worked becomes the version it published: one press opens the
    // whole run, before or after that.
    const readyLine = builds
      .locator("[data-canvas-build]")
      .filter({ hasText: EDIT })
      .locator("[data-build-details]")
      .first()
    await readyLine.waitFor({ timeout: 20_000 })
    assert.equal(
      (await readyLine.locator("[data-build-state]").innerText()).trim(),
      "Version 2 published",
      "the row it was while it worked becomes the version it published",
    )
    assert.equal(
      await page.locator("[data-build-details]").first().evaluate(
        (one) => one.tagName,
      ),
      "BUTTON",
      "and the whole row is the press, not a word inside it",
    )
    pass("the edit screen: the lane draws the build's request and the version it published")

    const build = builds.locator("[data-canvas-build]").filter({ hasText: EDIT })
    assert.equal(
      await builds.getByText(checkReport(2)).count(),
      0,
      "the build's checking turn is not drawn in the lane",
    )
    pass("the edit screen: the lane draws the build's request and the version it published")

    await readyLine.click()
    // The run opens in the pop-up a subagent's row opens: the standard bottom sheet on a phone,
    // which rests at the foot of the screen and is dragged by its handle.
    const stepSheet = page.locator('[data-popup-form="sheet"]')
    await stepSheet.waitFor({ timeout: 20_000 })
    await stepSheet.getByText(checkReport(2)).waitFor({ timeout: 20_000 })
    assert.equal(
      (await stepSheet.locator('[data-slot="sheet-title"]').innerText()).trim(),
      "Build",
      "the sheet is titled by the build whose row was pressed",
    )
    assert.equal(
      (await stepSheet.locator('[data-slot="sheet-description"]').innerText()).trim(),
      EDIT,
      "and describes the build by its first request",
    )
    // The run is marked where each visit began, so the phases the lane used to draw as five rows are
    // read inside the work they were spent on.
    assert.ok(
      (await stepSheet.locator("[data-build-mark]").count()) > 0,
      "the run is marked where each visit began",
    )
    assert.match(
      (await stepSheet.locator("[data-build-mark]").first().innerText()).trim(),
      /^Planning\b/,
      "and its first mark is the planning visit the build began with",
    )
    assert.equal(
      await stepSheet.getByText(checkReport(1)).count(),
      0,
      "the build before this one checked too, and its report is not in this build's run",
    )
    // One scroller, not two: the pop-up's box holds the thread, and the thread's own viewport is
    // what moves, so a long step never scrolls its header away inside a second scroller.
    const stepBox = await page.evaluate(() => {
      const popup = document.querySelector('[data-popup-form="sheet"]')
      const box = popup?.querySelector('[data-slot="build-transcript"]')
      const handle = popup?.querySelector('[aria-label="Close"]')
      const viewport = popup?.querySelector('[data-slot="message-scroller-viewport"]')
      if (!popup || !box || !handle) return null
      const sheet = popup.getBoundingClientRect()
      const grip = handle.getBoundingClientRect()
      return {
        top: Math.round(sheet.top),
        bottom: Math.round(sheet.bottom),
        grip: Math.round(grip.top),
        box: box.scrollHeight - box.clientHeight,
        thread: Boolean(viewport),
        viewport: viewport ? Math.round(viewport.clientHeight) : 0,
        screen: window.innerHeight,
      }
    })
    console.log(
      `step sheet 390 — sheet ${stepBox?.top}→${stepBox?.bottom} of ${stepBox?.screen}, ` +
        `handle at ${stepBox?.grip}, pop-up box scrolled ${stepBox?.box}px, ` +
        `thread viewport ${stepBox?.viewport}px`,
    )
    assert.ok(stepBox, "the step's pop-up draws its box, its handle and the thread's viewport")
    assert.ok(
      Math.abs(stepBox.bottom - stepBox.screen) <= 1,
      `the sheet rests at the foot of the screen (bottom ${stepBox.bottom} of ${stepBox.screen})`,
    )
    assert.ok(stepBox.top > 0, `and rises from it (top ${stepBox.top})`)
    assert.ok(
      stepBox.grip - stepBox.top < 64,
      `the handle stands at the sheet's head (handle ${stepBox.grip}, sheet top ${stepBox.top})`,
    )
    assert.equal(
      stepBox.box,
      0,
      `the pop-up's own box never scrolls a second time (${stepBox.box}px past it)`,
    )
    assert.ok(
      stepBox.thread && stepBox.viewport > 0,
      `the thread's own viewport is the bounded scroller inside it (${stepBox.viewport}px)`,
    )
    await shot("step-sheet")
    pass("the edit screen: a checking marker opens a sheet holding that step's turn, and no other")
    await page.keyboard.press("Escape")
    await stepSheet.waitFor({ state: "detached", timeout: 10_000 })
    await shot("edited")
    pass("the edit screen: an edit sent from its chat lands as version 2")

    await flip("preview").click()
    await page.waitForURL(new RegExp(`/canvas/${id}$`), { timeout: 20_000 })
    await frame()
      .getByText("Version 2 of this canvas", { exact: false })
      .waitFor({ timeout: 20_000 })
    assert.equal(
      await frame().getByText(EDIT, { exact: true }).isVisible(),
      true,
      "the version drawn holds the words the edit was asked with",
    )
    await until(() => frame().locator("#done").isChecked(), 10_000, "the edit to keep the box ticked")
    await shot("edited-page")
    pass("the preview screen: version 2 draws with the box still ticked")

    // Undo is the page's own: it moves the record back, and the box is the canvas's data, which no
    // version replaces.
    await page.getByRole("button", { name: "Undo", exact: true }).click()
    await page.getByText("v1", { exact: true }).waitFor({ timeout: 20_000 })
    await frame()
      .getByText("Version 1 of this canvas", { exact: false })
      .waitFor({ timeout: 20_000 })
    await until(() => frame().locator("#done").isChecked(), 10_000, "Undo to keep the box ticked")
    await shot("undone")
    pass("the preview screen: Undo draws the first version with the box still ticked")

    // A gap only a browser can measure: the sheet's heading starts 16px below its drag handle.
    await page.locator("[data-canvas-options-open]").click()
    // Named, not any sheet's title: the options open the mark picker as a sheet of its own, and a
    // screen with two sheets has two titles.
    const optionsTitle = page.getByRole("heading", { name: "Options", exact: true })
    await optionsTitle.waitFor({ timeout: 10_000 })
    await settled(page)
    const gap = await page.evaluate(() => {
      const popup = document.querySelector('[data-popup-form="sheet"]')
      const handle = popup?.querySelector('[aria-label="Close"]')
      const heading = document.querySelector('[data-slot="sheet-title"]')
      const bottom = handle?.getBoundingClientRect().bottom ?? null
      const top = heading?.getBoundingClientRect().top ?? null
      return {
        handle: bottom === null ? null : Math.round(bottom),
        heading: top === null ? null : Math.round(top),
        gap: bottom === null || top === null ? null : Math.round(top - bottom),
      }
    })
    console.log(
      `options sheet 390 — handle bottom ${gap.handle}, heading top ${gap.heading} ` +
        `(gap ${gap.gap}px)`,
    )
    assert.equal(
      gap.gap,
      16,
      `the sheet's heading clears the drag handle by 16px, not ${gap.gap} ` +
        `(handle bottom ${gap.handle}, heading top ${gap.heading})`,
    )
    await shot("options-sheet")
    // The face a pinned canvas's row draws (#1065, #1074): the box at the head of the options' Name
    // block opens the picker as a sheet on this phone, its search narrows lucide's own set, and what
    // is picked is the record's — an icon, then the app's own frame mark again. The other tab is the
    // thumbnail, which is one inline image on the same record.
    const grid = () => page.locator('[data-slot="canvas-mark-picker"] [data-canvas-mark-grid="icons"]')
    await page.locator("[data-canvas-mark-open]").click()
    // The icons are one chunk fetched the first time something draws one, so the grid is waited for
    // rather than asserted at once.
    await grid().waitFor({ timeout: 40_000 })
    await page.getByRole("searchbox", { name: "Search icons" }).fill("heart")
    await page.getByRole("button", { name: "Heart", exact: true }).waitFor({ timeout: 10_000 })
    // Eight to a row, measured rather than read off a class: a wrapped cell is still a cell, and only
    // a box says which row it landed in.
    const gridBoxes = await page.evaluate(() => {
      const ys = [...document.querySelectorAll('[data-canvas-mark-grid="icons"] button')].map((cell) =>
        Math.round(cell.getBoundingClientRect().y),
      )
      return { inRow: ys.filter((y) => y === ys[0]).length, total: ys.length }
    })
    console.log(`mark picker 390 — ${gridBoxes.inRow} to the row of ${gridBoxes.total}`)
    assert.equal(gridBoxes.inRow, 8, `the picker draws eight icons to a row (${gridBoxes.inRow})`)
    assert.equal(
      await page.locator('[data-popup-form="sheet"] [data-slot="canvas-mark-picker"]').count(),
      1,
      "a phone draws the picker as a sheet",
    )
    // The grid is the thing that scrolls: the way back to the app's own mark is pinned under it, so
    // clearing a mark is never a scroll past every icon to find.
    const pinnedClear = await page.evaluate(() => {
      const picker = document.querySelector('[data-slot="canvas-mark-picker"]')?.closest("[data-popup-form]")
      const clear = document.querySelector("[data-canvas-mark-unset]")
      if (!picker || !clear) return null
      const box = picker.getBoundingClientRect()
      const row = clear.getBoundingClientRect()
      return { popup: Math.round(box.bottom), row: Math.round(row.bottom), top: Math.round(row.top), popupTop: Math.round(box.top) }
    })
    assert.ok(
      pinnedClear && pinnedClear.row <= pinnedClear.popup && pinnedClear.top >= pinnedClear.popupTop,
      `the clear row is inside the picker without scrolling (row ${JSON.stringify(pinnedClear)})`,
    )
    await shot("mark-picker")
    await page.getByRole("button", { name: "Heart", exact: true }).click()
    await page.locator("[data-canvas-mark-open] svg.lucide-heart").waitFor({ timeout: 20_000 })
    await shot("mark-icon")
    pass("the options: the picker searches lucide's icons eight to a row, and the icon picked is the mark")

    // Two ways and no third: the icon just picked, and the thumbnail beside it.
    await page.locator("[data-canvas-mark-open]").click()
    await grid().waitFor({ timeout: 20_000 })
    assert.deepEqual(
      await page.getByRole("tab").allTextContents(),
      ["Icon", "Thumbnail"],
      "the card offers an icon and a thumbnail, and nothing else",
    )
    pass("the options: the picker offers an icon and a thumbnail, and no third way")

    // And the way back to the app's own frame mark, which is what clears the record's — the picker
    // just opened stands on the icons, so its clear row is under them already.
    await page.getByRole("button", { name: "Remove Icon" }).click()
    await page.locator("[data-canvas-mark-open] svg.lucide-frame").waitFor({ timeout: 20_000 })
    await page
      .locator('[data-slot="canvas-mark-picker"]')
      .waitFor({ state: "detached", timeout: 10_000 })
    pass("the options: the one button under the grid clears the mark back to the app's frame")
    // Shut again, so the legs after this one read the page and not a sheet laid over it.
    await page.keyboard.press("Escape")
    await optionsTitle.waitFor({ state: "detached", timeout: 10_000 })
    pass("the preview screen: the options sheet's heading starts 16px below its drag handle")

    // A press on the words of the line rather than on a box a component test painted: hit-testing
    // lands on the block that answers it, which only a browser can prove.
    await page.locator('[data-slot="header-line"]').getByText(/^v\d+$/).click()
    await optionsTitle.waitFor({ timeout: 10_000 })
    await page.keyboard.press("Escape")
    await optionsTitle.waitFor({ state: "detached", timeout: 10_000 })
    pass("the preview screen: a press on the line under the title opens the options")

    // Pointing is the phone's round trip: the edit screen draws no page, so its Point row sends the
    // reader to the page with pointing armed, and the tap that answers happens inside the sandboxed
    // document — the outline under the finger and the element's words are the page's own script
    // talking to the app through the bridge, which no DOM without a frame can produce.
    await flip("edit").click()
    await page.waitForURL(new RegExp(`/canvas/${id}/edit$`), { timeout: 20_000 })
    await page.getByRole("button", { name: "Add context" }).click()
    await page.getByRole("button", { name: "Point at the page", exact: true }).click()
    await page.waitForURL(new RegExp(`/canvas/${id}\\?point=1$`), { timeout: 20_000 })
    await page.getByText("Tap an element on the page", { exact: true }).waitFor({ timeout: 20_000 })
    await shot("point-armed")
    pass("the edit screen: Point at the page sends the reader to the page, armed")

    // The page's own half: a pointer over an element outlines it, and a tap answers that element.
    const headed = frame().locator("h1")
    await headed.hover()
    await until(
      async () => (await headed.getAttribute("data-gots-point")) === "",
      10_000,
      "the page to outline the element under the pointer",
    )
    await headed.click()
    await page.waitForURL(new RegExp(`/canvas/${id}/edit$`), { timeout: 20_000 })
    const chip = page.locator("[data-draft-point]")
    await chip.waitFor({ timeout: 20_000 })
    assert.equal(
      (await chip.innerText()).trim(),
      "Deck checklist",
      "the chip is the tapped element's own words",
    )
    await shot("point-chip")
    pass("the preview screen: a tap on the page's h1 comes back as the chat's chip")

    await page.getByRole("button", { name: "Remove the point on Deck checklist" }).click()
    await chip.waitFor({ state: "detached", timeout: 10_000 })
    pass("the edit screen: the chip's cross takes the point off the field")

    // What a visit fetches is the page's own ask, and nothing else: the two canvases seeded here
    // differ in nothing but the libraries their head names. The frame has been up since Preview
    // first drew, so this window holds the visits and not the app's boot, and what is counted is
    // the requests themselves — a library's source is one request of its own, `?raw` and `.js`,
    // which only the canvas's sources are (the base stylesheet is `.css`, the demos' article `.md`).
    const chunks = []
    page.on("request", (request) => {
      const { pathname } = new URL(request.url())
      if (request.url().endsWith("?raw") && pathname.endsWith(".js")) {
        chunks.push(pathname.split("/").pop())
      }
    })
    const visit = async (fixture) => {
      const { id: seeded } = await mockJson("/__mock/canvas", { fixture })
      const from = chunks.length
      await page.goto(`${app}/canvas/${seeded}`)
      const drawn = frame().locator("#drawn")
      // The frame is drawn only once the sources its page asked for are in hand, so a frame that
      // is up is a fetch that is over: nothing arrives after this to be counted.
      await drawn.waitFor({ timeout: 20_000 })
      return { id: seeded, fetched: chunks.slice(from), drew: await drawn.innerText() }
    }

    const quiet = await visit("plain")
    assert.deepEqual(
      quiet.fetched,
      [],
      `a page that asks for no library fetches none of one, fetched ${quiet.fetched.join(", ")}`,
    )
    assert.equal(quiet.drew, "nothing", "and the page drew, from the platform alone")
    await shot("no-libraries")
    pass("the preview screen: a canvas that asks for no library fetches none of one")

    const many = await visit("many")
    assert.deepEqual(
      [...many.fetched].sort(),
      ["chart.umd.min.js", "d3.min.js", "dayjs.min.js"],
      `a page that asks for three libraries fetches each of those chunks once, fetched ` +
        `${many.fetched.join(", ") || "none"}`,
    )
    assert.equal(many.drew, "chart d3 date", "and the page drew with all three inside the frame")
    await shot("three-libraries")
    pass("the preview screen: a canvas that asks for three libraries fetches each chunk once")

    // How tight the head is under its title, which only a browser can measure: the line's own top
    // against the words' bottom, in this head and in the code session's — the same row, drawn
    // centered for a session, with no control around its title.
    const headGap = () =>
      page.evaluate(() => {
        const title = document.querySelector('[data-slot="header-title"]')
        const line = document.querySelector('[data-slot="header-line"]')
        if (!title || !line) return null
        // The words' own box, which is the deepest box the title draws: a title that is a control
        // wraps them in one, and it is that box — not the title's — that ends where they end.
        let words = title
        while (words.firstElementChild) words = words.firstElementChild
        const round = (size) => Math.round(size * 10) / 10
        return {
          under: round(line.getBoundingClientRect().top - words.getBoundingClientRect().bottom),
          words: round(words.getBoundingClientRect().height),
          box: round(title.getBoundingClientRect().height),
        }
      })
    await settled(page)
    const canvasHead = await headGap()
    // A chat in a project draws the code session's head: a seeded one is read as unread rather than
    // unstarted, so its title and its line are drawn with no turn behind them.
    await seed([{ id: "gap-session", title: "A session in a project", projectId: "p_1a2b3c4d" }])
    await page.goto(`${app}/c/gap-session`)
    await until(
      async () =>
        Boolean(
          (await page.locator('[data-slot="header-title"]').innerText().catch(() => "")).trim(),
        ) && Boolean(await page.locator('[data-slot="header-line"]').count()),
      20_000,
      "the session's head to draw its title and line",
    )
    const sessionHead = await headGap()
    console.log(
      `head 390 — canvas: title box ${canvasHead.box}px over words ${canvasHead.words}px, ` +
        `line ${canvasHead.under}px under them; code session: title box ${sessionHead.box}px ` +
        `over words ${sessionHead.words}px, line ${sessionHead.under}px under them`,
    )
    assert.ok(
      await page.locator("[data-code-session]").count(),
      "the head compared against is a code session's",
    )
    assert.ok(
      canvasHead.under <= 0.5,
      `the canvas's line begins under its title's words (${canvasHead.under}px of air)`,
    )
    assert.ok(
      Math.abs(canvasHead.under - sessionHead.under) <= 0.5,
      `and sits as tight as the code session's does (${sessionHead.under}px of air)`,
    )
    assert.ok(
      Math.abs(canvasHead.words - sessionHead.words) <= 0.5,
      "the title's box is its words' height in both heads",
    )
    await shot("head-gap")
    pass("the preview screen: the title and its line sit as tight as a code session's head")

    // The address a reader came from decides the head's first control, and no DOM without layout can
    // say which one a screen drew. An address the browser opened is the app's own entry, so nothing
    // stands behind it: the head leads with the drawer, and the app's back press arms its exit — the
    // press after it leaves rather than stepping onto a screen that isn't there.
    await page.goto(`${app}/canvas/${many.id}`)
    await page.locator(FRAME).waitFor({ timeout: 20_000 })
    await settled(page)
    const entryHead = await page.evaluate(() => ({
      drawer: Boolean(document.querySelector('header [aria-label="Open conversations"]')),
      back: Boolean(document.querySelector('header [aria-label="All canvases"]')),
      idx: window.history.state?.idx ?? 0,
    }))
    assert.deepEqual(
      entryHead,
      { drawer: true, back: false, idx: 0 },
      "a canvas the app opened leads with the drawer, with nothing behind it",
    )
    const presses = await page.evaluate(async () => {
      const { answerBackPress } = await import("/src/lib/native.ts")
      return [answerBackPress(), answerBackPress()]
    })
    assert.deepEqual(
      presses,
      ["armed", "leave"],
      "a back press at the entry arms the app's exit, and the one after it leaves",
    )
    await shot("head-entry")
    pass("the preview screen: a canvas the app opened leads with the drawer, and back arms the exit")

    // The list opens a canvas as its child, so the head leads back to it, named for the screen it
    // goes to, with no drawer drawn beside it — and the press steps there.
    await page.goto(`${app}/canvas`)
    await page.locator("[data-canvas-tile]").first().click()
    await page.waitForURL(new RegExp(`/canvas/c_[^/]+$`), { timeout: 20_000 })
    await page.locator(FRAME).waitFor({ timeout: 20_000 })
    await settled(page)
    const pushedHead = await page.evaluate(() => ({
      back:
        document
          .querySelector('header [aria-label="All canvases"]')
          ?.getAttribute("aria-label") ?? null,
      drawer: Boolean(document.querySelector('header [aria-label="Open conversations"]')),
    }))
    assert.deepEqual(
      pushedHead,
      { back: "All canvases", drawer: false },
      "a canvas the list opened leads back to the list, and draws no drawer beside it",
    )
    await shot("head-pushed")

    // The chat wears the same head (ADR 0130): the Edit corner opens it, and its leading control is
    // still the way back to the list the page was opened from — named for that list, with the drawer
    // not drawn beside it, and taking the step rather than drawing anything in its place.
    await page.locator('[data-canvas-flip="edit"]').click()
    await page.waitForURL(new RegExp(`/canvas/c_[^/]+/edit$`), { timeout: 20_000 })
    await settled(page)
    const chatHead = await page.evaluate(() => ({
      back:
        document
          .querySelector('header [aria-label="All canvases"]')
          ?.getAttribute("aria-label") ?? null,
      drawer: Boolean(document.querySelector('header [aria-label="Open conversations"]')),
    }))
    assert.deepEqual(
      chatHead,
      { back: "All canvases", drawer: false },
      "the chat leads back to the list the page was opened from, and draws no drawer beside it",
    )
    await shot("head-chat")
    await page.getByRole("button", { name: "All canvases" }).click()
    await page.waitForURL(`${app}/canvas`, { timeout: 20_000 })
    pass("both screens: a canvas the list opened is led back to the list, and steps there")
  },
  { viewport: { width: 390, height: 844 }, touch: true },
)

const at = (box) => (box ? `${box.x},${box.y} ${box.width}×${box.height}` : "none")

await flow(
  "canvas-wide",
  async ({ page, shot }) => {
    await page.goto(`${app}/canvas`)
    await page.getByRole("textbox", { name: "What the canvas should be" }).fill(PROMPT)
    // The page that isn't there yet is the pane's own empty state, and it is on screen for one gap
    // between the start and the first version. A watch takes it at first sight — its words and where
    // its two parts sit — rather than reading the screen again after the page has landed.
    await page.evaluate(() => {
      window.__emptySeen = null
      const box = (node) => {
        if (!node) return null
        const { x, y, width, bottom } = node.getBoundingClientRect()
        return {
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          bottom: Math.round(bottom),
          middle: Math.round(x + width / 2),
        }
      }
      const look = () => {
        const block = document.querySelector("[data-slot=canvas-empty]")
        const line = block?.querySelector("p")
        if (!block || !line?.textContent) return
        window.__emptySeen = {
          words: line.textContent,
          icon: box(block.querySelector("svg")),
          line: box(line),
          pane: box(document.querySelector("[data-canvas-page]")),
          beside: block.parentElement?.children.length ?? 0,
          root: parseFloat(getComputedStyle(document.documentElement).fontSize),
        }
        watch.disconnect()
      }
      const watch = new MutationObserver(look)
      watch.observe(document.body, { childList: true, subtree: true })
      look()
    })
    await page.getByRole("button", { name: "Make it", exact: true }).click()
    // A wide screen has room for both panes, so a start lands on the canvas's own address and nothing
    // forwards it to the chat's: the lane is already drawn there.
    await page.waitForURL(/\/canvas\/c_[^/]+$/, { timeout: 20_000 })
    const empty = await (
      await page.waitForFunction(() => window.__emptySeen, null, { timeout: 20_000 })
    ).jsonValue()
    console.log(
      `wide 1440 — empty page: icon ${empty.icon?.width}px at ${empty.icon?.middle}, ` +
        `line at ${empty.line?.y} in the pane ${empty.pane?.x}+${empty.pane?.width}`,
    )
    assert.equal(empty.words, "Canvas is building…", "an empty page says the canvas is building")
    assert.equal(empty.icon?.width, 4 * empty.root, "under the Canvas icon, at size-16 in rems")
    assert.equal(empty.beside, 1, "and the pane draws nothing beside it")
    assert.ok(
      empty.icon && empty.line && empty.icon.bottom <= empty.line.y,
      "the icon over the line",
    )
    const paneMiddle = empty.pane ? empty.pane.x + empty.pane.width / 2 : null
    assert.ok(
      empty.icon && paneMiddle !== null && Math.abs(empty.icon.middle - paneMiddle) <= 2,
      `both centred in the pane (icon ${empty.icon?.middle} of ${paneMiddle})`,
    )
    await shot("wide-building")
    pass("a wide screen: a canvas with no page says so over its Canvas icon, until the first version lands")

    await page.locator(FRAME).waitFor({ timeout: 40_000 })
    await settled(page)
    // One read of the screen, so no two boxes are measured a reflow apart.
    const measured = await page.evaluate((selector) => {
      const box = (node) => {
        if (!node) return null
        const { x, y, width, height, right, bottom } = node.getBoundingClientRect()
        return {
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height),
          right: Math.round(right),
          bottom: Math.round(bottom),
        }
      }
      const ownedLane = document.querySelector("[data-canvas-lane]")
      const ownedPage = document.querySelector("[data-canvas-page]")
      const frame = document.querySelector(selector)
      // Where a screen draws no pane of its own, the chat's column is the one the frame's page isn't.
      const head = document.querySelector("header")
      const field = document.querySelector('textarea[aria-label="Message"]')
      const control = document.querySelector("[data-canvas-options-open]")
      const middle = document.querySelector('[data-slot="header-middle"]')
      const pane = ownedPage ?? frame?.parentElement ?? null
      const lane =
        ownedLane ??
        (pane
          ? ([...(pane.parentElement?.children ?? [])].find((one) => one !== pane) ?? null)
          : null)
      return {
        lane: box(lane),
        page: box(pane),
        head: box(head),
        field: box(field),
        control: box(control),
        middle: box(middle),
        frame: box(frame),
        owned: Boolean(ownedLane && ownedPage),
        laneHoldsHead: Boolean(lane && head && lane.contains(head)),
        laneHoldsField: Boolean(lane && field && lane.contains(field)),
        laneHoldsFrame: Boolean(lane && frame && lane.contains(frame)),
        pageHoldsHead: Boolean(pane && head && pane.contains(head)),
        pageHeaders: pane ? pane.querySelectorAll("header").length : 0,
      }
    }, FRAME)
    console.log(
      `wide 1440 — head ${at(measured.head)}, lane ${at(measured.lane)}, ` +
        `page ${at(measured.page)}, frame ${at(measured.frame)}, chat ${at(measured.field)}, ` +
        `title ${at(measured.control)} of the middle slot ${at(measured.middle)}`,
    )

    // Relationships rather than x values, so a wider screen moves both and neither claim breaks.
    assert.ok(measured.lane && measured.page, "the wide screen draws two columns")
    assert.ok(measured.laneHoldsHead, "the canvas's head stands in the chat's column, as its lane")
    assert.ok(measured.laneHoldsField, "and the chat's field is drawn under it")
    assert.equal(measured.laneHoldsFrame, false, "the frame is the page's, never the lane's")
    assert.equal(measured.pageHoldsHead, false, "the page pane carries no header")
    assert.equal(measured.pageHeaders, 0, "and draws none of its own")
    assert.ok(
      measured.lane.x < measured.page.x,
      `the lane is the left pane (lane x=${measured.lane.x}, page x=${measured.page.x})`,
    )
    assert.ok(
      Math.abs(measured.lane.right - measured.page.x) <= 1,
      `the lane's right edge is the page's left edge (lane right=${measured.lane.right}, page x=${measured.page.x})`,
    )
    assert.ok(
      Math.abs(measured.lane.width - 412) <= 1,
      `the lane is the house's 412px list lane where there is room (${measured.lane.width})`,
    )
    assert.ok(
      measured.page.width >= 412,
      `the page is never narrower than the lane's floor (${measured.page.width})`,
    )
    assert.ok(
      measured.head.right <= measured.lane.right + 1,
      `the head spans the lane and no more (head right=${measured.head.right}, lane right=${measured.lane.right})`,
    )
    // The title's control fills the header's middle slot, so a press anywhere on the title line lands:
    // at 1440 the five-word title leaves most of that line dead if the control is content-sized.
    assert.ok(
      measured.control && measured.middle,
      `the wide screen draws the header's title control (control ${at(measured.control)}, middle ${at(measured.middle)})`,
    )
    assert.ok(
      measured.control.width >= measured.middle.width * 0.8,
      `the title control fills the middle slot it is drawn in (control ${measured.control.width}, ` +
        `middle ${measured.middle.width})`,
    )
    // The page is the screen's full height, and the frame's top inset is what says the header moved out.
    assert.ok(
      measured.page.y <= 1,
      `the page pane starts at the screen's top (${measured.page.y})`,
    )
    const inset = {
      left: measured.frame.x - measured.page.x,
      top: measured.frame.y - measured.page.y,
      right: measured.page.right - measured.frame.right,
      bottom: measured.page.bottom - measured.frame.bottom,
    }
    assert.deepEqual(
      inset,
      { left: 8, top: 8, right: 8, bottom: 8 },
      "the frame keeps its 8px inset on all four sides of the page",
    )
    assert.equal(
      measured.frame.width,
      measured.page.width - 16,
      `the frame keeps its 8px inset on both sides (frame ${measured.frame.width}, page ${measured.page.width})`,
    )
    assert.ok(
      measured.frame.height >= measured.page.height - 2 * 8 - 1,
      `and the pane's whole height less its gutters (${measured.frame.height} of ${measured.page.height})`,
    )
    assert.ok(
      measured.owned,
      "and the two panes are the screen's own, named for this flow ([data-canvas-lane], [data-canvas-page])",
    )
    await shot("wide-two-panes")
    pass("a wide screen: the chat's lane is the left pane, and the page fills the right with no header")

    // The mark the sidebar's row draws (#1065), where a wide screen keeps that row docked: the picker
    // is a floating menu beside the Mark row, and the pin is what puts the marked row in the band.
    await page.locator("[data-canvas-options-open]").click()
    const options = page.locator("[data-canvas-options]")
    await options.waitFor({ timeout: 10_000 })
    await page.locator("[data-canvas-mark-open]").click()
    const menu = page.locator('[data-popup-form="menu"] [data-slot="canvas-mark-picker"]')
    await menu.waitFor({ timeout: 40_000 })
    assert.equal(
      await page.locator('[data-popup-form="sheet"] [data-slot="canvas-mark-picker"]').count(),
      0,
      "a wide screen draws the picker as a menu beside its box, not a sheet",
    )
    await page.getByRole("searchbox", { name: "Search icons" }).fill("star")
    await page.getByRole("button", { name: "Star", exact: true }).click()
    await options.waitFor({ state: "visible", timeout: 10_000 })
    // The row's own words are what a thumb presses: the switch's input is the label's, hidden.
    await options.getByText("Pin to sidebar", { exact: true }).click()
    await page.keyboard.press("Escape")
    await page.locator("a[data-canvas-pinned] svg.lucide-star").waitFor({ timeout: 20_000 })
    await shot("pinned-mark")
    pass("a wide screen: the picker is a menu beside the mark's box, and the pinned row draws its mark")

    // The scrollbar is the platform's own, and it is pinned here rather than styled: the page's
    // document is grown past its own viewport, and what is read is what the app does NOT force —
    // no `overflow` rule, no `scrollbar-gutter`, no reserved gutter. Nothing in the canvas path sets
    // one (the screen, `canvas-document.ts` and the shell alike), so this is green on the code as it
    // stands; its value is that whoever next tries to "fix" the scrollbar by hand meets a failure.
    const scrolled = await page
      .frameLocator(FRAME)
      .locator("body")
      .evaluate(() => {
        document.body.style.minHeight = "3000px"
        const root = getComputedStyle(document.documentElement)
        return {
          grown: document.documentElement.scrollHeight,
          viewport: window.innerHeight,
          overflowY: root.overflowY,
          gutter: root.scrollbarGutter,
          reserved: window.innerWidth - document.documentElement.clientWidth,
        }
      })
    console.log(
      `wide 1440 — frame document ${scrolled.grown}px in a ${scrolled.viewport}px viewport: ` +
        `overflow-y ${scrolled.overflowY}, scrollbar-gutter ${scrolled.gutter}, ` +
        `gutter reserved ${scrolled.reserved}px`,
    )
    assert.ok(
      scrolled.grown > scrolled.viewport,
      `the frame's document is grown past its viewport (${scrolled.grown} > ${scrolled.viewport})`,
    )
    assert.equal(
      scrolled.overflowY,
      "visible",
      `the app forces no overflow on the page's document (overflow-y ${scrolled.overflowY})`,
    )
    assert.equal(
      scrolled.gutter,
      "auto",
      `and no scrollbar-gutter either (scrollbar-gutter ${scrolled.gutter})`,
    )
    assert.equal(
      scrolled.reserved,
      0,
      `the platform reserves no gutter of its own (${scrolled.reserved}px of ` +
        `${scrolled.viewport}px viewport width)`,
    )
    pass("a wide screen: the page's document keeps the platform's own scrollbar, unstyled and unpinned")
  },
  { viewport: { width: 1440, height: 900 } },
)


await flow(
  "canvas-narrow",
  async ({ page, shot }) => {
    await page.goto(`${app}/canvas`)
    await page.getByRole("textbox", { name: "What the canvas should be" }).fill(PROMPT)
    await page.getByRole("button", { name: "Make it", exact: true }).click()
    await page.waitForURL(/\/canvas\/c_[^/]+$/, { timeout: 20_000 })
    await page.locator(FRAME).waitFor({ timeout: 40_000 })
    await settled(page)
    const measured = await page.evaluate((selector) => {
      const box = (node) => {
        if (!node) return null
        const { x, y, width, height, right } = node.getBoundingClientRect()
        return {
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height),
          right: Math.round(right),
        }
      }
      const send = [...document.querySelectorAll("button")].find(
        (one) => one.getAttribute("aria-label") === "Send",
      )
      return {
        lane: box(document.querySelector("[data-canvas-lane]")),
        page: box(document.querySelector("[data-canvas-page]")),
        frame: box(document.querySelector(selector)),
        send: box(send),
      }
    }, FRAME)
    console.log(
      `narrow 1024 — lane ${at(measured.lane)}, page ${at(measured.page)}, ` +
        `frame ${at(measured.frame)}, send ${at(measured.send)}`,
    )
    assert.ok(measured.lane && measured.page, "1024 draws two columns")
    assert.ok(
      Math.abs(measured.lane.width - measured.page.width) <= 1,
      `a row too narrow for 412 beside 412 splits evenly (lane ${measured.lane.width}, ` +
        `page ${measured.page.width})`,
    )
    assert.ok(
      measured.lane.width < 412,
      `and the lane gives up the list lane's width to do it (${measured.lane.width})`,
    )
    assert.ok(
      measured.send && measured.send.right <= measured.lane.right,
      `the chat's Send stays inside the lane (send right ${measured.send?.right}, ` +
        `lane right ${measured.lane.right})`,
    )
    await shot("narrow-even-split")
    pass("a narrow screen: the two panes split the row evenly, and the composer fits its lane")

    // 1024 is where a pop-up turns from a bottom sheet into the side drawer, and a step's transcript
    // takes that same standard form: full height on the right, not a sheet over the lane.
    const narrowBuild = page.locator("[data-canvas-build]").first()
    await narrowBuild.locator("[data-build-details]").first().waitFor({ timeout: 40_000 })
    await narrowBuild.locator("[data-build-details]").last().click()
    const narrowStep = page.locator('[data-popup-form="drawer"]')
    await narrowStep.waitFor({ timeout: 20_000 })
    // The drawer slides in from the right; only at rest is its edge the screen's.
    await settled(page)
    await narrowStep
      .locator('[data-slot="message-scroller-viewport"]')
      .waitFor({ timeout: 20_000 })
    const drawerBox = await page.evaluate(() => {
      const popup = document.querySelector('[data-popup-form="drawer"]')
      const box = popup?.querySelector('[data-slot="build-transcript"]')
      const viewport = popup?.querySelector('[data-slot="message-scroller-viewport"]')
      if (!popup || !box) return null
      const drawn = popup.getBoundingClientRect()
      return {
        top: Math.round(drawn.top),
        right: Math.round(drawn.right),
        height: Math.round(drawn.height),
        width: Math.round(drawn.width),
        box: box.scrollHeight - box.clientHeight,
        viewport: viewport ? Math.round(viewport.clientHeight) : 0,
        screen: { width: window.innerWidth, height: window.innerHeight },
      }
    })
    console.log(
      `step drawer 1024 — ${drawerBox?.width}×${drawerBox?.height} at right ${drawerBox?.right} ` +
        `of ${drawerBox?.screen?.width}, pop-up box scrolled ${drawerBox?.box}px, ` +
        `thread viewport ${drawerBox?.viewport}px`,
    )
    assert.ok(drawerBox, "1024 opens the step in the standard drawer, with the thread's box in it")
    assert.ok(
      Math.abs(drawerBox.right - drawerBox.screen.width) <= 1 &&
        Math.abs(drawerBox.height - drawerBox.screen.height) <= 1,
      `the drawer is the screen's full height on its right (right ${drawerBox.right} of ` +
        `${drawerBox.screen.width}, height ${drawerBox.height} of ${drawerBox.screen.height})`,
    )
    assert.equal(
      drawerBox.box,
      0,
      `the pop-up's own box never scrolls a second time (${drawerBox.box}px past it)`,
    )
    assert.ok(
      drawerBox.viewport > 0,
      `the thread's own viewport is the bounded scroller inside it (${drawerBox.viewport}px)`,
    )
    await shot("step-sheet-1024")
    pass("a narrow screen: a step's transcript opens in the standard drawer, the thread its one scroller")
  },
  { viewport: { width: 1024, height: 900 } },
)
