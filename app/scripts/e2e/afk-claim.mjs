// AFK's claim: turning a project on has the host claim its oldest ready task — assigned to the
// account and marked — so the pop-up says what it is working and the frontier no longer offers it.
// A project that may hold several tasks holds one per place: raising its pick count fills them, the
// Working block names every task it holds over a count of them against the pick count, and a reload
// reads every count back. A GitHub refusal leaves the switch on and shows its
// reason in the same pop-up. The bot's pick budget is written on the wire and drawn by its own
// Coding page, which this flow reads back. The read is the plugin's own route, so the whole thing is
// covered against the mock. Phone, tablet and laptop, light and dark, with no console error.
import { afkOn, afkRead, app, assert, flow, makeProject, mock, openAfk, pass, say } from "./lib.mjs"

const HELD = 265
const HELD_TITLE = "The frontier is read from GitHub and listed"
/** The task that was second in the frontier: the second place the sweep fills. */
const SECOND = 266
const SECOND_TITLE = "The switch: AFK is a project's own setting on the host"
/** The task the repository opens once a project is set to hold three. */
const THIRD = 269
const THIRD_TITLE = "A hold is a row, not a column on the project"
const REFUSAL = "Couldn't reach GitHub from the server."
/** What a bot that never set one works within. */
const BUDGET = 5

const botAfk = () => fetch(`${mock}/api/plugins/memento/afk`).then((response) => response.json())

