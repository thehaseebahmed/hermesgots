// Shared setup for the e2e flows: a browser on the app (APP_URL) with its first bot pointed at the
// mock Hermes (MOCK_URL), and helpers to seed chats, send, wait and take screenshots. The CLI
// (`pnpm e2e`, `cli.mjs`) starts the servers and sets these variables; a flow also runs on its own.
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { statfsSync } from "node:fs"

export { assert }
export const app = process.env.APP_URL ?? "http://127.0.0.1:15173"
export const mock = process.env.MOCK_URL ?? "http://127.0.0.1:18642"
const shots = process.env.SHOTS_DIR
const headed = process.env.E2E_HEADED === "1"
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright")

/** A short id so each run's sessions are new to the mock, which keeps its state between flows. */
export const runId = () => Math.random().toString(36).slice(2, 8)

/**
 * Resolves once nothing the clock drives is still moving: a sheet's slide, a pane's push, a fade.
 * Two frames first, so a transition the last step started has been created; then every animation
 * with an end — a spinner, a skeleton's pulse and a bot's idle motion have none — has reached it. A
 * box read before then is a moving target. An animation a scroll places rather than the clock is
 * skipped: a chat thread too short to scroll leaves its fade's scroll timeline before its range, so
 * it can sit pending for as long as the page is open.
 */
export async function settled(page, timeout = 5_000) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  )
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every(
          (animation) =>
            animation.effect?.getComputedTiming().iterations === Infinity ||
            !(animation.timeline instanceof DocumentTimeline) ||
            (animation.playState !== "running" && !animation.pending),
        ),
    undefined,
    { timeout, polling: "raf" },
  )
}

/** A screenshot of the page at rest: animations with an end are run to it, and endless ones stop. */
const capture = (page, path) => page.screenshot({ path, animations: "disabled" })

/**
 * Launches Chromium for a flow or a probe. Playwright passes `--disable-dev-shm-usage` by default —
 * right for docker's 64MB /dev/shm — which points Chromium's shared memory at /tmp as unlinked
 * files instead. A page load can hold hundreds of MB of those, a small /tmp fills, and the next
 * navigation dies with ERR_INSUFFICIENT_RESOURCES. Where /dev/shm has room, Chromium keeps it.
 */
export function launch(chromium, headless = true, args = []) {
  const shm = statfsSync("/dev/shm")
  const room = shm.bavail * shm.bsize
  return chromium.launch({
    headless,
    args: ["--no-sandbox", ...args],
    ...(room >= 512 * 1024 * 1024 ? { ignoreDefaultArgs: ["--disable-dev-shm-usage"] } : {}),
  })
}

/**
 * Wraps a page's navigations so each one waits for the module graph before the next can begin. The
 * module graph finishes after the load event; a second navigation during it exhausts the browser's
 * pending-request cap, and the new page then fetches nothing at all (a white screen). The wait is
 * the page's code requests landing — module graphs are what a navigation abandons and what piles
 * up — and it gives up after 8s, so a module the client has lost simply moves on. A graph that
 * takes its time under four lanes' contention lands in a couple of seconds once the dev server
 * is warm; a wait longer than this only ever waits out a lost request.
 */
