// A canvas on a phone, end to end: the page its bot writes and the chat it is edited in, each on a
// screen of its own with one flip between them — a canvas made from a prompt opens on its chat
// while the bot builds, Preview appears with the first version and draws the page, its head's asks
// for Chart.js and d3 answered so both libraries run inside the frame (the drawn page a refactor
// has to leave as it was), a box ticked on the page is kept by the host, an edit sent from the chat
// lands as a new version, Preview is where Undo is pressed, a page that asks to leave is refused
// and drawn again, and the chat's Point row sends the reader to the page and takes the element
// they tap back as the field's chip — and a visit costs only what its page asked: a page that asks
// for no library fetches none of one, and one that asks for three fetches each of those chunks once.
// A browser is the tier that holds it: the page is a sandboxed `srcdoc` document with an opaque
// origin of its own, the refusal of an outside navigation is the browser's own policy, the outline
// and the tap that answer a point are that document's own script, a library's source is a chunk
// only the browser runs (the component tier loads the sources, but no page makes a request), what a visit
// fetches is the browser's own request log rather than anything the build's output says, and the
// versions land from the mock's clock rather than a component test's single step.
import { app, assert, flow, mockJson, pass, SEND_CHORD } from "./lib.mjs"

const PROMPT = "A checklist for the deck"
const EDIT = "Make it say the deck is done."

const FRAME = "iframe[data-canvas-frame]"

await flow(
  "canvas",
  async ({ page, until, shot }) => {
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
    await page.getByText("Your bot is building it…").waitFor({ timeout: 20_000 })
    // Both read in one turn of the page, so no later moment can answer for the one it opened at.
    const building = await page.evaluate(
      (frame) => ({
        said: document.body.innerText.includes("Your bot is building it…"),
        frame: Boolean(document.querySelector(frame)),
        flip: Boolean(document.querySelector('[data-canvas-flip="preview"]')),
      }),
      FRAME,
    )
    assert.deepEqual(
      building,
      { said: true, frame: false, flip: false },
      "the chat says it is building, with no page and no Preview",
    )
    await shot("edit-building")
    pass("the edit screen: a canvas made from a prompt lands on its chat, building it")

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
    const field = page.getByLabel("Message", { exact: true })
    await field.waitFor({ timeout: 20_000 })
    assert.equal(await page.locator(FRAME).count(), 0, "the edit screen draws no page")
    await field.fill(EDIT)
    await field.press(SEND_CHORD)
    await page.getByText("v2", { exact: true }).waitFor({ timeout: 40_000 })
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
      return { fetched: chunks.slice(from), drew: await drawn.innerText() }
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
  },
  { viewport: { width: 390, height: 844 }, touch: true },
)
