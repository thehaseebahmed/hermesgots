// What Code asks its server, counted: the list as it opens, the list left alone, the list put away
// and brought back, and the same three for a session opened from it. A budget over real time and a
// real fetch stack, at a phone's width so the list and the session are one screen each.
//
// Then how stale the list is when the host changes under it: a run that ends, a plan left pending,
// a pull request's checks that move, a mode set from another device — each timed from the moment the
// host said it to the moment this device shows it. These are reported, and only the two a host
// announces are held to an outer bound: a timing belongs to the machine that measured it.
import { app, assert, flow, long, mock, mockPost, pass, runStatus, startRun } from "./lib.mjs"

const PROJECT = "p_1a2b3c4d"
const SESSIONS = 6
const IDLE_MS = 65_000
const AWAY_MS = 30_000
const SETTLE_MS = 10_000

/**
 * The most each state may ask, a little over what it measured when the budget was set: by whether the
 * bot's server streams its changes, since a server that doesn't is polled by design. The counts are
 * a development build's, where React mounts every screen twice, so an opening reads above what a
 * release asks.
 */
const BUDGETS = {
  streamed: {
    listOpen: 16,
    listIdle: 4,
    listBack: 9,
    sessionOpen: 22,
    sessionIdle: 3,
    sessionBack: 9,
    away: 1,
  },
  polled: {
    listOpen: 16,
    listIdle: 19,
    listBack: 9,
    sessionOpen: 22,
    sessionIdle: 23,
    sessionBack: 12,
    away: 1,
  },
}

/** A request's route: its path with the ids taken out, so six sessions' reads count as one route. */
const routeOf = (url) =>
  `${url.pathname.replace(/cr-[\w-]+/g, "<session>").replace(/run_[\w-]+/g, "<run>")}${
    url.searchParams.has("session") ? "?session=…" : ""
  }`

/** Hides or shows the page as a phone that put the app away does. */
const setHidden = (page, hidden) =>
  page.evaluate((hidden) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    })
    document.dispatchEvent(new Event("visibilitychange"))
  }, hidden)

const summary = (seen) =>
  Object.entries(Object.groupBy(seen, (route) => route))
    .sort((a, b) => b[1].length - a[1].length)
    .map(([route, hits]) => `${hits.length}× ${route}`)
    .join(", ")