export async function settleNav(page) {
  // The memory cache keeps every module body the page has ever fetched, each in its own
  // shared-memory region at 2MB granularity — hundreds per route graph. Five routes in one browser
  // reach a gigabyte, and when the regions stop being pruned the next navigation dies with
  // ERR_INSUFFICIENT_RESOURCES (a white page). Re-fetching is Vite's transform cache, not the
  // network: the dev server already holds every transformed module.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Network.enable")
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true })
  const streams = /\/events(?:\?|$)/
  // What must land before the next navigation is the module graph — code the page asked for. A
  // bot's picture, a host probe or an API read is not part of it, and several of those never settle
  // client-side at all, so waiting on one burns the whole cap and delays every case for nothing.
  const code = /\.(?:m?js|[jt]sx|css)(?:\?|$)/
  const pending = new Map()
  page.on("request", (request) => {
    if (!streams.test(request.url()) && code.test(request.url())) pending.set(request, Date.now())
  })
  const landed = (request) => pending.delete(request)
  page.on("requestfinished", landed)
  page.on("requestfailed", landed)
  if (process.env.E2E_PROBE_NAV) {
    page.on("requestfailed", (request) =>
      console.log(`[req-fail ${request.failure()?.errorText}] ${request.url().split("/").at(-1)}`),
    )
    page.on("response", (response) => {
      if (response.status() === 404) console.log(`[404] ${response.url()}`)
    })
  }
  const settle = async (since) => {
    for (const end = Date.now() + 8_000; Date.now() < end;) {
      // Requests older than this navigation are the last page's stragglers: an abandoned fetch
      // neither finishes nor fails in the client, and waiting on one burns the whole cap and then
      // still leaves the page to the next navigation. Only this document's graph counts.
      for (const [request, at] of pending) if (at < since) pending.delete(request)
      if (![...pending.values()].some((at) => at >= since)) return
      await new Promise((done) => setTimeout(done, 100))
    }
  }
  for (const name of ["goto", "reload"]) {
    const navigate = page[name].bind(page)
    page[name] = async (...args) => {
      const since = Date.now()
      const result = await navigate(...args)
      await settle(since)
      if (process.env.E2E_PROBE_NAV) {
        const mock = process.env.MOCK_URL
        const state = await page
          .evaluate(async (mock) => {
            const race = (work, label) =>
              Promise.race([
                work.then(() => `${label}-ok`),
                new Promise((no) => setTimeout(() => no(`${label}-hung`), 3000)),
              ])
            const db = await race(import("/src/lib/db.ts"), "db")
            const root = document.querySelector("#root")?.childElementCount
            const more =
              root > 0
                ? ""
                : ` ${await race(import("/src/routes/routines.tsx"), "route")} ${await race(
                    fetch(`${mock}/api/jobs?include_disabled=true`).then((r) => r.status),
                    "jobs",
                  )}`
            return `${document.readyState} root=${root} ${db}${more}`
          }, mock)
          .catch((error) => error.message.slice(0, 60))
        console.log(
          `[nav ${new URL(page.url()).pathname}] ${state} pending=${[...pending.keys()]
            .map((r) => r.url())
            .join(",")}`,
        )
      }
      return result
    }
  }
  return page
}

/**
 * Opens the app with the bot set up, runs `body`, and closes the browser. A failure saves
 * `failed.png` (with SHOTS_DIR set) before it is thrown. `touch` gives the page a touchscreen, for a
 * flow that has to send a real finger — off by default, so every other flow keeps a mouse-only page.
 * `account` signs the browser in (see `signIn`) before the app loads, for a flow whose screen needs
 * the account — a bot pointed at the mock either way.
 */
export async function flow(
  name,
  body,
  { viewport = { width: 1440, height: 900 }, dark, touch, account } = {},
) {
  const browser = await launch(chromium, !headed)
  const page = await settleNav(
    await browser.newPage({
      viewport,
      colorScheme: dark ? "dark" : "light",
      ...(touch ? { hasTouch: true } : {}),
    }),
  )
  // The account has to be in place before the document that reads it: the init script lands on the
  // next navigation, which is the flow's own `goto`.
  if (account) await signIn(page.context())
  const shot = async (step) => {
    if (!shots) return
    mkdirSync(shots, { recursive: true })
    const path = `${shots}/${name}-${step}.png`
    await capture(page, path)
    return path
  }
  try {
    await page.goto(app)
    const profileId = await setUpBot(page)
    await body({ page, profileId, shot, ...helpers(page) })
  } catch (error) {
    await shot("failed").catch(() => {})
    throw error
  } finally {
    await browser.close()
  }
}

const botPatch = (baseUrl) => ({
  baseUrl: `${baseUrl}/v1`,
  apiKey: "mock-key",
  pluginChats: true,
})

/** Points the first bot at the mock and skips the setup wizard; answers the bot's id. */
export async function setUpBot(page) {
  return page.evaluate(async (patch) => {
    const { db } = await import("/src/lib/db.ts")
    const profile = (await db.profiles.toArray())[0]
    await db.profiles.update(profile.id, { ...patch, name: "Test bot" })
    await db.settings.put({ id: "settings", activeProfileId: profile.id, onboarded: true })
    return profile.id
  }, botPatch(mock))
}

