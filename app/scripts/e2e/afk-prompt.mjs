// AFK's Prompt: with the workflow library off, a project's pop-up draws the Prompt its runs are
// told — the host's default method where the project wrote none — and opens one writing sheet for
// it, Done writing it back to the host, which the next read answers. Geometry is why this is a flow:
// the row's place in the switch's list, the sheet's height and the drawer's edge — none of which a
// DOM without layout can measure.
import { app, assert, flow, makeProject, openAfk, pass } from "./lib.mjs"

const DEFAULT_PROMPT = "Work in checkpoints: small slices of the issue, one at a time."
const MINE = "# Mine\n\n- Read the issue first.\n- Run the repo's own gates."
/** The width the app's pop-ups become side drawers at, which the editor takes from the same rule. */
const LAPTOP = 1024

const run = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const screen = `${app}/projects/${profileId}/${await makeProject(until, "AFK Prompt")}`

  // The shared opener, then the sheet's slide-in let alone: a box read mid-animation is a moving
  // target, and every measurement here is a box.
  const openPrompt = async () => {
    await openAfk(page, screen)
    const row = page.locator("[data-afk-prompt]")
    await row.waitFor({ timeout: 15_000 })
    await page.waitForTimeout(450)
    return row
  }

  const row = await openPrompt()
  assert.match(await row.innerText(), /Work in checkpoints/, "the row reads the host's default Prompt")
  assert.equal(await page.locator("[data-afk-workflow]").count(), 0, "no Workflow row with it off")
  assert.equal(
    await page.locator("[data-afk-skills]").count(),
    0,
    "and no Build and Critique pickers: a Prompt names its own skills",
  )
  // A row of the switch's own list, with the switch's own padding above it and none of its own.
  const switchBox = await page.locator("[data-afk-switch]").boundingBox()
  const promptBox = await row.boundingBox()
  assert.ok(switchBox && promptBox, "both rows have a box")
  const gap = Math.round(promptBox.y - (switchBox.y + switchBox.height))
  assert.ok(
    gap >= 0 && gap <= 1,
    `the Prompt row touches the switch's row, with no band between (${gap}px)`,
  )
  await shot("row")

  await page.locator('button[aria-label="Prompt"]').click()
  const field = page.locator('textarea[aria-label="Prompt"]')
  await field.waitFor({ timeout: 15_000 })
  assert.equal(await field.inputValue(), DEFAULT_PROMPT, "the field holds the host's words")
  assert.equal(
    await page.getByRole("button", { name: "Preview" }).count(),
    0,
    "there is nothing to preview: the Prompt is written",
  )

  // A bottom sheet below a laptop's width, the side drawer from it, and either way room to write.
  const editor = page.getByRole("dialog").last()
  await page.waitForTimeout(450)
  const box = await editor.boundingBox()
  const viewport = page.viewportSize()
  assert.ok(box && viewport, "the editor has a box on screen")
  const width = Math.round(box.width)
  const height = Math.round(box.height)
  if (viewport.width < LAPTOP) {
    assert.equal(
      Math.round(box.y + box.height),
      viewport.height,
      "a sheet on the screen's bottom edge",
    )
    assert.ok(height < viewport.height, `a sheet, not the whole screen (${height}px)`)
    assert.equal(
      Math.round(box.x),
      Math.round((viewport.width - width) / 2),
      "centred as every sheet is",
    )
    assert.ok(width <= 640 && width > viewport.width * 0.4, `a sheet's width (${width}px)`)
  } else {
    assert.equal(height, viewport.height, "the side drawer takes the height")
    assert.equal(
      Math.round(box.x + box.width),
      viewport.width,
      "and from a laptop's width, flush right",
    )
    assert.ok(width < viewport.width, `a drawer leaves the project beside it (${width}px)`)
  }
  const fieldBox = await field.boundingBox()
  assert.ok(fieldBox, "the field has a box")
  assert.ok(
    fieldBox.height >= 240,
    `the field opens with room to write (${Math.round(fieldBox.height)}px)`,
  )
  assert.ok(box.height - fieldBox.height >= 44, "and the header and Done sit outside it")
  await shot("editor")

  await field.fill(MINE)
  await page.getByRole("button", { name: "Done" }).click()
  await field.waitFor({ state: "detached", timeout: 15_000 })
  await until(
    async () =>
      (await page.locator("[data-afk-prompt]").innerText()).includes("Read the issue first"),
    15_000,
    "the row to read the Prompt the host took",
  )
  await shot("saved")

  const again = await openPrompt()
  assert.match(
    await again.innerText(),
    /Read the issue first/,
    "a reload reads the Prompt the host kept",
  )

  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

for (const width of [390, 768, LAPTOP]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`afk-prompt-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "a project's pop-up draws the Prompt its runs are told — the host's default included, with none of the workflow's skill pickers — and opens one writing surface for it in a bottom sheet, the side drawer from a laptop's width, Done writing it back: at 390, 768 and 1024px, light and dark",
)
