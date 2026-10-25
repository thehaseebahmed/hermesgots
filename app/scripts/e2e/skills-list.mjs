// The Skills page's geometry: the page its bot's list opens, drawn on a screen of its own at a
// phone's and a tablet's width, light and dark — the list's Skills row, two sections each under its
// own muted caption (a <p>, never a heading: a card's groups are named, not headed), and a card per
// category whose first row is the category's title over its "N of M on" line, with a row per skill
// under it. Which sections, categories and rows a list
// draws, what a switch writes and what a category's header flips are `test-skills-tab.tsx`'s (and
// `scripts/test-skills-tab.mjs`'s); what only a laid-out page proves is where the boxes fall at the
// widths the spec names.
import { app, assert, flow, mock, pass, settled } from "./lib.mjs"

const SECTIONS = [
  ["yours", "Your skills"],
  ["plugins", "From plugins"],
]
/** A row from each section, with names short and long enough to test what a row's box holds. */
const ROWS = ["code-review", "github-pr-workflow", "pinned-notes", "gots:ship"]

const run = async ({ page, profileId, shot }) => {
  const list = `/settings/bots/${profileId}`
  const screen = `${list}/skills`
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
    await page.goto(`${app}${list}`)
    const door = page.locator('[data-bot-page="skills"]')
    await door.waitFor({ timeout: 15_000 })
    await settled(page)
    const viewport = page.viewportSize()
    assert.ok(viewport, "the page has a viewport")
    onScreen(await door.boundingBox(), viewport, "the Skills row of the bot's list")
    await shot("list")

    await door.click()
    await page.waitForURL(`**${screen}`, { timeout: 15_000 })
    await page.locator('[data-skill="code-review"]').waitFor({ timeout: 15_000 })
    await settled(page)
    assert.equal(await panel().count(), 1, "the list's row is what the address opened")

    const captions = []
    for (const [id, title] of SECTIONS) {
      const caption = panel().locator(`[data-skill-section="${id}"] > p`)
      await caption.scrollIntoViewIfNeeded()
      await settled(page)
      assert.equal((await caption.innerText()).trim(), title, `${title} names its own section`)
      assert.equal(
        await caption.evaluate((node) => node.tagName),
        "P",
        `${title} is a caption, not a heading`,
      )
      const box = await caption.boundingBox()
      onScreen(box, viewport, `${title}'s caption`)
      captions.push(box)
    }
    assert.ok(captions[0].y < captions[1].y, "Your skills sits above From plugins")
    await shot("captions")

    const categories = panel().locator("[data-skill-group]")
    const count = await categories.count()
    assert.ok(count > 0, "the categories head their groups")
    for (let i = 0; i < count; i++) {
      const group = categories.nth(i)
      const header = group.locator("[data-skill-category]").first()
      await header.scrollIntoViewIfNeeded()
      await settled(page)
      const box = await header.boundingBox()
      onScreen(box, viewport, `category ${i + 1}'s title row`)

      const title = await header.getAttribute("data-skill-category")
      assert.ok(title && title.length > 0, `category ${i + 1} is titled`)
      const rows = await group.locator("[data-skill]").count()
      const words = (await header.textContent()) ?? ""
      assert.ok(words.includes(title), `${title} names its own row`)
      if (rows > 1) {
        assert.ok(
          words.includes(`of ${rows} on`),
          `${title} counts the ${rows} skills it holds (${words})`,
        )
      } else {
        assert.doesNotMatch(words, / of \d+ on/, `${title} carries no count over one skill`)
      }

      const first = await group.locator("[data-skill]").first().boundingBox()
      assert.ok(first, `${title}'s first skill has a box`)
      assert.ok(
        first.y >= box.y + box.height - 1,
        `${title}'s title row sits over its skills (${Math.round(box.y + box.height)}…${Math.round(first.y)})`,
      )
    }

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
  "the Bot's Skills page is reached from its settings list's own Skills row and draws both sections under muted captions of their own, Your skills above From plugins, every category titled by the first row of its own card over its N of M on line with the skill rows under it, and a row per skill whose name is drawn inside the row's box — the list's row, the captions, the categories and the rows on screen at 390 and 1024px, light and dark",
)
