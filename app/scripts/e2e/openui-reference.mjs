import { app, assert, basemapOf, flow, pass, settled } from "./lib.mjs"

const ENTRY = "[data-reference-entry]"
const RULES = "[data-reference-block-rules]"
const RESULT = "[data-reference-result]"
// A block the library refuses: `Card`'s title is required, and an unquoted word is no title at all.
const BAD = ["root = Stack([card])", "card = Card(unquoted)"].join("\n")
const GOOD = [
  "root = Stack([table])",
  'table = Table(["City", "Days"], [["Berlin", 3], ["Lisbon", 5]], "Trip")',
].join("\n")
const WIDTHS = [390, 768]
/**
 * The two entries whose drawing arrives in a heap of its own, and what that heap leaves behind: the
 * wait for each entry is the wait for its library, and the assertions below read the same fields.
 */
const HEAVY = {
  Chart: (seen) => seen.chart > 0,
  Map: (seen) => seen.map,
}

const screen = (page) =>
  page.evaluate(
    ({ entries, rules }) => {
      const box = document.querySelector(rules)?.parentElement?.getBoundingClientRect()
      return {
        names: [...document.querySelectorAll(entries)].map((node) => node.dataset.referenceEntry),
        sideways: document.documentElement.scrollWidth - window.innerWidth,
        dark: document.documentElement.classList.contains("dark"),
        column: box ? { left: Math.round(box.left), right: Math.round(box.right) } : null,
      }
    },
    { entries: ENTRY, rules: RULES },
  )

/** One entry as a reader sees it: whether its drawing arrived, and the marks it leaves. */
const entry = (page, name) =>
  page.evaluate(
    ({ entries, rules, name }) => {
      const round = (value) => Math.round(value * 10) / 10
      const node = document.querySelector(`${entries}[data-reference-entry="${name}"]`)
      if (!node) return null
      const drawing = node.querySelector("[data-reference-drawing]")
      const place = (element) => {
        const box = element.getBoundingClientRect()
        return { left: round(box.left), right: round(box.right), width: round(box.width) }
      }
      const map = node.querySelector("[data-slot=map]")
      const chart = node.querySelector("[data-slot=chart]")
      // The map's own frame is the element wearing its summary, and the box its labels sit in.
      const frame = map?.querySelector("[role=img], [role=region]") ?? map ?? chart
      const frameBox = frame?.getBoundingClientRect()
      const inside = (box) =>
        Boolean(frameBox) &&
        box.left >= frameBox.left - 0.5 &&
        box.right <= frameBox.right + 0.5 &&
        box.top >= frameBox.top - 0.5 &&
        box.bottom <= frameBox.bottom + 0.5
      // `Reveal` stands a box of its own here and swaps what is inside it: the anchor is the
      // drawing's first child, and the reserved box its child — so a drawing is here when that
      // box has given way to something that is not `aria-hidden`.
      const revealed = drawing?.firstElementChild?.firstElementChild
      const column = document.querySelector(rules)?.parentElement
      return {
        drawn: Boolean(revealed) && !revealed.hasAttribute("aria-hidden"),
        drawing: drawing ? place(drawing) : null,
        column: column ? place(column) : null,
        chart: node.querySelectorAll("[data-slot=chart] svg").length,
        labels: [
          ...node.querySelectorAll(
            ".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value",
          ),
        ].map((tick) => tick.textContent?.trim() ?? ""),
        map: Boolean(node.querySelector(".leaflet-container")),
        places: [...node.querySelectorAll(".openui-map-label")].map((label) =>
          inside(label.getBoundingClientRect()),
        ),
        tiles: [...node.querySelectorAll("img.leaflet-tile")].map(
          (tile) => tile.getAttribute("src") ?? "",
        ),
        summary: frame?.getAttribute("aria-label") ?? null,
      }
    },
    { entries: ENTRY, rules: RULES, name },
  )

/** Scrolls an entry into the reader's view and waits for the drawing — and its library — to arrive. */
async function draw(page, until, name, note = "") {
  const ready = HEAVY[name]
  await page.locator(`${ENTRY}[data-reference-entry="${name}"]`).scrollIntoViewIfNeeded()
  await until(
    async () => {
      const seen = await entry(page, name)
      return seen?.drawn && (!ready || ready(seen))
    },
    20_000,
    `the ${name} entry to draw${note ? `, ${note}` : ""}`,
  )
  await settled(page)
  return entry(page, name)
}

