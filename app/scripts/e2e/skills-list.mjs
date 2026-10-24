// The Skills tab's geometry: the tab and its own screen at a phone's and a tablet's width, light and
// dark — the tab's strip holding the Skills tab, two sections under boxes of their own, and a row per
// skill whose name is drawn inside the row's box. Which sections, groups and rows a list draws, and
// what a switch writes, is `test-skills-tab.tsx`'s (and `scripts/test-skills-tab.mjs`'s); what only a
// laid-out page proves is where the boxes fall at the widths the spec names.
import { app, assert, flow, mock, pass, settled } from "./lib.mjs"

const SECTIONS = [
  ["yours", "Your skills"],
  ["plugins", "From plugins"],
]
/** A row from each section, with names short and long enough to test what a row's box holds. */
const ROWS = ["code-review", "github-pr-workflow", "pinned-notes", "gots:ship"]

const run = async ({ page, profileId, shot }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/skills`
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const panel = () => page.locator("[data-skills-tab]")
  const onScreen = (box, viewport, what) => {
    assert.ok(box, `${what} has a box`)
    assert.ok(box.width > 0 && box.height > 0, `${what} is drawn, not collapsed`)
    assert.ok(
      box.x >= -1 && box.x + box.width <= viewport.width + 1,
      `${what} is on screen at ${viewport.width}px (${Math.round(box.x)}…${Math.round(box.x + box.width)})`,
    )
  }

  try {
    // The editor's own screen first: the tab that opens the panel, at this width.
    await page.goto(`${app}${editor}`)
    const tab = page.getByRole("tab", { name: "Skills", exact: true })
    await tab.waitFor({ timeout: 15_000 })
    await settled(page)
    const viewport = page.viewportSize()
    assert.ok(viewport, "the page has a viewport")
    onScreen(await tab.boundingBox(), viewport, "the Skills tab")
    await shot("tab")

    await tab.click()
    await page.waitForURL(`**${screen}`, { timeout: 15_000 })
    await page.locator('[data-skill="code-review"]').waitFor({ timeout: 15_000 })
    await settled(page)
    assert.equal(await panel().count(), 1, "the tab is what the address opened")

    // Each section's heading, in the order the sections sit, each with a box of its own.
    const headings = []
    for (const [id, title] of SECTIONS) {
      const heading = panel()
        .locator(`[data-skill-section="${id}"]`)
        .getByRole("heading", { name: title, exact: true })
      await heading.scrollIntoViewIfNeeded()
      await settled(page)
      const box = await heading.boundingBox()
      onScreen(box, viewport, `${title}'s heading`)
      headings.push(box)
    }
    assert.ok(headings[0].y < headings[1].y, "Your skills sits above From plugins")
    await shot("headings")

    // Every category title has a box of its own, in the order its group sits.
    const titles = panel().locator("[data-skill-group] > h3")
    const count = await titles.count()
    assert.ok(count > 0, "the categories title their groups")
    for (let i = 0; i < count; i++) {
      const title = titles.nth(i)
      await title.scrollIntoViewIfNeeded()
      await settled(page)
      const box = await title.boundingBox()
      onScreen(box, viewport, `category title ${i + 1}`)
    }

    // A row per skill, each with its name drawn inside the row's own box.
    for (const name of ROWS) {
      const row = page.locator(`[data-skill="${name}"]`)
      await row.scrollIntoViewIfNeeded()
      await settled(page)
      const box = await row.boundingBox()
      onScreen(box, viewport, `${name}'s row`)
      const label = await row.getByText(name, { exact: true }).first().boundingBox()
      assert.ok(label, `${name} is named on its row`)
      assert.ok(
        label.width > 0 && label.height > 0,
        `${name} is drawn at ${viewport.width}px, not truncated away`,
      )
      assert.ok(
        label.x >= box.x - 1 && label.x + label.width <= box.x + box.width + 1,
        `${name}'s name sits inside its row's width`,
      )
      assert.ok(
        label.y >= box.y - 1 && label.y + label.height <= box.y + box.height + 1,
        `${name}'s name sits inside its row's height`,
      )
    }
    await shot("rows")

    assert.deepEqual(errors, [], `no error in the console (${errors.join("; ")})`)
  } finally {
    await fetch(`${mock}/__mock/skills`, { method: "POST" })
  }
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`skills-list-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "the Bot's Skills tab is reached from its editor's own tab strip and draws both sections under heading boxes of their own, Your skills above From plugins, every category title with a box of its own, and a row per skill whose name is drawn inside the row's box — the tab, the headings, the categories and the rows on screen at 390 and 1024px, light and dark",
)
