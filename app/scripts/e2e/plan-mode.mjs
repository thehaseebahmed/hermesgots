// Two sessions of one project in plan mode: the plan a session finishes belongs to that session
// alone. The report this covers: the user was in the first session, went back and opened the
// second one just as the first one's plan-mode reply landed, and the first session's plan-ready
// card showed on the second one's screen — where approving it would have run the wrong plan.
// The switch is the phone's own: Code's list of sessions, then the session's row, no reload.
import { app, assert, flow, mock, pass, runId } from "./lib.mjs"

const PROJECT = "p_1a2b3c4d"

/** Records every time the plan-ready card renders, from now on: a card can live a single commit. */
function watchPlanCard(page) {
  return page.evaluate(() => {
    window.__planCards = []
    window.__planObserver?.disconnect()
    const look = () => {
      const cards = [...document.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Keep planning",
      )
      if (cards.length) window.__planCards.push(Date.now())
    }
    window.__planObserver = new MutationObserver(look)
    window.__planObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    look()
  })
}

const cardsSeen = (page) => page.evaluate(() => window.__planCards.length)
const clearCards = (page) =>
  page.evaluate(() => {
    window.__planCards = []
  })

await flow(
  "plan-mode",
  async ({ page, seed, send, until, shot }) => {
    const a = `plan-a-${runId()}`
    const b = `plan-b-${runId()}`
    // The mock keeps its chat list between runs, so the titles carry the run's tag.
    const titleA = `Rotate the logs ${a.slice(-6)}`
    const titleB = `Later session ${b.slice(-6)}`
    await seed([
      { id: a, title: titleA, projectId: PROJECT },
      { id: b, title: titleB, projectId: PROJECT },
    ])

    const project = `${app}/code`
    const group = (label) => page.getByRole("region", { name: label })
    const backToProject = () => page.getByRole("button", { name: "Back to Code" }).click()
    const openSession = async (id, title) => {
      await group("Today").getByText(title).click()
      await page.waitForURL(`**/c/${id}`)
    }

    // Session A plans, as the mode menu sets it: the mode on the row here, on the plugin with the
    // first turn.
    await page.goto(project)
    await group("Today").getByText(titleA).click()
    await page.waitForURL(`**/c/${a}`)
    await page.evaluate(async (id) => {
      const { setSessionMode } = await import("/src/lib/workspace.ts")
      await setSessionMode(id, "plan")
    }, a)
    const [sessionA, sessionB, apiKey] = await page.evaluate(
      async (ids) => {
        const { db } = await import("/src/lib/db.ts")
        const profile = (await db.profiles.toArray())[0]
        const found = await db.conversations.bulkGet(ids)
        return [...found.map((row) => row.hermesSessionId), profile.apiKey]
      },
      [a, b],
    )
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }
    const host = (path) =>
      fetch(`${mock}/api/plugins/memento${path}`, { headers }).then((response) => response.json())
    const workspace = () => host(`/sessions/${sessionA}/workspace`)
    const row = (id) =>
      page.evaluate(async (conversationId) => {
        const { db } = await import("/src/lib/db.ts")
        const found = await db.conversations.get(conversationId)
        return {
          planPending: Boolean(found?.planPending),
          planFile: found?.planFile ?? null,
        }
      }, id)

    await watchPlanCard(page)
    await send("add a dry run to the log rotation")
    // Plan mode settles its questions before it writes the plan; the plan follows the answers.
    await until(
      async () => (await host("/runs/live")).waiting?.[sessionA]?.kind === "question",
      30_000,
      "session A to be planning and waiting on its questions",
    )
    pass("session A is planning, waiting on the questions its plan needs")

    // Back to Code and into the other session, while A is still planning.
    await backToProject()
    await page.waitForURL("**/code")
    await clearCards(page)
    await openSession(b, titleB)
    await shot("other-session")

    // The plan lands now, with the other session on screen — the moment the report describes.
    await fetch(`${mock}/__mock/clarify`, {
      method: "POST",
      headers,
      body: JSON.stringify({ outcome: "timed_out" }),
    })
    const planned = await until(
      async () => {
        const record = (await workspace()).workspace
        return record?.plan_pending ? record : null
      },
      40_000,
      "session A's plan to be saved and left waiting",
    )
    await page.waitForTimeout(3000)
    pass(`session A's plan is waiting (${planned.plan_file})`)

    // Nothing of it reaches the other session: not its screen, not its row.
    const seenWhileLanding = await cardsSeen(page)
    const bRow = await row(b)
    console.log(
      `plan-mode: the other session's row is ${JSON.stringify(bRow)}; cards seen: ${seenWhileLanding}`,
    )
    assert.equal(seenWhileLanding, 0, "the plan-ready card never rendered on the other session")
    assert.equal(bRow.planPending, false, "the other session's row holds no plan")
    assert.equal(bRow.planFile, null, "the other session's row names no plan file")
    assert.equal(
      await page.getByRole("button", { name: "Keep planning" }).count(),
      0,
      "the other session still shows its composer",
    )
    await shot("clean")
    pass("the plan stays with the session that finished it")

    // The one path a plan can take from one session to another: the plugin answering this session's
    // read with the record of another (a parent walk, or a stale copy). Neither its plan nor its
    // file may land here, on the row or on the screen.
    await page.route(`**/sessions/${sessionB}/workspace`, (route) =>
      route.fulfill({
        json: {
          object: "memento.workspace",
          workspace: {
            session_id: sessionA,
            project_id: PROJECT,
            branch: "hermes/another-session",
            path: "/tmp/another-session",
            repo_root: "/tmp",
            mode: "plan",
            plan_pending: 1,
            plan_file: "plans/another-session-20261015-000000.md",
            repos: [],
            files_dir: null,
          },
          instructions: null,
          blocked: null,
        },
      }),
    )
    const stored = await page.evaluate(async (id) => {
      const { refreshWorkspace } = await import("/src/lib/workspace.ts")
      await refreshWorkspace(id)
      const { db } = await import("/src/lib/db.ts")
      const row = await db.conversations.get(id)
      return {
        planPending: Boolean(row.planPending),
        planFile: row.planFile ?? null,
        mode: row.mode ?? null,
        branch: row.worktree?.branch ?? null,
      }
    }, b)
    await page.waitForTimeout(1500)
    console.log(`plan-mode: another session's record left ${JSON.stringify(stored)}`)
    assert.equal(stored.planPending, false, "a record naming another session brings no plan")
    assert.equal(stored.planFile, null, "a record naming another session brings no plan file")
    assert.equal(
      await page.getByRole("button", { name: "Keep planning" }).count(),
      0,
      "no card either",
    )
    await page.unroute(`**/sessions/${sessionB}/workspace`)
    pass("another session's workspace record is refused")

    // A device that already took another session's plan keeps drawing its card: a read that comes
    // back with no workspace of this session's own clears it, and the card goes with it.
    await page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      await db.conversations.update(id, {
        mode: "plan",
        planPending: true,
        planFile: "plans/another-session-20261015-000000.md",
      })
    }, b)
    await page.getByRole("button", { name: "Keep planning" }).waitFor({ timeout: 10_000 })
    const cleared = await page.evaluate(async (id) => {
      const { refreshWorkspace } = await import("/src/lib/workspace.ts")
      await refreshWorkspace(id)
      const { db } = await import("/src/lib/db.ts")
      const found = await db.conversations.get(id)
      return { planPending: Boolean(found.planPending), planFile: found.planFile ?? null }
    }, b)
    await page.waitForTimeout(1000)
    console.log(`plan-mode: a plan it never planned left ${JSON.stringify(cleared)}`)
    assert.equal(cleared.planPending, false, "a plan from another session is cleared")
    assert.equal(cleared.planFile, null, "and so is its file")
    assert.equal(
      await page.getByRole("button", { name: "Keep planning" }).count(),
      0,
      "the card it drew goes with it",
    )
    pass("a plan taken from another session does not stay on the row")

    // The other order the report could have been: A's card already on screen, then back, then in.
    await backToProject()
    await page.waitForURL("**/code")
    await group("Waiting on you").getByText(titleA).click()
    await page.waitForURL(`**/c/${a}`)
    await page.getByRole("button", { name: "Keep planning" }).waitFor({ timeout: 20_000 })
    await shot("plan-ready")
    pass("session A shows its own plan-ready card")

    await backToProject()
    await page.waitForURL("**/code")
    await clearCards(page)
    await openSession(b, titleB)
    await page.waitForTimeout(3000)
    const seenWhileSwitching = await cardsSeen(page)
    const bAgain = await row(b)
    console.log(
      `plan-mode: after the switch, the other session's row is ${JSON.stringify(bAgain)}; cards seen: ${seenWhileSwitching}`,
    )
    assert.equal(seenWhileSwitching, 0, "A's card never renders under the other session")
    assert.equal(bAgain.planPending, false, "still no plan on the other session")
    assert.equal(bAgain.planFile, null, "still no plan file on the other session")
    pass("switching in with A's card on screen leaves the other session clean")

    // And A keeps its own.
    await backToProject()
    await group("Waiting on you").getByText(titleA).click()
    await page.getByRole("button", { name: "Keep planning" }).waitFor({ timeout: 20_000 })
    pass("session A's plan is still there")

    // The other way the two meet: a session swapped in place beside Code's list, which keeps this
    // screen mounted, while the route's own row is still being read. What the screen held before
    // must not show in the new session's place — its plan card would approve the other plan.
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(project)
    await group("Waiting on you").getByText(titleA).click()
    await page.waitForURL(`**/c/${a}`)
    await page.getByRole("button", { name: "Keep planning" }).waitFor({ timeout: 20_000 })
    // Hold the swap open: the row takes this long to come back, as a slow device's would.
    await page.evaluate(async () => {
      const { db } = await import("/src/lib/db.ts")
      const get = db.conversations.get.bind(db.conversations)
      db.conversations.get = async (key) => {
        const row = await get(key)
        await new Promise((resolve) => setTimeout(resolve, 800))
        return row
      }
    })
    // Watched from the moment this route is the one in the address bar: what was on screen before the
    // swap belongs to the session it was showing.
    await page.evaluate((route) => {
      window.__midSwap = []
      window.__midThread = []
      window.__midSamples = 0
      let routeAt = 0
      window.__watch = setInterval(() => {
        if (!location.pathname.endsWith(route)) return
        // The address bar changes before React commits this route: that instant still shows the
        // screen the navigation started from, which is not this session showing anything of it.
        routeAt ||= Date.now()
        if (Date.now() - routeAt < 150) return
        window.__midSamples += 1
        const cards = [...document.querySelectorAll("button")].filter(
          (button) => button.textContent?.trim() === "Keep planning",
        )
        if (cards.length) window.__midSwap.push(Date.now())
        // The message this session was sent is A's alone: seeing it means A's thread is on screen.
        const thread = document.querySelector('[aria-label="Messages"]')?.innerText ?? ""
        if (thread.includes("dry run to the log rotation")) window.__midThread.push(Date.now())
      }, 50)
    }, `/c/${b}`)
    await group("Today").getByText(titleB).click()
    await page.waitForURL(`**/c/${b}`)
    await page.waitForTimeout(2500)
    const mid = await page.evaluate(() => {
      clearInterval(window.__watch)
      return {
        cards: window.__midSwap.length,
        thread: window.__midThread.length,
        samples: window.__midSamples,
      }
    })
    console.log(
      `plan-mode: on the swapped-in route, ${mid.samples} samples; the other chat's card: ${mid.cards}, its thread: ${mid.thread}`,
    )
    await shot("swapped-in")
    assert.ok(mid.samples > 10, "the swap was watched while this route was on screen")
    assert.equal(mid.cards, 0, "the previous session's plan card never renders in this one's place")
    assert.equal(mid.thread, 0, "and neither does its thread")
    assert.equal(
      await page.getByRole("button", { name: "Keep planning" }).count(),
      0,
      "the swapped-in session shows its own composer",
    )
    assert.equal(
      await row(b).then((again) => again.planPending),
      false,
      "and the swap leaves its row alone",
    )
    pass("a session swapped in place shows nothing of the one before it")
  },
  { viewport: { width: 390, height: 844 } },
)
