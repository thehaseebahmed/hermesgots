import { app, assert, flow, pass, settled } from "./lib.mjs"

const LAPTOP = 1024
const CHECKLIST = "references/review-checklist.md"
const SETUP = "Run `gots setup hub` once to install the Hub's CLI."

const run = async ({ page, profileId, shot }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const screen = `/settings/bots/${profileId}/skills`
  const sheet = () => page.locator("[data-skill-sheet]")
  const open = async (name) => {
    await page.locator(`[data-skill="${name}"] button`).first().click()
    await page.locator(`[data-skill-sheet="${name}"]`).waitFor({ timeout: 15_000 })
    await settled(page)
  }
  const close = async () => {
    await page.keyboard.press("Escape")
    await sheet().waitFor({ state: "hidden", timeout: 15_000 })
  }

  await page.goto(`${app}${screen}`)
  await page.locator('[data-skill="github-pr-workflow"]').waitFor({ timeout: 15_000 })

  await open("github-pr-workflow")
  const box = await page.getByRole("dialog").last().boundingBox()
  const viewport = page.viewportSize()
  assert.ok(box && viewport, "the sheet has a box on screen")
  const width = Math.round(box.width)
  const height = Math.round(box.height)
  assert.ok(box.x >= -1 && box.x + box.width <= viewport.width + 1, "the sheet is on screen")
  if (viewport.width < LAPTOP) {
    assert.equal(
      Math.round(box.y + box.height),
      viewport.height,
      "a sheet on the screen's bottom edge",
    )
    assert.equal(
      Math.round(box.x),
      Math.round((viewport.width - width) / 2),
      "centred as every sheet is",
    )
    assert.ok(width <= 640, `a sheet's width (${width}px)`)
    assert.ok(
      height <= Math.round(viewport.height * 0.85) + 1,
      `and no taller than the screen allows (${height}px)`,
    )
  } else {
    assert.equal(height, viewport.height, "the side drawer takes the height")
    assert.equal(
      Math.round(box.x + box.width),
      viewport.width,
      "and from a laptop's width, flush right",
    )
    assert.ok(width >= 412 && width <= 549, `a drawer's width (${width}px)`)
  }

  assert.equal(
    (await page.locator("[data-skill-origin]").innerText()).trim(),
    "Built in",
    "the properties block opens with where the skill came from",
  )
  assert.equal(
    (await page.locator('[data-skill-setup="readiness"]').innerText()).trim(),
    "available",
    "the readiness row is the Host's own status word",
  )
  assert.equal(
    await page.locator('[data-skill-setup="setup"]').count(),
    0,
    "and a skill with no setup sentence has no setup row",
  )

  const prose = page.locator("[data-skill-sheet] [data-slot='markdown']")
  await prose.waitFor({ timeout: 15_000 })
  await page.locator("[data-skill-properties]").waitFor({ timeout: 15_000 })
  assert.equal(
    await page.locator("[data-skill-properties]").count(),
    1,
    "the properties block is one block on screen",
  )
  await page
    .getByRole("heading", { name: "Pull requests", exact: true })
    .waitFor({ timeout: 15_000 })
  await shot("sheet")

  await page.locator('[data-skill-files="references"]').waitFor({ timeout: 15_000 })
  assert.equal(
    await page.locator('[data-skill-files="scripts"]').count(),
    1,
    "both of the skill's groups are listed",
  )
  await page.locator('[data-skill-files="references"] button').first().click()
  const file = page.locator(`[data-skill-file="${CHECKLIST}"]`)
  await file.waitFor({ timeout: 15_000 })
  await page
    .getByRole("heading", { name: "Review checklist", exact: true })
    .waitFor({ timeout: 15_000 })
  assert.match(
    await file.innerText(),
    /The gates pass, and the diff is the change\./,
    "a linked markdown file reads as prose too",
  )
  assert.equal(await sheet().count(), 0, "the skill's page is the file's, not both at once")
  await shot("file")
  await page.getByRole("button", { name: "Back to the skill" }).click()
  await file.waitFor({ state: "hidden", timeout: 15_000 })
  await page
    .getByRole("heading", { name: "Pull requests", exact: true })
    .waitFor({ timeout: 15_000 })
  assert.equal(
    await page.locator("[data-skill-properties]").count(),
    1,
    "back returns to the skill's own page, its block and all",
  )
  await page.locator('[data-skill-files="scripts"] button').first().click()
  const script = page.locator('[data-skill-file="scripts/open-pr.sh"]')
  await script.waitFor({ timeout: 15_000 })
  assert.match(
    await script.getByLabel("scripts/open-pr.sh", { exact: true }).innerText(),
    /gh pr create --draft --fill/,
    "a file that is not markdown stays the code it is",
  )
  await page.getByRole("button", { name: "Back to the skill" }).click()
  await script.waitFor({ state: "hidden", timeout: 15_000 })
  await shot("back-to-skill")
  await close()

  await open("log-rotation")
  assert.equal(
    (await page.locator("[data-skill-origin]").innerText()).trim(),
    "Installed from the Hub",
    "a Hub skill's block says where it came from",
  )
  assert.equal(
    (await page.locator('[data-skill-setup="readiness"]').innerText()).trim(),
    "setup_needed",
    "the host's readiness keeps its own row, even when it also has a setup sentence",
  )
  assert.equal(
    (await page.locator('[data-skill-setup="setup"]').innerText()).trim(),
    SETUP,
    "the setup row is the Host's own sentence, under the readiness",
  )
  assert.equal(
    await page.locator("[data-skill-files]").count(),
    0,
    "a skill with no files lists none",
  )
  await shot("hub")
  await close()

  await open("gots:ship")
  assert.equal(
    (await page.locator("[data-skill-origin]").innerText()).trim(),
    "From a plugin",
    "a plugin's skill says where it came from",
  )
  assert.equal(
    await page.getByRole("button", { name: "Remove", exact: true }).count(),
    0,
    "and offers no removal: its package owns it",
  )
  await close()
  await open("weekly-digest")
  assert.equal(
    (await page.locator("[data-skill-origin]").innerText()).trim(),
    "Yours",
    "a skill written on the profile says so",
  )
  assert.equal(
    await page.locator("[data-skill-properties] [data-skill-prop]").count(),
    1,
    "a skill with no frontmatter has its origin row and nothing invented beside it",
  )
  await page
    .locator("[data-skill-sheet] [data-slot='markdown']")
    .getByRole("heading", { name: "weekly-digest", exact: true })
    .waitFor({ timeout: 15_000 })
  await shot("switched-off")
  await close()

  assert.deepEqual(errors, [], `no error in the console (${errors.join("; ")})`)
}

for (const width of [390, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`skills-sheet-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "a skill's own sheet opens from its row as a note: a properties block of the Host's origin, readiness and setup beside the SKILL.md's own frontmatter, then the file's words drawn as prose, with its linked files — a markdown one opening into the same sheet and read the same way, the header's back returning to the skill — as a bottom sheet on a phone and the side drawer from 1024px, for a built-in, a Hub skill, a plugin's and one switched off, at 390 and 1024px, light and dark",
)
