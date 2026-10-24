// A bot's skills, as a tab of its own settings at /settings/bots/<botId>/skills: the profile's own
// under *Your skills* and the ones a Hermes plugin provides under *From plugins*, each grouped by
// category with the rows that have none last, every row its name over how it is doing — Ready, Off,
// or Doesn't load with the Host's own reason — and a switch where the Host says it will honour one.
// A switch flipped off leaves the row reading Off and the skill gone from the composer's `/` menu,
// because one list serves them all. Back returns to the bot's General tab. Phone and tablet, light
// and dark. Geometry is why this is a flow: five tabs and two sections of rows at 390px.
import { app, assert, flow, mock, pass } from "./lib.mjs"

const LOAD_ERROR = "Doesn't load: SKILL.md names a tool this Hermes doesn't have: `import_legacy`."
/** The tab's own sections, in the order it draws them: the groups, and each group's rows by name. */
const SECTIONS = {
  yours: {
    groups: ["core", "docs", "github", "ops", "release", "review", ""],
    rows: {
      core: ["identity"],
      docs: ["pinned-notes"],
      github: ["github-pr-workflow"],
      ops: ["legacy-importer", "log-rotation", "log-triage"],
      release: ["hub-audit"],
      review: ["code-review", "code-review-deep"],
      "": ["plan", "weekly-digest"],
    },
  },
  plugins: { groups: ["plugin"], rows: { plugin: ["gots:ship"] } },
}
/** How each row is doing, in the words the tab uses: the Host's reason where it has one. */
const HEALTH = {
  "code-review": "Ready",
  "code-review-deep": "Ready",
  "github-pr-workflow": "Ready",
  "hub-audit": "Ready",
  identity: "Ready",
  "legacy-importer": LOAD_ERROR,
  "log-triage": "Ready",
  "log-rotation": "Ready",
  "pinned-notes": "Ready",
  plan: "Ready",
  "weekly-digest": "Off",
  "gots:ship": "Ready",
}

