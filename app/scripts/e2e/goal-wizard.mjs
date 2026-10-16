// `/goal` opens the wizard. The form composes Hermes's own `/goal` text, the preview follows the
// form, and Save posts it — with the quality gates and the turn budget — then sends the kick text
// the host answered with, so the goal starts now instead of at the next thing the user says.
import { app, assert, flow, pass, setUpBot } from "./lib.mjs"

const chatId = "goal-chat"

await flow("goal-wizard", async ({ page, seed, shot, until }) => {
  await setUpBot(page)
  await seed([{ id: chatId, title: "Goal" }])

  // What the app posts to the host: a goal is set through the plugin, never sent as a message.
  let posted = null
  await page.route("**/sessions/*/goal", async (route) => {
    if (route.request().method() === "POST") posted = JSON.parse(route.request().postData() ?? "{}")
    await route.continue()
  })

  await page.goto(`${app}/c/${chatId}`)
  const composer = page.getByRole("textbox").last()
  await composer.fill("/goal make the login screen show why a sign-in failed")
  await composer.press("Enter")

  // The line after `/goal` is the task, already filled in.
  const task = page.getByLabel("What to work towards")
  await task.waitFor({ timeout: 20_000 })
  assert.equal(
    await task.inputValue(),
    "make the login screen show why a sign-in failed",
    "the line after /goal becomes the task",
  )

  await page.getByLabel("Done when").fill("a wrong password shows an error, a right one signs in")
  await page.getByLabel("Prove it with").fill("pnpm test")
  await page.getByLabel("A gate command").fill("pnpm lint")
  await page.getByRole("button", { name: "Add" }).click()
  await page.getByRole("button", { name: /More options/ }).click()
  await page.getByRole("radio", { name: "One", exact: true }).click()
  await page.getByRole("radio", { name: "Code", exact: true }).click()

  // The preview is the composed goal: the headline, then Hermes's own contract lines.
  const preview = () => page.locator("pre").innerText()
  await until(
    async () => (await preview()).includes("verify: pnpm test"),
    10_000,
    "the preview to follow the form",
  )
  const composed = await preview()
  assert.match(composed, /^make the login screen show why a sign-in failed\n/, "the task leads")
  assert.match(composed, /\noutcome: a wrong password shows an error, a right one signs in\n/)
  assert.match(composed, /\nconstraints: .*one reviewer/, "the review policy is a constraint")
  assert.match(composed, /\nverify: pnpm test\n/)
  // A gate isn't part of the goal text: it rides beside it, as its own field on the host.
  assert.equal(
    await page.getByText("pnpm lint", { exact: true }).count(),
    1,
    "the gate is listed in the form",
  )
  await shot("wizard")

  await page.getByRole("button", { name: "Start the goal" }).click()

  await until(() => posted, 10_000, "the host to be asked for a goal")
  assert.equal(posted.command, composed, "the preview is exactly what was set")
  assert.deepEqual(posted.gates, ["pnpm lint"], "the quality gate rides along")
  assert.equal(posted.max_turns, 20, "the turn budget rides along")

  // The kick the host answered with is the chat's next message, so the goal's first run starts now.
  await until(
    async () =>
      (await page.getByText(/Continue working towards this goal/).count()) > 0,
    20_000,
    "the kick to be sent",
  )
  await shot("kick")
  pass("/goal opens the wizard, previews the goal, and sets it")
})
