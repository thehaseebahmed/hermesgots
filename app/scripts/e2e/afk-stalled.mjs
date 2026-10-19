// An AFK session nothing is working any more — its run failed, or a restart adopted it — waits where
// the user will find it: Code's Waiting on you, and from 1280px the sidebar's Waiting for input, each
// with the host's own reason under it, the way the plugin reports a stalled claim. The mock says a
// project's claim stalled on request, so the whole thing is covered without GitHub.
import { afkOn, app, assert, flow, makeProject, mock, pass } from "./lib.mjs"

const TITLE = "#265 The frontier is read from GitHub and listed"
const REASON = "The run failed."

const run = (wide) => async ({ page, profileId, shot, until }) => {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  const projectId = await makeProject(until, "AFK stalled")
  // The mock remembers which claims stalled between passes; this pass wants only its own.
  await fetch(`${mock}/__mock/afk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reset: true }),
  })
  const screen = `${app}/projects/${profileId}/${projectId}`

  await afkOn(page, screen, until)

  await until(
    async () => {
      const answer = await (await fetch(`${mock}/api/plugins/memento/projects/${projectId}/afk`)).json()
      return answer.task ? answer : null
    },
    20_000,
    "AFK to claim its task",
  )
  await fetch(`${mock}/__mock/afk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId, reason: REASON }),
  })

  await page.goto(`${app}/code`)
  const group = page.getByRole("region", { name: "Waiting on you" })
  await group.getByText(TITLE).waitFor({ timeout: 20_000 })
  await group.getByText(REASON).waitFor({ timeout: 10_000 })
  assert.equal(
    await group.locator("[data-afk]").first().textContent(),
    "AFK",
    "the session is still marked as AFK's where sessions are listed",
  )
  if (wide) {
    const waiting = page.getByRole("navigation", { name: "Waiting for input" })
    await waiting.getByText(TITLE).waitFor({ timeout: 15_000 })
    await waiting.getByText(REASON).waitFor({ timeout: 10_000 })
  }
  await shot("waiting")
  assert.deepEqual(errors, [], `no console error (${errors.join("; ")})`)
}

for (const width of [390, 1440]) {
  for (const dark of [false, true]) {
    await flow(`afk-stalled-${width}${dark ? "-dark" : ""}`, run(width >= 1280), {
      viewport: { width, height: width < 768 ? 844 : 900 },
      dark,
    })
  }
}
pass(
  `A stalled AFK session (${REASON}) waits in Code's Waiting on you, and in the sidebar's Waiting for input from 1280px, titled after its task and still marked AFK, at 390 and 1440px, light and dark`,
)