const writeBudget = async (pick_budget) =>
  (
    await fetch(`${mock}/api/plugins/memento/afk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pick_budget }),
    })
  ).json()

const run = async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })

  // The bot's own row, which the sheet's budget line is drawn from: a bot starts within five, a
  // write of its budget is read back, and putting it back is the same write.
  await writeBudget(BUDGET)
  const bot = await botAfk()
  assert.equal(bot.object, "memento.afk.bot", "the bot-level route answers its own object")
  assert.equal(bot.pick_budget, BUDGET, "a bot that never set a budget works within five")
  const smaller = await writeBudget(4)
  assert.equal(smaller.pick_budget, 4, "the bot's budget is the number it was written")
  assert.equal((await botAfk()).pick_budget, 4, "and the next read answers it")
  await writeBudget(BUDGET)

  // The page the budget belongs to: the bot's own Coding page draws the same number the wire
  // answers, so the screen and the route can't drift apart.
  await page.goto(`${app}/settings/bots/${profileId}/coding`)
  const budget = page.locator("[data-pick-budget]")
  await budget.waitFor({ timeout: 15_000 })
  assert.equal(
    await budget.getAttribute("data-pick-budget"),
    String(BUDGET),
    "the Coding page reads the bot's budget back",
  )
  await shot("coding-tab")

  const projectId = await makeProject(until, "AFK claim")
  const screen = `${app}/projects/${profileId}/${projectId}`

  // Turning it on is the host's; the task its sweep claims lands on the next read of the sheet.
  const control = await afkOn(page, screen, until)
  const working = page.locator("[data-working]")
  await working.waitFor({ timeout: 15_000 })
  assert.ok(
    await working
      .locator(`[data-task="${HELD}"]`)
      .getByText(HELD_TITLE, { exact: true })
      .isVisible(),
    "the pop-up names the task AFK is holding",
  )
  // One place, one task: the count row says how many of them are held, against the count of one a
  // project starts with.
  const count = working.locator("[data-holds]")
  await count.waitFor({ timeout: 15_000 })
  assert.equal(await count.getAttribute("data-holds"), "1", "the count row counts the one hold")
  assert.equal(
    await count.getAttribute("data-pick-count"),
    "1",
    "against the count of one it holds by",
  )
  assert.equal((await count.innerText()).trim(), "1 of 1 held", "and reads them as words")
  await shot("working")

  // The pick count sits under the switch as one pill per count, the count it holds already on.
  const picks = page.locator("[data-afk-picks]")
  await picks.waitFor({ timeout: 15_000 })
  assert.equal(await picks.getAttribute("data-pick-count"), "1", "the row says the count it holds")
  assert.equal(await picks.getByRole("radio").count(), 5, "one to five, a pill each")
  assert.equal(
    await picks.getByRole("radio", { name: "1" }).getAttribute("aria-checked"),
    "true",
    "with the count the project holds already on",
  )
  await shot("pick-count")

  // Raising it is one write of the host's, and the places it opens are the sweep's to fill: the
  // next read names every task it holds, oldest first, and counts them against the new count.
  await picks.getByRole("radio", { name: "3" }).click()
  await until(
    async () => (await count.getAttribute("data-holds")) === "3",
    20_000,
    "the sheet to read the tasks it holds now",
  )
  assert.equal(
    await picks.getByRole("radio", { name: "3" }).getAttribute("aria-checked"),
    "true",
    "the pills read the count they wrote",
  )
  const numbers = await working
    .locator("a[data-task]")
    .evaluateAll((links) => links.map((link) => Number(link.dataset.task)))
  assert.deepEqual(numbers, [HELD, SECOND, THIRD], `one row per hold, oldest first (${numbers})`)
  for (const [number, title] of [
    [HELD, HELD_TITLE],
    [SECOND, SECOND_TITLE],
    [THIRD, THIRD_TITLE],
  ]) {
    assert.ok(
      await page.locator(`[data-hold="${number}"]`).getByText(title, { exact: true }).isVisible(),
      `the pop-up names #${number}`,
    )
  }
  assert.equal(
    (await count.innerText()).trim(),
    "3 of 3 held",
    "three holds against a count of three",
  )
  await shot("three-holds")

  // What the pills wrote is the host's own number, and the host holds a task per place.
  const held = await afkRead(projectId)
  assert.equal(held.pick_count, 3, "the count the pills wrote is the host's")
  assert.deepEqual(
    held.holds.map((hold) => hold.number),
    [HELD, SECOND, THIRD],
    "and the host answers one hold per place, oldest first",
  )
  assert.equal(held.task.number, HELD, "the oldest hold is still the one a shipped app draws")

  // The stage belongs to the session working a hold: the oldest one is staged — the mock's dev
  // handle moves the record it holds, as `afk-stage.mjs` does — and the tasks behind it have no
  // session of their own to name one. With no workflow to name the stage, the row says the app's
  // own word for it.
  await say({ project_id: projectId, stage: "build" })
  const oldest = page.locator(`[data-hold="${HELD}"]`)
  await until(
    async () => (await oldest.getAttribute("data-stage")) === "build",
    20_000,
    "the oldest hold to read its stage",
  )
  assert.match(
    await oldest.locator("a[data-task]").textContent(),
    /^#265Building: /,
    "the staged hold's row prefixes its title with the stage",
  )
  assert.equal(
    await page.locator(`[data-hold="${SECOND}"]`).getAttribute("data-stage"),
    null,
    "a hold with no session of its own names no stage",
  )
  await shot("staged")

  // A claimed task leaves the frontier — every one of them — and is listed as claimed. The tasks the
  // sweep hasn't reached are still offered: a project holding three of five leaves two ready.
  await until(
    async () => (await page.locator('[data-group="claimed"] [data-task="269"]').count()) === 1,
    15_000,
    "the frontier to list the third task as claimed",
  )
  assert.deepEqual(
    await page
      .locator('[data-group="ready"] [data-task]')
      .evaluateAll((links) => links.map((link) => Number(link.dataset.task))),
    [270, 271],
    "nothing AFK holds is offered as ready, and what it doesn't hold still is",
  )
  for (const number of [HELD, SECOND, THIRD]) {
    assert.equal(
      await page.locator(`[data-group="claimed"] [data-task="${number}"]`).count(),
      1,
      `#${number} is listed as claimed`,
    )
  }
  await shot("frontier")

  // The claim is the host's, so a reload reads every task and the count back rather than an empty
  // sheet.
  await openAfk(page, screen)
  await control.waitFor({ timeout: 15_000 })
  assert.equal(await control.getAttribute("aria-checked"), "true", "a reload reads the switch on")
  await page.locator(`[data-hold="${THIRD}"]`).waitFor({ timeout: 15_000 })
  assert.equal(await page.locator("[data-hold]").count(), 3, "and reads back every task it holds")
  assert.equal(
    await page
      .locator("[data-afk-picks]")
      .getByRole("radio", { name: "3" })
      .getAttribute("aria-checked"),
    "true",
    "with the pick count it was set to",
  )
  // The budget line is cut from the sheet: the bot's own numbers stay on the wire for whatever reads
  // them next, while the sheet draws the pick count and its count row alone.
  const answered = await afkRead(projectId)
  assert.ok(
    answered.holds_held >= 3,
    `the bot's holds are still counted on the wire (${answered.holds_held})`,
  )
  assert.equal(await page.locator("[data-afk-budget]").count(), 0, "no budget line in the sheet")
  await shot("reloaded")

  // GitHub refusing leaves the switch on and its reason in the pop-up; nothing turns itself off.
  await page.route("**/api/plugins/memento/projects/*/afk", (route) => {
    if (route.request().method() !== "GET") return route.continue()
    return route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({
        object: "memento.afk",
        on: true,
        reason: null,
        task: null,
        refusal: REFUSAL,
      }),
    })
  })
  await openAfk(page, screen)
  const refused = page.locator("[data-refusal]")
  await refused.waitFor({ timeout: 15_000 })
  assert.equal(await refused.textContent(), REFUSAL, "the refusal is its own line under the switch")
  assert.equal(
    await control.getAttribute("aria-checked"),
    "true",
    "a refusal leaves the project left to work",
  )
  assert.equal(await page.locator("[data-working]").count(), 0, "and holds no task to name")
  await shot("refused")
  await page.unroute("**/api/plugins/memento/projects/*/afk")

  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

for (const width of [390, 768, 1024]) {
  for (const dark of [false, true]) {
    const look = `${width}${dark ? "-dark" : ""}`
    await flow(`afk-claim-${look}`, run, {
      viewport: { width, height: width < 768 ? 844 : 768 },
      dark,
    })
  }
}
pass(
  "AFK claims the oldest ready task when a project is turned on — and filling its pick count to three makes the pop-up name every task it holds, oldest first and each with the stage of the session working it, over a count row — with the frontier dropping every task it took and still offering the rest, and a reload reading them back, and a GitHub refusal leaving the switch on with its reason shown, at 390, 768 and 1024px, light and dark",
)
