// A skill can be taken away from its own sheet, where its origin has a removal behind it: a Hub
// skill's uninstall or one written on the profile's delete. A built-in and a plugin's skill offer
// none, since Hermes has no removal for either. Remove asks for confirmation first — a cancel sends
// nothing and leaves the skill where it was — and a confirmed one takes the row away with the tab
// showing what is left, because the Host's remaining list replaces the whole one. A removal the Host
// refuses is its own sentence, with the row still there. Phone and tablet, light and dark.
import { app, assert, flow, mock, pass } from "./lib.mjs"

const REFUSAL =
  "Skill 'pinned-notes' is pinned and cannot be deleted by skill_manage. Ask the user to run " +
  "`hermes curator unpin pinned-notes` if they want to delete it."

const run = async ({ page, profileId, shot, until }) => {
  const screen = `/settings/bots/${profileId}/skills`
  const removals = []
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (request.method() === "DELETE" && path.includes("/plugins/memento/skills/"))
      removals.push(decodeURIComponent(path.split("/").pop()))
  })
  const row = (name) => page.locator(`[data-skill="${name}"]`)
  const sheet = () => page.locator("[data-skill-sheet]")
  const open = async (name) => {
    await row(name).locator("button").first().click()
    await page.locator(`[data-skill-sheet="${name}"]`).waitFor({ timeout: 15_000 })
  }
  const close = async () => {
    await page.keyboard.press("Escape")
    await sheet().waitFor({ state: "hidden", timeout: 15_000 })
  }
  const remove = () => page.getByRole("button", { name: "Remove", exact: true })

  try {
    await page.goto(`${app}${screen}`)
    await row("hub-audit").waitFor({ timeout: 15_000 })
    const listed = await page.locator("[data-skills-tab] [data-skill]").count()

    // A built-in and a plugin's skill have no removal: their own packages and Hermes own them.
    for (const name of ["identity", "gots:ship"]) {
      await open(name)
      assert.equal(await remove().count(), 0, `${name} offers no removal`)
      await close()
    }

    // A Hub skill's sheet offers one, and the confirmation asks first: a cancel sends nothing and
    // leaves the skill, with its sheet back where it was.
    await open("hub-audit")
    assert.equal(await remove().count(), 1, "a Hub skill's sheet offers a removal")
    await shot("offered")
    await remove().click()
    const dialog = page.getByRole("alertdialog")
    await dialog.getByText("Remove hub-audit?", { exact: true }).waitFor({ timeout: 15_000 })
    await shot("confirm")
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await dialog.waitFor({ state: "hidden", timeout: 15_000 })
    assert.deepEqual(removals, [], "a cancelled removal sends nothing to the bot")
    assert.ok(await sheet().isVisible(), "the skill's sheet comes back")
    assert.ok(await row("hub-audit").isVisible(), "the skill a cancel was asked about is still there")

    // Confirming takes it away, and the tab shows what is left: the Host's own answer, not a row
    // the app crossed out.
    await remove().click()
    await dialog.getByText("Remove hub-audit?", { exact: true }).waitFor({ timeout: 15_000 })
    await dialog.getByRole("button", { name: "Remove", exact: true }).click()
    await until(() => row("hub-audit").count().then((count) => count === 0), 15_000, "the row to go")
    assert.deepEqual(removals, ["hub-audit"], "the removal named the skill on the plugin's route")
    assert.equal(
      await page.locator("[data-skills-tab] [data-skill]").count(),
      listed - 1,
      "the tab shows what is left",
    )
    assert.equal(await sheet().count(), 0, "the sheet went with the skill")
    await shot("removed")

    // A removal the Host refuses is its own sentence in a toast, with the row exactly as it was.
    await open("pinned-notes")
    assert.equal(await remove().count(), 1, "a skill written on the profile offers a removal")
    await remove().click()
    await dialog.getByText("Remove pinned-notes?", { exact: true }).waitFor({ timeout: 15_000 })
    await dialog.getByRole("button", { name: "Remove", exact: true }).click()
    const toast = page.locator("[data-sonner-toast]").getByText(REFUSAL, { exact: true })
    await toast.waitFor({ timeout: 15_000 })
    await dialog.waitFor({ state: "hidden", timeout: 15_000 })
    await shot("refused")
    assert.ok(await sheet().isVisible(), "the skill's sheet is back under the refusal")
    assert.ok(await row("pinned-notes").isVisible(), "the refused skill is still listed")
    assert.equal(
      await page.locator("[data-skills-tab] [data-skill]").count(),
      listed - 1,
      "and nothing else left with it",
    )
    assert.equal(
      await row("pinned-notes").getByText("Ready", { exact: true }).count(),
      1,
      "its row is as it was",
    )

    // The filters below are the browser's own logging of the refused request, not the app's error.
    assert.deepEqual(
      errors.filter((text) => !/Failed to load resource|CORS policy/.test(text)),
      [],
      `no error in the console (${errors.join("; ")})`,
    )
  } finally {
    // The rest of the suite finds the mock's whole list again.
    await fetch(`${mock}/__mock/skills`, { method: "POST" })
  }
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`skills-remove-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "a removal lives on the sheet of a Hub skill and of one written on the profile, and on neither a built-in's nor a plugin's, asks first with a cancel sending nothing, and takes the row away with the tab showing what is left — while a removal the Host refuses is its own sentence with the row still there — at 390 and 1024px, light and dark",
)
