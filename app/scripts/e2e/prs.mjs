// The project's Pull requests tab: a session that shipped a pull request lists it, and a host that
// can't reach GitHub leaves the tab as it was — the read fails, so the app keeps the pull requests it
// already knows instead of storing "no pull requests" over them (see plugin/github.py's `strict`).
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

await flow("prs", async ({ page, profileId, seed, send, stored, until, shot }) => {
  // A run that failed mid-way leaves the mock failing; every run starts from a host that answers.
  await fetch(`${mock}/__mock/prs`, { method: "POST", body: JSON.stringify({ fail: false }) })
  const statuses = []
  page.on("response", (response) => {
    if (response.url().includes("/prs")) statuses.push(response.status())
  })
  const project = `${app}/projects/${profileId}/p_1a2b3c4d`

  // A session that ships: its pull request lists in the project's Pull requests tab.
  const shipped = `prs-ship-${runId()}`
  await seed([{ id: shipped, title: "Rotate the logs", projectId: "p_1a2b3c4d" }])
  await page.goto(`${app}/c/${shipped}`)
  await send("ship it")
  await until(
    async () => (await stored(shipped))?.length,
    30_000,
    "the shipped pull request to arrive",
  )
  await page.goto(project)
  await page.getByRole("tab", { name: "Pull requests" }).click()
  await page.locator("main").getByText("#27").waitFor({ timeout: 15_000 })
  await shot("shipped")
  pass("a shipped pull request lists in the project's Pull requests tab")

  // A host that can't reach GitHub: the read answers an error, and what the app already knows stays.
  // The failure goes on first, so no read of the new session can answer an empty list meanwhile.
  const known = `prs-known-${runId()}`
  await fetch(`${mock}/__mock/prs`, { method: "POST", body: JSON.stringify({ fail: true }) })
  await seed([{ id: known, title: "A session with a pull request", projectId: "p_1a2b3c4d" }])
  await page.evaluate(async (id) => {
    const { db } = await import("/src/lib/db.ts")
    await db.conversations.update(id, {
      worktree: {
        branch: "hermes/prs-known",
        repos: [{ name: "mock-user/other", branch: "hermes/prs-known" }],
        instructions: "",
      },
      prs: [
        {
          repo: "mock-user/other",
          number: 91,
          title: "A pull request from an earlier read",
          state: "open",
          checks: "success",
          url: "https://github.com/mock-user/other/pull/91",
          // Older than the screen's freshness window, so opening the project reads again.
          at: Date.now() - 120_000,
        },
      ],
    })
  }, known)
  statuses.length = 0
  await page.goto(project)
  await until(async () => statuses.includes(502), 20_000, "the failing read of the session's PRs")
  assert.equal(
    (await stored(known))?.length,
    1,
    "a failed read must not empty the session's pull requests",
  )
  await page.getByRole("tab", { name: "Pull requests" }).click()
  await page.locator("main").getByText("#91").waitFor({ timeout: 15_000 })
  assert.equal(
    await page.getByText("No pull requests yet").count(),
    0,
    "the tab must not claim there are none",
  )
  await shot("github-unreachable")
  await fetch(`${mock}/__mock/prs`, { method: "POST", body: JSON.stringify({ fail: false }) })
  pass("a host that can't reach GitHub keeps the pull requests the app already knows")
})