await flow(
  "code-requests",
  async ({ page, seed }) => {
    const port = new URL(process.env.MOCK_URL).port
    let seen = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      const mocked = url.port === port || url.hostname.endsWith(".test")
      if (mocked && request.method() !== "OPTIONS") seen.push(`${request.method()} ${routeOf(url)}`)
    })
    /** Counts what `during` asks, by route. */
    const count = async (during) => {
      seen = []
      await during()
      return seen
    }
    const report = (state, asked, budget) => {
      // REPORT_ONLY reads the numbers of a build that is over them, to compare it with this one.
      if (!process.env.REPORT_ONLY)
        assert.ok(
          asked.length <= budget,
          `${state}: ${asked.length} requests, over ${budget}: ${summary(asked)}`,
        )
      pass(`${state}: ${asked.length} requests (budget ${budget}): ${summary(asked) || "none"}`)
    }

    const now = Date.now()
    await seed(
      Array.from({ length: SESSIONS }, (_, i) => ({
        id: `cr-${i}`,
        title: `Session ${i}`,
        projectId: PROJECT,
        createdAt: now - 60_000 - i * 1000,
        updatedAt: now - 30_000 - i * 1000,
        worktree: { branch: `hermes/cr-${i}`, repos: [{ name: "acme/gots" }], instructions: "" },
      })),
    )

    const opened = await count(async () => {
      await page.goto(`${app}/code`)
      await page.getByText("Session 0", { exact: true }).waitFor({ timeout: 20_000 })
      await page.waitForTimeout(SETTLE_MS)
    })
    const streamed = await page.evaluate(async () => {
      const [{ db }, { isLive }] = await Promise.all([
        import("/src/lib/db.ts"),
        import("/src/lib/live.ts"),
      ])
      return isLive((await db.profiles.toArray())[0])
    })
    const BUDGET = streamed ? BUDGETS.streamed : BUDGETS.polled
    /** A bound only where the host announces the change; a polled host has no promise to hold. */
    const streamedBound = (ms) => (streamed ? ms : undefined)
    pass(`the bot's server ${streamed ? "streams its changes" : "is polled"}`)
    report("list, opening", opened, BUDGET.listOpen)

    report("list, idle 65s", await count(() => page.waitForTimeout(IDLE_MS)), BUDGET.listIdle)

    await setHidden(page, true)
    report("list, away 30s", await count(() => page.waitForTimeout(AWAY_MS)), BUDGET.away)
    const listBack = await count(async () => {
      await setHidden(page, false)
      await page.waitForTimeout(SETTLE_MS)
    })
    report("list, back", listBack, BUDGET.listBack)

    const sessionOpen = await count(async () => {
      await page.getByText("Session 0", { exact: true }).click()
      await page.waitForURL("**/c/**", { timeout: 15_000 })
      await page.waitForTimeout(SETTLE_MS)
    })
    report("session, opening", sessionOpen, BUDGET.sessionOpen)

    report("session, idle 65s", await count(() => page.waitForTimeout(IDLE_MS)), BUDGET.sessionIdle)

    await setHidden(page, true)
    report("session, away 30s", await count(() => page.waitForTimeout(AWAY_MS)), BUDGET.away)
    const sessionBack = await count(async () => {
      await setHidden(page, false)
      await page.waitForTimeout(SETTLE_MS)
    })
    report("session, back", sessionBack, BUDGET.sessionBack)

    // ---- How stale the list is -------------------------------------------------------------
    const WAIT_MS = 90_000
    const sessionOf = (id) =>
      page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        return (await db.conversations.get(id)).hermesSessionId
      }, id)
    const held = (id) =>
      page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        const c = await db.conversations.get(id)
        return { mode: c.mode, checks: c.prs?.[0]?.checks }
      }, id)
    /** Milliseconds until `check` holds, polled every 100ms; null if it never does inside `cap`. */
    const timeTo = async (check, cap = WAIT_MS) => {
      const from = Date.now()
      while (Date.now() - from < cap) {
        if (await check()) return Date.now() - from
        await page.waitForTimeout(100)
      }
      return null
    }
    const inGroup = async (label, title) =>
      (await page
        .getByRole("region", { name: label, exact: true })
        .getByText(title, { exact: true })
        .count()) > 0
    const results = {}
    const note = (what, ms, bound) => {
      results[what] = ms
      const said = ms === null ? `not within ${WAIT_MS / 1000}s` : `${ms}ms`
      pass(`stale: ${what}: ${said}`)
      if (bound !== undefined && !process.env.REPORT_ONLY)
        assert.ok(ms !== null && ms <= bound, `${what} took ${said}, over ${bound}ms`)
    }

    const ids = ["sr-run", "sr-plan", "sr-pr", "sr-mode"]
    await seed(
      ids.map((id, i) => ({
        id,
        title: `Stale ${id}`,
        projectId: PROJECT,
        createdAt: now - 60_000 - i,
        updatedAt: now - 30_000 - i,
        worktree: { branch: `hermes/${id}`, repos: [{ name: "acme/gots" }], instructions: "" },
      })),
    )
    const sessions = {}
    for (const id of ids) {
      sessions[id] = await sessionOf(id)
      const mode = id === "sr-plan" ? "plan" : "accept_edits"
      const made = await mockPost(`/api/plugins/gots/sessions/${sessions[id]}/workspace`, {
        project_id: PROJECT,
        mode,
      })
      assert.equal(made.status, 200, `the host holds a workspace for ${id}`)
    }
    await page.goto(`${app}/code`)
    await page.getByText("Stale sr-run", { exact: true }).waitFor({ timeout: 20_000 })
    await page.waitForTimeout(SETTLE_MS)

    // A run that ends elsewhere: Working to Idle, from the run's own end.
    const run = await startRun(sessions["sr-run"], long("stale", 6))
    assert.ok(
      await timeTo(() => inGroup("Working", "Stale sr-run"), 20_000),
      "the list shows the run as working",
    )
    await timeTo(async () => (await runStatus(run)) !== "running")
    note("a run ends", await timeTo(() => inGroup("Idle", "Stale sr-run")), streamedBound(20_000))

    // A plan left pending: the row moves to Waiting for You when the run ends.
    const plan = await startRun(sessions["sr-plan"], "plan a dry run for log rotation")
    await timeTo(async () => (await runStatus(plan)) !== "running", 30_000)
    note(
      "a plan is left pending",
      await timeTo(() => inGroup("Waiting for You", "Stale sr-plan")),
      streamedBound(20_000),
    )

    // A pull request's checks move on GitHub with no turn and no event.
    const pr = await startRun(sessions["sr-pr"], "ship it")
    await timeTo(async () => (await runStatus(pr)) !== "running", 30_000)
    await timeTo(async () => (await held("sr-pr")).checks === "success", 30_000)
    await mockPost("/__mock/prs", { session: sessions["sr-pr"], checks: "failure" })
    note(
      "a pull request's checks move",
      await timeTo(async () => (await held("sr-pr")).checks === "failure"),
    )

    // Another device sets a session's mode: the host notes a change and no run moved.
    const set = await mockPost(`/api/plugins/gots/sessions/${sessions["sr-mode"]}/mode`, {
      mode: "auto",
    })
    assert.equal(set.status, 200, "the host takes the mode")
    note(
      "a mode is set elsewhere",
      await timeTo(async () => (await held("sr-mode")).mode === "auto"),
    )

    console.log(`STALENESS ${streamed ? "streamed" : "polled"} ${JSON.stringify(results)}`)
  },
  { viewport: { width: 390, height: 844 } },
)
