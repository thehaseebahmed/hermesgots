import { app, assert, centre, flow, headerBoxes, mockAuth, pass } from "./lib.mjs"

const NEW_MOCK = process.env.TRIAGE_NEW_MOCK_URL
const THREAD_MOCK = process.env.TRIAGE_THREAD_MOCK_URL

const HOUR = 3_600_000
const DAY = 86_400_000

const THREADS = [
  { id: "e2e-card-a", title: "Weather station", opener: "Print the weather station case" },
  { id: "e2e-card-b", title: "Garden plan", opener: "Plan the beds for spring" },
]
const MESSAGES = ["Plan the sprint", "Notes from Tuesday", "Today's catch-up"]

const STARTED = "Rotate the greenhouse logs"
const TRIAGE_NEW = "Clean up the invoice folders"
const TRIAGE_THREAD = "Park the invoice for later"
const OLDER_THREAD = "Keep the gate open"

const count = (page, selector) => page.locator(selector).count()

const cardWith = (page, said) =>
  page.locator('[data-slot="thread-card"]').filter({ hasText: said }).first()

function sequence(page) {
  return page.evaluate(
    ([messages, threads]) => {
      const content = document.querySelector('[data-slot="message-scroller-content"]')
      if (!content) return []
      return [...content.children]
        .filter((child) => !child.hasAttribute("data-message-scroller-spacer"))
        .flatMap((child) => {
          const slot = child.getAttribute("data-slot")
          const said = child.textContent?.trim() ?? ""
          if (slot === "day-heading" || slot === "other") return []
          if (slot === "thread-card")
            return [`card:${threads.find((thread) => said.includes(thread.title))?.title ?? said}`]
          if (slot === "message-scroller-item")
            return [`message:${messages.find((message) => said.includes(message)) ?? said}`]
          return []
        })
    },
    [MESSAGES, THREADS],
  )
}

function seed(page) {
  return page.evaluate(
    async ([threads, messages, hour, day]) => {
      const { db, ensureMainThread, mainThreadId } = await import("/src/lib/db.ts")
      const profile = (await db.profiles.toArray())[0]
      await ensureMainThread(profile.id)
      const mainId = mainThreadId(profile.id)
      const now = Date.now()
      const times = [now - 3 * day, now - 2 * day, now - 2 * hour]
      await db.messages.bulkPut(
        messages.map((content, index) => ({
          id: `e2e-main-${index}`,
          conversationId: mainId,
          role: "user",
          content,
          status: "done",
          createdAt: times[index],
        })),
      )
      await db.conversations.bulkPut(
        threads.map(({ id, title }, index) => ({
          id,
          profileId: profile.id,
          title,
          titleEdited: true,
          hermesSessionId: `memento-${id}`,
          createdAt: index === 0 ? now - 2.5 * day : now - hour,
          updatedAt: now - hour,
          changedAt: now,
        })),
      )
      await db.messages.bulkPut(
        threads.map(({ id, opener }, index) => ({
          id: `${id}-open`,
          conversationId: id,
          role: "user",
          content: opener,
          status: "done",
          createdAt: (index === 0 ? now - 2.5 * day : now - hour) + 1,
        })),
      )
      await db.conversations.update(mainId, { createdAt: now - 4 * day })
      return mainId
    },
    [THREADS, MESSAGES, HOUR, DAY],
  )
}

async function useMock(page, profileId, mock, mainId) {
  await page.evaluate(
    async ([id, baseUrl]) => {
      const { db } = await import("/src/lib/db.ts")
      await db.profiles.update(id, { baseUrl })
    },
    [profileId, `${mock}/v1`],
  )
  await page.waitForFunction(
    async (baseUrl) => {
      const { db } = await import("/src/lib/db.ts")
      const profile = (await db.profiles.toArray())[0]
      return profile?.baseUrl === baseUrl
    },
    `${mock}/v1`,
    { timeout: 15_000 },
  )
  await page.waitForURL(`**/c/${mainId}`, { timeout: 15_000 })
  await page.locator("textarea").last().waitFor({ timeout: 15_000 })
}