export async function addBot(page, { name, messages, hour = 3_600_000 }) {
  return page.evaluate(
    async ({ name, messages, patch, hour }) => {
      const { addProfile, db, ensureMainThread, mainThreadId } = await import("/src/lib/db.ts")
      const profile = await addProfile({ ...patch, name, model: "hermes-agent" })
      const mainId = mainThreadId(profile.id)
      await ensureMainThread(profile.id)
      const now = Date.now()
      await db.messages.bulkPut(
        messages.map((content, index) => ({
          id: `${mainId}-${index}`,
          conversationId: mainId,
          role: index % 2 ? "assistant" : "user",
          content,
          status: "done",
          createdAt: now - hour + index,
        })),
      )
      return profile.id
    },
    { name, messages, patch: botPatch(mock), hour },
  )
}

/** The signed-in account the wizard flows start from, and the one `flow`'s `account` seeds. */
export const accountUser = { id: "11111111-2222-4333-8444-555555555555", email: "tester@example.com" }

/**
 * Signs a browser context in to Identity and stubs the site's functions an account reads: the sync
 * document endpoint, the community leaderboard and Identity's settings. `vault` is "missing" for a
 * first run, "exists" for an account that already has one, or a holder `{ data }` the flow seeds —
 * that stub then behaves like the sync function, serving what it holds and taking writes with etags,
 * so a flow can watch a vault change over several writes. Answers `session`, the `vaults` every
 * vault PUT carried, the `held` holder itself and the `joins` the leaderboard took. The caller
 * supplies the page (and closes the browser).
 */
export async function signIn(context, { vault = "exists" } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const expires = now + 3600
  const jwtPayload = Buffer.from(JSON.stringify({ sub: accountUser.id, exp: expires })).toString(
    "base64url",
  )
  const session = {
    ...accountUser,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    url: `${app}/.netlify/identity`,
    token: {
      access_token: `h.${jwtPayload}.s`,
      token_type: "bearer",
      expires_at: expires * 1000,
      refresh_token: "r",
    },
  }
  await context.addInitScript(
    (session) => localStorage.setItem("gotrue.user", JSON.stringify(session)),
    session,
  )
  await context.addCookies([{ name: "nf_jwt", value: session.token.access_token, url: app }])

  const vaults = []
  // A vault the flow seeds (`{ data }`) is served like the sync function's: written over its etag,
  // and what it holds changes with each write.
  const held = typeof vault === "object" ? vault : undefined
  let etag = "v1"
  await context.route("**/.netlify/functions/sync?**", async (route) => {
    const request = route.request()
    const doc = new URL(request.url()).searchParams.get("doc")
    if (request.method() === "PUT") {
      const body = request.postDataJSON()
      if (doc === "vault") {
        vaults.push(body.data)
        if (held) {
          if (body.etag && body.etag !== etag) return route.fulfill({ status: 412, json: {} })
          held.data = body.data
          etag = `v${Number(etag.slice(1)) + 1}`
        }
      }
      return route.fulfill({ json: { ok: true } })
    }
    const data = held ? held.data : {}
    if (doc === "vault" && (held ? data !== undefined : vault !== "missing"))
      return route.fulfill({ json: { data, etag } })
    return route.fulfill({ status: 404, json: { error: "missing" } })
  })

  const joins = []
  await context.route("**/.netlify/functions/community?**", async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get("route") !== "join") return route.fulfill({ json: { joined: false } })
    joins.push(route.request().method())
    return route.fulfill({
      json: { joined: true, login: "tester", totals: { today: 0, week: 0, month: 0 } },
    })
  })

  // Identity's settings say which sign-in providers are on; without GitHub the app is unavailable.
  await context.route("**/.netlify/identity/**", (route) =>
    route.request().url().endsWith("/settings")
      ? route.fulfill({
          json: { external: { github: true }, autoconfirm: false, disable_signup: false },
        })
      : route.fulfill({ status: 500, body: "" }),
  )
  return { session, vaults, held, joins }
}

/**
 * A browser signed in to Identity with the sync, community and Identity routes stubbed, for a flow
 * that has to start before the wizard — see `signIn` for what `vault` means. `shot(name)` saves a
 * screenshot. The caller closes `browser`.
 */