await flow(
  "openui-reference",
  async ({ page, shot, until }) => {
    // The two heavy drawing libraries, by the modules the build keeps them in — never their
    // stylesheets: each is fetched once, and only when an entry draws it. The count is one
    // document's (a reload discards the module graph, so a visit is what it measures), and the
    // tiles the map asks for are answered here, so no flow reaches a tile server.
    let surfaces = []
    page.on("request", (request) => {
      const found = /\/(chart|map)-surface\.(?:tsx|js|mjs)/.exec(request.url())
      if (found) surfaces.push(found[1])
    })
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) surfaces = []
    })
    await page.route(/arcgisonline\.com/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64",
        ),
      }),
    )

    await page.goto(`${app}/docs/open-ui`)
    await page.getByRole("heading", { name: "Component reference" }).waitFor({ timeout: 20_000 })
    assert.equal(
      await page.getByLabel("Back to Settings").count(),
      1,
      "the screen is one a reader leaves the way they came",
    )

    // Every component the library registers, in the library's own order: the screen's entries
    // checked against the library's membership, which `test-openui-reference.tsx` reads too. An
    // entry the derivation dropped, or a component it lost, shows here.
    const names = (await screen(page)).names
    const library = await page.evaluate(async () => {
      const { library } = await import("/src/components/openui/library.tsx")
      return Object.keys(library.components)
    })
    assert.deepEqual(names, library, "one entry per component the library registers, in its order")
    await shot("top")
    pass(`the screen lists all ${names.length} components in the library's order: ${names.join(", ")}`)

    // Nothing heavy arrives with the screen: the two libraries are still unfetched while the
    // entries that draw them sit below the fold, so a reader who never scrolls never pays for them.
    assert.deepEqual(
      surfaces,
      [],
      `opening the reference fetches neither drawing library (${surfaces.join(", ") || "none"})`,
    )

    const charted = await draw(page, until, "Chart", "with Recharts")
    assert.ok(charted.labels.length >= 3, `its axis is labelled (${charted.labels.join(", ")})`)
    assert.deepEqual(surfaces, ["chart"], "and its library was fetched once, by that entry")
    await shot("chart")

    const mapped = await draw(page, until, "Map", "with Leaflet")
    assert.ok(
      mapped.places.length > 0 && mapped.places.every(Boolean),
      `every place lies inside the map's box (${mapped.places.join(", ")})`,
    )
    assert.equal(mapped.summary, "One place: Berlin.", "the map's own summary is its name")
    assert.deepEqual(surfaces, ["chart", "map"], "the map's library was fetched once, by its entry")
    await shot("map")
    pass("the chart and the map draw their entries, each library fetched once by the entry that draws it")

    // The playground: a pasted block draws, a block the library refuses draws its error in words
    // beside its own source, and nothing is kept.
    const field = page.getByLabel("A block of Lang")
    await field.scrollIntoViewIfNeeded()
    await field.fill(GOOD)
    await page.getByRole("button", { name: "Draw" }).click()
    await until(
      async () => (await page.locator(`${RESULT} tbody tr`).count()) === 2,
      10_000,
      "the pasted block to draw",
    )
    // The drawn table only: the same container also shows the block's source back as code.
    assert.match(
      await page.locator(`${RESULT} table`).innerText(),
      /Trip[\s\S]*City[\s\S]*Days[\s\S]*Berlin[\s\S]*3[\s\S]*Lisbon[\s\S]*5/,
      "the table it asked for, with the rows it gave",
    )
    await shot("paste-drawn")

    await field.fill(BAD)
    await page.getByRole("button", { name: "Draw" }).click()
    await until(
      async () => (await page.locator("[data-reference-error]").count()) === 1,
      10_000,
      "the bad paste to be refused in words",
    )
    const words = (await page.locator("[data-reference-error]").innerText()).trim()
    assert.match(words, /title/, `the error names the prop that is wrong ("${words}")`)
    assert.equal(
      await page.locator(`${RESULT} [data-slot=card], ${RESULT} table`).count(),
      0,
      "no frame is drawn in its place",
    )
    assert.match(
      await page.locator(RESULT).innerText(),
      /card = Card\(unquoted\)/,
      "and its own source is beside the error",
    )
    await shot("paste-refused")
    pass("a bad paste draws its error in words beside its source, and no empty frame")

    await page.reload()
    await page.getByLabel("A block of Lang").waitFor({ timeout: 20_000 })
    assert.equal(await page.getByLabel("A block of Lang").inputValue(), "", "a reload keeps nothing")
    assert.equal(await page.locator(RESULT).count(), 0, "and no drawing of a block it was given")
    pass("the playground is empty again after a reload: nothing pasted is kept")

    // Both widths, both themes: every entry draws, on the reference's own column, the map's basemap
    // following the theme — and the screen that drew them fetched each library once.
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 768 })
      for (const dark of [false, true]) {
        const at = `${width}px in ${dark ? "dark" : "light"}`
        await page.emulateMedia({ colorScheme: dark ? "dark" : "light" })
        await until(
          async () => (await screen(page)).dark === dark,
          10_000,
          `the screen to wear ${dark ? "dark" : "light"} at ${at}`,
        )
        for (const name of names) {
          const seen = await draw(page, until, name)
          assert.ok(
            Math.abs(seen.drawing.left - seen.column.left) <= 1 &&
              Math.abs(seen.drawing.right - seen.column.right) <= 1,
            `${name}'s drawing takes the reference's own column at ${at} (${seen.drawing.left}px to ${seen.drawing.right}px of ${seen.column.left}px to ${seen.column.right}px)`,
          )
          if (name === "Chart")
            assert.ok(seen.chart > 0, `the chart draws at ${at} (${seen.labels.join(", ")})`)
          if (name === "Map") {
            assert.equal(
              basemapOf(seen.tiles),
              dark ? "dark" : "light",
              `its basemap is the theme's at ${at}`,
            )
          }
        }
        assert.equal((await screen(page)).sideways, 0, `the screen doesn't scroll sideways at ${at}`)
        await shot(`reference-${width}-${dark ? "dark" : "light"}`)
        pass(`every entry draws on the reference's own column at ${at}, the map's basemap with it`)
      }
    }

    assert.deepEqual(
      surfaces,
      ["chart", "map"],
      "and the screen these eight looks were made on fetched each library once",
    )
  },
  { viewport: { width: WIDTHS[0], height: 844 } },
)
