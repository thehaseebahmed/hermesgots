// runs/live is read by one shared poll, however many screens show it: a session, its project and
// the sidebar together read it every 10s at most (RUNS_MS). Needs the mock without its change
// stream (MOCK_NO_EVENTS=1), since with the stream open the app polls only every 5 minutes.
import { app, assert, flow, pass } from "./lib.mjs"

await flow("live-poll", async ({ page, seed, shot }) => {
  await seed([{ id: "e2e-poll", title: "Poll check", projectId: "p_1a2b3c4d" }])
  const reads = []
  page.on("request", (request) => {
    if (request.url().includes("/api/plugins/gots/runs/live")) reads.push(Date.now())
  })
  await page.goto(`${app}/c/e2e-poll`)
  await page.getByRole("region", { name: "Today" }).waitFor({ timeout: 15_000 })
  reads.length = 0
  await page.waitForTimeout(25_000)
  await shot("screen")
  assert.ok(reads.length <= 3, `runs/live read ${reads.length} times in 25s (expected <= 3)`)
  pass(
    `runs/live read ${reads.length} times in 25s with the session, its project and the sidebar open`,
  )
})
