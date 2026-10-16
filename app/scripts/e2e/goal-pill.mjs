// A goal that's set keeps a pill above the composer, its own sheet behind it, and — paused, or
// judged blocked — a card that waits on the user. Pausing posts the control route, which answers
// nothing to send; resuming answers the kick text the app then sends, so the goal moves again now.
import { app, assert, flow, pass, setUpBot } from "./lib.mjs"

const chatId = "goal-pill"

await flow("goal-pill", async ({ page, seed, shot, until }) => {
  await setUpBot(page)
  await seed([{ id: chatId, title: "Goal" }])

  // What the app posts to the control route: pause and resume, never a message of its own.
  const controls = []
  await page.route("**/sessions/*/goal/control", async (route) => {
    controls.push(JSON.parse(route.request().postData() ?? "{}").action)
    await route.continue()
  })

  await page.goto(`${app}/c/${chatId}`)
  const composer = page.getByRole("textbox").last()
  await composer.fill("/goal make the maze's timer survive a page reload")
  await composer.press("Enter")
  await page.getByLabel("Done when").fill("reloading mid-run keeps the clock")
  await page.getByLabel("Prove it with").fill("pnpm test")
  await page.getByLabel("A gate command").fill("pnpm lint")
  await page.getByRole("button", { name: "Add" }).click()
  await page.getByRole("button", { name: "Start the goal" }).click()

  // The pill: the chat's goal, with the turns it has spent, in the row above the composer.
  const pill = page.getByRole("button", { name: /0 of 20 turns/ })
  await pill.waitFor({ timeout: 20_000 })
  assert.match(await pill.innerText(), /Set · 0 of 20 turns/, "the pill counts the goal's turns")
  await shot("pill")

  // The sheet: the goal as it was set, its quality gates, and what can be done to it.
  await pill.click()
  const sheet = page.getByRole("dialog")
  await sheet.getByText("0 of 20 turns").waitFor({ timeout: 10_000 })
  // A side sheet slides in: wait for it to land against the right edge before the screenshot.
  await until(
    async () => {
      const box = await sheet.boundingBox()
      const width = page.viewportSize()?.width ?? 1440
      return Boolean(box && Math.abs(box.x + box.width - width) < 2)
    },
    5_000,
    "the sheet to settle",
  )
  const shown = await sheet.innerText()
  assert.match(shown, /make the maze's timer survive a page reload/, "the goal reads back")
  await sheet.getByRole("button", { name: /Show the contract and gates/ }).click()
  await sheet.getByText("pnpm lint", { exact: true }).waitFor({ timeout: 5_000 })
  const expanded = await sheet.innerText()
  assert.match(expanded, /pnpm lint/, "its quality gate rides along")
  assert.match(expanded, /reloading mid-run keeps the clock/, "and its contract")
  await shot("sheet")

  // Pausing parks the goal: the sheet closes and the card waits on the user.
  await sheet.getByRole("button", { name: "Pause" }).click()
  await until(() => controls.includes("pause"), 5_000, "the host to be asked to pause")
  await page.keyboard.press("Escape")
  await sheet.waitFor({ state: "hidden", timeout: 10_000 })
  await page.getByText("Goal paused").waitFor({ timeout: 20_000 })
  await shot("card")

  // Resuming sends the kick the host answered with, so the goal's next run starts now.
  await page.getByRole("button", { name: "Resume" }).click()
  await until(() => controls.includes("resume"), 5_000, "the host to be asked to resume")
  await until(
    async () => (await page.getByText(/Continue working towards this goal/).count()) > 0,
    20_000,
    "the kick to be sent",
  )
  await page.getByText("Goal paused").waitFor({ state: "hidden", timeout: 20_000 })
  await pill.waitFor({ timeout: 20_000 })
  pass("an active goal shows its pill and sheet; a paused one waits and resumes")
})