async function mockChats(mock) {
  const response = await fetch(`${mock}/api/plugins/memento/chats`, { headers: mockAuth })
  if (!response.ok) return {}
  return (await response.json()).chats ?? {}
}

async function untilMockChat(page, until, mock, id, what) {
  return until(
    async () => {
      const found = (await mockChats(mock))[id]?.value
      if (found) return found
      await page
        .evaluate(() => import("/src/lib/sync.ts").then((sync) => sync.syncNow()))
        .catch(() => undefined)
      return null
    },
    30_000,
    `${what} (chat ${id}) in the ${mock} mock's list`,
  )
}

async function pluginReady(page, until, feature = "triage") {
  await until(
    () =>
      page.evaluate(async (feature) => {
        const { getActiveProfile } = await import("/src/lib/db.ts")
        const { serverConfig } = await import("/src/lib/connection.ts")
        const { hasPluginFeature } = await import("/src/lib/hermes.ts")
        const profile = await getActiveProfile()
        return profile ? hasPluginFeature(serverConfig(profile), feature) : false
      }, feature),
    20_000,
    `the app to read the plugin's ${feature} feature`,
  )
}

async function startedThread(page, mainPath, until) {
  const path = await until(
    async () => {
      const current = new URL(page.url()).pathname
      return current !== mainPath ? current : null
    },
    15_000,
    "/thread to open the thread it started",
  )
  return path.split("/").at(-1)
}