const run = async ({ page, profileId, shot, until }) => {
  const editor = `/settings/bots/${profileId}`
  const screen = `${editor}/skills`
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const panel = () => page.locator("[data-skills-tab]")
  const groupOf = (section) =>
    panel().locator(`[data-skill-section="${section}"] [data-skill-group]`)
  const rowsOf = (section, group) =>
    panel().locator(`[data-skill-section="${section}"] [data-skill-group="${group}"] [data-skill]`)

  try {
    // The Bot's editor carries the tab, and it opens a screen of its own.
    await page.goto(`${app}${editor}`)
    const tab = page.getByRole("tab", { name: "Skills", exact: true })
    await tab.waitFor({ timeout: 15_000 })
    await shot("tabs")
    await tab.click()
    await page.waitForURL(`**${screen}`, { timeout: 15_000 })
    await page.locator('[data-skill="code-review"]').waitFor({ timeout: 15_000 })

    // The tab is a history entry of its own, so back returns to the Bot's General tab.
    await page.goBack()
    await page.waitForURL(`**${editor}`, { timeout: 15_000 })
    await page.getByRole("button", { name: "Test connection" }).waitFor({ timeout: 15_000 })
    await shot("back")
    await page.getByRole("tab", { name: "Skills", exact: true }).click()
    await page.waitForURL(`**${screen}`, { timeout: 15_000 })
    await page.locator('[data-skill="code-review"]').waitFor({ timeout: 15_000 })

    // Two sections, each under its own heading, each grouped by category in the tab's own order:
    // alphabetical with the rows that have none last, and every group's rows by name.
    assert.equal(await panel().count(), 1, "the tab is drawn")
    for (const [section, title] of [
      ["yours", "Your skills"],
      ["plugins", "From plugins"],
    ]) {
      assert.equal(
        await panel().locator(`[data-skill-section="${section}"]`).count(),
        1,
        `the ${section} section is drawn`,
      )
      assert.equal(
        await panel()
          .locator(`[data-skill-section="${section}"]`)
          .getByRole("heading", { name: title, exact: true })
          .count(),
        1,
        `its heading reads ${title}`,
      )
    }
    for (const [section, wanted] of Object.entries(SECTIONS)) {
      const groups = await groupOf(section).evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-skill-group")),
      )
      assert.deepEqual(groups, wanted.groups, `${section}: the categories in the tab's own order`)
      for (const [group, names] of Object.entries(wanted.rows)) {
        const listed = await rowsOf(section, group).evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-skill")),
        )
        assert.deepEqual(listed, names, `${section}/${group || "no category"}: its rows by name`)
      }
    }
    assert.equal(
      await panel()
        .locator('[data-skill-section="yours"] [data-skill-group=""]')
        .getByRole("heading", { name: "No category", exact: true })
        .count(),
      1,
      "the rows without a category sit under No category",
    )
    assert.equal(
      (await groupOf("yours").last().getAttribute("data-skill-group")) ?? "",
      "",
      "and that group is the last one",
    )

    // Every row says how it is doing under its name, in the Host's own words where it doesn't load.
    for (const [name, health] of Object.entries(HEALTH)) {
      const row = page.locator(`[data-skill="${name}"]`)
      await row.waitFor({ timeout: 10_000 })
      assert.ok(
        await row.getByText(health, { exact: true }).isVisible(),
        `${name} reads as ${health}`,
      )
    }
    await shot("rows")

    // A switch on every row the Host says it will honour, and none on the one it won't: eleven of
    // the twelve rows, since `identity` is essential.
    assert.equal(
      await panel().getByRole("switch").count(),
      11,
      "each switchable skill carries a switch",
    )
    assert.equal(
      await page.locator('[data-skill="identity"] [role="switch"]').count(),
      0,
      "a skill the Host won't switch has none",
    )

    // Flipping one off is one decision: the row reads Off here, and the composer's `/` menu no
    // longer offers it — nor any of the skills that can't run: the one that was already off and
    // the one that doesn't load.
    const plan = page.getByRole("switch", { name: "plan on", exact: true })
    assert.equal(await plan.getAttribute("aria-checked"), "true", "plan starts on")
    await plan.click()
    await until(
      () =>
        page
          .locator('[data-skill="plan"]')
          .getByText("Off", { exact: true })
          .isVisible()
          .then((visible) => visible),
      15_000,
      "the switched-off row to read Off",
    )
    assert.equal(await plan.getAttribute("aria-checked"), "false", "and its switch to read off")
    await shot("switched-off")

    const composer = page.getByLabel("Message")
    const menu = page.getByRole("listbox", { name: "Commands and skills" })
    await page.goto(app)
    await composer.fill("/")
    await menu.waitFor({ timeout: 15_000 })
    const offered = await menu.getByRole("option").allInnerTexts()
    assert.ok(
      offered.some((text) => /\/log-triage\b/.test(text)),
      `the menu opens on the skills that can run (${offered.length} offered)`,
    )
    for (const [name, why] of [
      ["plan", "switched off"],
      ["weekly-digest", "switched off on the host"],
      ["legacy-importer", "doesn't load"],
    ])
      assert.equal(
        await menu.getByRole("option", { name: new RegExp(`/${name}\\b`) }).count(),
        0,
        `a skill ${why} is not offered (${name})`,
      )
    await shot("menu-without-plan")

    // Switched back on, the row reads Ready again: the mock is left as it was found.
    await page.goto(`${app}${screen}`)
    const back = page.getByRole("switch", { name: "plan on", exact: true })
    await back.waitFor({ timeout: 15_000 })
    await until(
      async () => (await back.getAttribute("aria-checked")) === "false",
      15_000,
      "the switched-off row to be read back from the host",
    )
    await back.click()
    await until(
      () =>
        page
          .locator('[data-skill="plan"]')
          .getByText("Ready", { exact: true })
          .isVisible()
          .then((visible) => visible),
      15_000,
      "the row to read Ready again",
    )
    assert.equal(await back.getAttribute("aria-checked"), "true", "and its switch to read on")
    await shot("switched-back")

    assert.deepEqual(errors, [], `no error in the console (${errors.join("; ")})`)
  } finally {
    // The rest of the suite finds the mock's whole list again, switched on and still there.
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
  "the Bot's skills are a tab of its settings: two sections under their headings, categories alphabetical with No category last, every row a name over its health — Ready, Off, or the Host's reason — a switch on each the Host will honour and none on the one it won't, one flipped off reading Off and leaving the composer's `/` menu with it, back to General, at 390 and 1024px, light and dark",
)