export async function signedIn({ width = 1440, dark = false, vault = "exists" } = {}) {
  const browser = await launch(chromium, !headed)
  const context = await browser.newContext({
    viewport: { width, height: width < 768 ? 844 : 768 },
    colorScheme: dark ? "dark" : "light",
  })
  const { session, vaults, joins } = await signIn(context, { vault })

  const page = await settleNav(await context.newPage())
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  return {
    browser,
    context,
    page,
    session,
    vaults,
    joins,
    errors,
    async shot(name) {
      if (!shots) return
      mkdirSync(shots, { recursive: true })
      await capture(page, `${shots}/${name}.png`)
    },
  }
}

function helpers(page) {
  const composer = page.getByRole("textbox").last()
  return {
    /** Writes chats straight to Dexie: `{ id, title, projectId? }`, titled for good. */
    async seed(chats) {
      await page.evaluate(async (chats) => {
        const { db } = await import("/src/lib/db.ts")
        const profile = (await db.profiles.toArray())[0]
        const at = Date.now()
        await db.conversations.bulkPut(
          chats.map((chat) => ({
            profileId: profile.id,
            hermesSessionId: `${chat.id}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: at - 1000,
            updatedAt: at,
            changedAt: at,
            titleEdited: true,
            ...(chat.projectId ? { draftAt: at } : {}),
            ...chat,
          })),
        )
      }, chats)
    },
    /** Types into the composer and sends. */
    async send(text) {
      await composer.fill(text)
      await composer.press("Enter")
    },
    lastReply(chatId) {
      return page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        const last = (await db.messages.where("conversationId").equals(id).sortBy("createdAt")).at(
          -1,
        )
        return last?.role === "assistant"
          ? {
              status: last.status,
              length: last.content.length,
              content: last.content,
              reasoning: last.reasoning ?? "",
              // A reply's thinking in runs, each with the span this device measured for it.
              runs: (last.reasoningRuns ?? []).map((run) => ({
                text: run.text,
                afterToolId: run.afterToolId ?? null,
                spanMs: run.spanMs ?? null,
              })),
              tools: last.tools?.length ?? 0,
            }
          : null
      }, chatId)
    },
    /** The pull requests the app has stored for a chat. */
    stored(chatId) {
      return page.evaluate(async (id) => {
        const { db } = await import("/src/lib/db.ts")
        return (await db.conversations.get(id))?.prs ?? null
      }, chatId)
    },
    /**
     * Polls `check` until it answers something truthy. Use it over `page.waitForFunction` with an
     * async predicate, whose promise is truthy and so ends the wait at once.
     */
    async until(check, ms, what) {
      for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(500)) {
        const value = await check()
        if (value) return value
      }
      throw new Error(`Timed out after ${ms / 1000}s waiting for ${what}`)
    },
    /**
     * Holds every request matching `pattern` back, so a placeholder can be looked at while the bytes
     * are still coming: `hold()` holds what arrives from then on, `release()` lets it all through. A
     * hold lasts 10s at most, so a flow that throws can't hang. With `fail`, a url ending in it is
     * answered as a file the host can't serve (which reads as "Couldn't load").
     */
    async held(pattern, fail) {
      const waiting = []
      let holding = false
      await page.route(pattern, async (route) => {
        if (fail && route.request().url().endsWith(fail))
          return route.fulfill({ status: 500, contentType: "text/plain", body: "no capture" })
        if (holding)
          await new Promise((done) => {
            waiting.push(done)
            setTimeout(done, 10_000)
          })
        await route.continue().catch(() => {})
      })
      return {
        hold: () => {
          holding = true
        },
        release: () => {
          holding = false
          for (const done of waiting.splice(0)) done()
        },
      }
    },
    /**
     * Records every skeleton the page renders from then on, with the box it took: a placeholder can
     * live for a single commit, which polling misses. `skeletons()` reads them, `stopSkeletons()`
     * ends the recording.
     */
    async watchSkeletons() {
      await page.evaluate(() => {
        const boxes = new Map()
        window.__skeletons = []
        window.__skeletonObserver = new MutationObserver(() => {
          for (const node of document.querySelectorAll("[data-slot=skeleton]")) {
            const box = node.getBoundingClientRect()
            boxes.set(node, {
              width: Math.round(box.width),
              height: Math.round(box.height),
              inButton: Boolean(node.closest("button")),
            })
          }
          window.__skeletons = [...boxes.values()]
        })
        window.__skeletonObserver.observe(document.body, { childList: true, subtree: true })
      })
    },
    skeletons() {
      return page.evaluate(() => window.__skeletons ?? [])
    },
    stopSkeletons() {
      return page.evaluate(() => window.__skeletonObserver?.disconnect())
    },
  }
}

export const pass = (text) => console.log(`PASS: ${text}`)

/** The mock's own key, for the calls a flow makes to it as another device would. */
export const mockAuth = {
  "Content-Type": "application/json",
  Authorization: "Bearer mock-key",
}

/**
 * Compresses a chat on the mock: Hermes rotates `session` onto `child`, as it does mid-run, and
 * keys what comes after on the child. Answers the mock's response, so a flow can assert it took.
 */
export const compress = (session, child) =>
  fetch(`${mock}/__mock/compress`, {
    method: "POST",
    headers: mockAuth,
    body: JSON.stringify({ session, child }),
  })

/**
 * Creates a project on the mock and waits for the clone to land, so its screen offers the options
 * menu; answers its id. `until` is `helpers(page)`'s poll, and the name is the flow's own so a run's
 * projects are told apart in the mock's list.
 */
export async function makeProject(until, name) {
  const created = await fetch(`${mock}/api/plugins/memento/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `${name} ${runId()}`, repos: ["mock-user/memento"] }),
  })
  const pending = await created.json()
  const ready = await until(
    async () => {
      const listed = await (await fetch(`${mock}/api/plugins/memento/projects`)).json()
      const found = listed.projects.find((project) => project.slug === pending.slug)
      return found?.status === "ready" ? found : null
    },
    20_000,
    "the mock to finish cloning the project",
  )
  return ready.id
}

/** A project screen with its options menu's AFK pop-up open. */
export async function openAfk(page, screen) {
  await page.goto(screen)
  const options = page.getByRole("button", { name: "Project options" })
  await options.waitFor({ timeout: 15_000 })
  await options.click()
  await page.getByRole("menuitem", { name: "AFK" }).click()
}

/** Says something to the mock's AFK switch, the way the plugin's own write would. */
export const say = (body) =>
  fetch(`${mock}/__mock/afk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

/** AFK's answer for a project, read straight from the mock rather than through the app's own sheet. */
export const afkRead = async (projectId) =>
  (await fetch(`${mock}/api/plugins/memento/projects/${projectId}/afk`)).json()

/**
 * Seeds this device's vault the way a returning device's is: a data key minted here, and its locked
 * copy in the device's own database — the state an account's device is in with the vault unlocked.
 * The account's sealed documents are sealed with that key, so whatever a flow answers them with
 * opens on this page. `userId` is the account the page is signed in as.
 */
export async function seedVault(page, userId = accountUser.id) {
  await page.evaluate(async (id) => {
    const vault = await import("/src/lib/vault.ts")
    const { db } = await import("/src/lib/db.ts")
    await db.vault.put({ id: "key", userId: id, key: await vault.lockDown(await vault.generateDataKey()) })
  }, userId)
}

/** Leaves a project to work on its own: the AFK pop-up opened, the switch turned on and read back. */
export async function afkOn(page, screen, until) {
  await openAfk(page, screen)
  const control = page.getByRole("switch", { name: "Work on its own" })
  await control.waitFor({ timeout: 15_000 })
  await control.click()
  await until(
    async () => (await control.getAttribute("aria-checked")) === "true",
    15_000,
    "the switch to read on",
  )
  return control
}

/**
 * One header row's geometry, read in one measure: `row`, `title`, `line` and `middle` boxes, the
 * `actions` box of the last control they carry, the scroll widths the title and line cut at, and
 * the margins the header's own padding keeps between its shell and the row. The control is the last
 * button inside the actions slot, not the slot itself — the slot stretched to its whole track even
 * when the buttons inside sat at that track's left edge, which is how a row once drew its controls
 * anywhere but the corner and still measured as ending on the row's edge. Boxes are asserted, so a
 * header that draws no title or no action fails by name rather than as a null. The row is the
 * caller's own locator: scoped to the header it came for, so a second header on the screen cannot
 * be measured by mistake, and one `evaluate` wide, so no two boxes can be read a reflow apart.
 */
export async function readHeader(row) {
  assert.equal(await row.count(), 1, `${row} is drawn once`)
  const boxes = await row.evaluate((element) => {
    const box = (node) => {
      if (!node) return null
      const { x, width } = node.getBoundingClientRect()
      return { x, width, right: x + width }
    }
    const title = element.querySelector('[data-slot="header-title"]')
    const line = element.querySelector('[data-slot="header-line"]')
    const buttons =
      element.querySelector('[data-slot="header-actions"]')?.querySelectorAll("button") ?? []
    const rowBox = box(element)
    const shell = element.closest("header")?.getBoundingClientRect()
    return {
      row: rowBox,
      title: box(title),
      line: box(line),
      middle: box(element.querySelector('[data-slot="header-middle"]')),
      actions: box(buttons[buttons.length - 1]),
      scroll: title?.scrollWidth ?? 0,
      client: title?.clientWidth ?? 0,
      lineScroll: line?.scrollWidth ?? 0,
      lineClient: line?.clientWidth ?? 0,
      marginLeft: shell ? rowBox.x - shell.x : 0,
      marginRight: shell ? shell.right - rowBox.right : 0,
    }
  })
  assert.ok(boxes.title, "the header carries a title")
  assert.ok(boxes.actions, "the header carries an action to hold its corner")
  return boxes
}

/** A box's horizontal centre — strict, so a missing box fails rather than comparing zero. */
const centre = (box) => box.x + box.width / 2

/**
 * The set every room of a centred header gets, under `look`: its line drawn, the header's margins
 * kept on both sides, the title inside the room the controls leave and on that room's and the
 * row's centres, the line on the title's, and the actions ending on the row's right edge. One set
 * for both flows and every width they measure, so the gates cannot drift apart between them.
 */
export const centred = (boxes, look) => {
  assert.ok(boxes.line, `the header draws its line (${look})`)
  assert.ok(
    boxes.marginLeft >= 8 && boxes.marginRight >= 8,
    `the header keeps its margins on both sides at ${look} (${Math.round(boxes.marginLeft)}px left, ${Math.round(boxes.marginRight)}px right)`,
  )
  assert.ok(
    boxes.title.x >= boxes.middle.x - 2 && boxes.title.right <= boxes.middle.right + 2,
    `the title stays in the room the controls leave at ${look}`,
  )
  assert.ok(
    Math.abs(centre(boxes.title) - centre(boxes.middle)) <= 2,
    `the title is centred in that room at ${look}`,
  )
  assert.ok(
    Math.abs(centre(boxes.line) - centre(boxes.title)) <= 2,
    `the line is centred under the title at ${look}`,
  )
  assert.ok(
    Math.abs(centre(boxes.title) - centre(boxes.row)) <= 2,
    `the title is centred on the row at ${look} (${Math.round(centre(boxes.title))} against ${Math.round(centre(boxes.row))})`,
  )
  assert.ok(
    Math.abs(boxes.actions.right - boxes.row.right) <= 2,
    `the actions end on the row's right edge at ${look} (${Math.round(boxes.actions.right)} against ${Math.round(boxes.row.right)})`,
  )
}

/**
 * Fails unless the element's text fits on one line. Its height is compared with a line, since a block
 * reports a single client rect whether it wraps or not.
 */
export async function assertOneLine(locator, what) {
  const { height, line } = await locator.evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(el).lineHeight),
  }))
  assert.ok(height <= line * 1.3, `${what} is on one line (${height}px of ${line}px)`)
}

/**
 * Fails unless the text wraps only after a hyphen, so a code too wide for its box breaks between its
 * groups rather than inside one. Returns the lines it found, for a caller that also cares how many.
 */
export async function assertBreakAtHyphen(locator, what) {
  const lines = await locator.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const found = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (let index = 0; index < node.data.length; index++) {
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + 1)
        found.push({
          char: node.data[index],
          top: Math.round(range.getBoundingClientRect().top),
        })
      }
    }
    const lines = []
    for (const { char, top } of found) {
      if (lines.at(-1)?.top !== top) lines.push({ top, text: "" })
      lines.at(-1).text += char
    }
    return lines.map((line) => line.text)
  })
  assert.ok(lines.length > 0, `${what} has text to measure`)
  for (const line of lines.slice(0, -1))
    assert.ok(line.endsWith("-"), `${what} breaks at a hyphen, not "${line}"`)
  return lines
}