await flow(
  "bot-threads",
  async ({ page, profileId, send, until, shot }) => {
    const mainId = `main-${profileId}`
    const mainPath = `/c/${mainId}`

    await page.evaluate(async () => {
      const { db } = await import("/src/lib/db.ts")
      await db.settings.update("settings", { developer: true, botThreads: true })
    })
    await page.goto(`${app}/`)
    await page.waitForURL(`**${mainPath}`, { timeout: 15_000 })
    pass("the bot opens its Main thread")

    await seed(page)
    await until(
      async () => (await count(page, '[data-slot="thread-card"]')) === 2,
      15_000,
      "Main's cards",
    )
    assert.deepEqual(
      await sequence(page),
      [
        `message:${MESSAGES[0]}`,
        `card:${THREADS[0].title}`,
        `message:${MESSAGES[1]}`,
        `message:${MESSAGES[2]}`,
        `card:${THREADS[1].title}`,
      ],
      "each card sits where its thread began, between the messages written around it",
    )
    const card = cardWith(page, THREADS[0].title)
    assert.ok(
      (await card.textContent())?.includes(THREADS[0].opener),
      "the card shows the message that opened it",
    )
    await shot("main-cards")
    pass("Main draws its bot's threads as cards at their start times")

    await card.getByRole("link", { name: /View thread/ }).click()
    await page.waitForURL(`**/c/${THREADS[0].id}`, { timeout: 15_000 })
    await page.getByText(THREADS[0].opener).first().waitFor({ timeout: 15_000 })
    await page.getByRole("button", { name: `Back to Test bot` }).click()
    await page.waitForURL(`**${mainPath}`, { timeout: 15_000 })
    pass("tapping a card opens its thread, and back returns to Main")

    await send(`/thread ${STARTED}`)
    const threadId = await startedThread(page, mainPath, until)
    await page.getByText(STARTED).first().waitFor({ timeout: 15_000 })
    assert.notEqual(threadId, mainId, "/thread opened a thread of its own")
    await shot("thread-started")
    pass(`/thread with text opened a thread with that message`)

    await page.getByRole("button", { name: `Back to Test bot` }).click()
    await page.waitForURL(`**${mainPath}`, { timeout: 15_000 })
    await until(
      async () => (await count(page, '[data-slot="thread-card"]')) === 3,
      15_000,
      "the started thread's card",
    )
    const after = await sequence(page)
    assert.deepEqual(
      after.slice(0, 5),
      [
        `message:${MESSAGES[0]}`,
        `card:${THREADS[0].title}`,
        `message:${MESSAGES[1]}`,
        `message:${MESSAGES[2]}`,
        `card:${THREADS[1].title}`,
      ],
      "the cards already there keep their places",
    )
    assert.equal(after.at(-1)?.startsWith("card:"), true, "the newest card closes the flow")
    assert.equal(
      after.at(-1)?.includes(STARTED),
      true,
      "the started thread's card holds the message that opened it",
    )
    assert.equal(
      after.filter((entry) => entry.includes(STARTED)).length,
      1,
      "only the card carries it: /thread is never triaged",
    )
    assert.equal(await page.getByText(/Moved to/).count(), 0, "a /thread message is never triaged")
    await shot("main-started-card")
    pass("back on Main, the started thread's card sits at its start time")

    await useMock(page, profileId, NEW_MOCK, mainId)
    await untilMockChat(page, until, NEW_MOCK, mainId, "Main")
    await pluginReady(page, until)
    await send(TRIAGE_NEW)
    await until(
      async () => {
        const carrying = await page.evaluate(() =>
          [...document.querySelectorAll('[data-slot="thread-card"]')].some((card) =>
            card.querySelector('button[aria-label="Undo"]'),
          ),
        )
        return carrying ? "a card carrying Undo" : null
      },
      25_000,
      "a card carrying Undo",
    )
    const newFlow = await sequence(page)
    assert.equal(
      newFlow.filter((entry) => entry.startsWith("message:") && entry.includes(TRIAGE_NEW)).length,
      0,
      "the message is no longer a message in Main: it left as its thread's card",
    )
    assert.equal(newFlow.at(-1)?.startsWith("card:"), true, "the card sits where the message left")
    assert.equal(
      await page.evaluate(
        () =>
          [...document.querySelectorAll('[data-slot="thread-card"]')].filter((card) =>
            card.querySelector('button[aria-label="Undo"]'),
          ).length,
      ),
      1,
      "one card carries the move's Undo",
    )
    assert.equal(
      await page.getByText(/Moved to/).count(),
      0,
      "a triage-opened thread draws no Moved marker",
    )
    await until(
      async () => (await page.locator("[data-sonner-toast]").count()) === 0,
      15_000,
      "the move's toast to go",
    )
    assert.equal(
      await page
        .locator('[data-slot="thread-card"]')
        .last()
        .getByRole("button", { name: "Undo" })
        .count(),
      1,
      "the card still offers Undo once the toast has gone",
    )
    await shot("triage-new")
    pass("triage's new thread draws a card with Undo and no marker")

    await useMock(page, profileId, THREAD_MOCK, mainId)
    await untilMockChat(page, until, THREAD_MOCK, mainId, "Main")
    await pluginReady(page, until)
    await send(`/thread ${OLDER_THREAD}`)
    const olderId = await startedThread(page, mainPath, until)
    await page.getByText(OLDER_THREAD).first().waitFor({ timeout: 15_000 })
    await page.getByRole("button", { name: `Back to Test bot` }).click()
    await page.waitForURL(`**${mainPath}`, { timeout: 15_000 })
    await untilMockChat(page, until, THREAD_MOCK, olderId, "the older thread")

    await send(TRIAGE_THREAD)
    const marker = page
      .locator("p")
      .filter({ hasText: /Moved to/ })
      .first()
    await marker.waitFor({ timeout: 25_000 })
    const link = marker.locator(`a[href="/c/${olderId}"]`)
    assert.equal(await link.count(), 1, "the marker links the older thread it moved into")
    assert.equal(
      await page.evaluate((said) => {
        const content = document.querySelector('[data-slot="message-scroller-content"]')
        return (content?.textContent ?? "").split(said).length - 1
      }, TRIAGE_THREAD),
      1,
      "the marker draws one copy",
    )
    assert.equal(
      await page.evaluate(
        () =>
          [...document.querySelectorAll('[data-slot="thread-card"]')].filter((card) =>
            card.querySelector('button[aria-label="Undo"]'),
          ).length,
      ),
      0,
      "no thread's card carries the move: it is a marker, not a card",
    )
    const threadFlow = await sequence(page)
    assert.equal(
      threadFlow.filter((entry) => entry.startsWith("message:") && entry.includes(TRIAGE_THREAD))
        .length,
      0,
      "the message itself is drawn by the marker, not as a message",
    )
    await until(
      async () => (await page.locator("[data-sonner-toast]").count()) === 0,
      15_000,
      "the move's toast to go",
    )
    await shot("triage-thread")
    pass("a message moved into an older thread keeps its Moved marker with its link")

    await page.setViewportSize({ width: 768, height: 900 })
    await page.emulateMedia({ colorScheme: "dark" })
    await until(
      () => page.evaluate(() => document.documentElement.classList.contains("dark")),
      15_000,
      "the dark theme",
    )
    await until(
      async () => (await count(page, '[data-slot="thread-card"]')) > 0,
      15_000,
      "a thread's card on a tablet in dark mode",
    )
    assert.equal(
      await page.locator('button[aria-label="Undo"]').count(),
      1,
      "the move's Undo is still found",
    )
    assert.equal(
      (await count(page, '[data-slot="day-heading"]')) > 0,
      true,
      "Main's day heading still heads the flow",
    )
    await marker.waitFor({ timeout: 15_000 })
    await shot("tablet-dark")
    pass("on a tablet in dark mode Main still draws its cards, its heading and the move's line")

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: "light" })
    await until(
      async () => (await count(page, '[data-slot="header-row"]')) === 2,
      15_000,
      "Main and a thread, side by side on a laptop",
    )
    // The started thread's card, in the Main that stays on screen beside whatever the pane holds.
    const startedCard = cardWith(page, STARTED)
    await startedCard.getByRole("link", { name: /View thread/ }).click()
    await page.waitForURL(`**/c/${threadId}`, { timeout: 15_000 })
    await page.waitForTimeout(400)
    const held = await page.locator('[data-slot="header-row"]').nth(1).elementHandle()
    // Naming the same thread from its card again — which is what a tap on a thread that is already
    // the screen does — must draw no new pane: redrawing it is what made the thread flicker.
    await startedCard.getByRole("link", { name: /View thread/ }).click()
    await page.waitForTimeout(400)
    assert.equal(
      new URL(page.url()).pathname,
      `/c/${threadId}`,
      "the address stays where the thread already is",
    )
    assert.equal(
      await page.evaluate(
        (node) => document.querySelectorAll('[data-slot="header-row"]')[1] === node,
        held,
      ),
      true,
      "and the pane the thread was in is the pane it is still in: nothing was drawn anew",
    )
    const heads = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="header-row"]')].map((row) => ({
        title: row.querySelector('[data-slot="header-title"]')?.textContent ?? "",
        controls: [...row.querySelectorAll("button")].map(
          (button) => button.getAttribute("aria-label") ?? "",
        ),
        pictures: row.querySelectorAll('[role="img"]').length,
      })),
    )
    assert.equal(heads.length, 2, "both panes draw a header")
    assert.equal(heads[0].title, "Test bot", 'Main reads as the bot, not as "Main"')
    assert.notEqual(heads[1].title, "", "the thread beside it reads with its own title")
    assert.notEqual(heads[1].title, "Test bot", "which is the thread's, not the bot's")
    assert.equal(
      heads[1].controls.some((label) => label.startsWith("Back to") || label === "Close thread"),
      false,
      "the thread beside its bot carries no control of its own",
    )
    assert.deepEqual(
      heads.map((head) => head.pictures),
      [1, 0],
      "Main keeps the bot's picture, and the thread beside it carries none",
    )
    const boxes = await headerBoxes(page, 1)
    assert.ok(
      Math.abs(centre(boxes.title) - centre(boxes.row)) <= 2,
      `the thread's title sits on its pane's centre (title at ${Math.round(centre(boxes.title))}, row at ${Math.round(centre(boxes.row))})`,
    )
    assert.ok(
      Math.abs(boxes.actions.right - boxes.row.right) <= 2,
      `the thread's actions end on the row's right edge (${Math.round(boxes.actions.right)} against ${Math.round(boxes.row.right)})`,
    )
    await shot("laptop")
    pass(
      "on a laptop the thread beside Main carries no control of its own, and naming it changes nothing",
    )
  },
  { viewport: { width: 390, height: 844 } },
)
