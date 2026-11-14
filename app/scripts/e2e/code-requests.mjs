// What Code asks its server, counted: the list as it opens, the list left alone, the list put away
// and brought back, and the same three for a session opened from it. A budget over real time and a
// real fetch stack, at a phone's width so the list and the session are one screen each.
import { app, assert, flow, pass } from "./lib.mjs"

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
  streamed: { listOpen: 16, listIdle: 4, listBack: 9, sessionOpen: 22, sessionIdle: 3, sessionBack: 9, away: 1 },
  polled: { listOpen: 16, listIdle: 19, listBack: 9, sessionOpen: 22, sessionIdle: 23, sessionBack: 12, away: 1 },
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
      assert.ok(asked.length <= budget, `${state}: ${asked.length} requests, over ${budget}: ${summary(asked)}`)
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
  },
  { viewport: { width: 390, height: 844 } },
)
