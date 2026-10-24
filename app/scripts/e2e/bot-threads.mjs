import { app, assert, centred, flow, mock as liveMock, mockAuth, pass, readHeader } from "./lib.mjs"

const NEW_MOCK = process.env.TRIAGE_NEW_MOCK_URL
const THREAD_MOCK = process.env.TRIAGE_THREAD_MOCK_URL

const HOUR = 3_600_000
const DAY = 86_400_000

const THREADS = [
  { id: "e2e-card-a", title: "Weather station", opener: "Print the weather station case" },
  { id: "e2e-card-b", title: "Garden plan", opener: "Plan the beds for spring" },
]
const MESSAGES = ["Plan the sprint", "Notes from Tuesday", "Today's catch-up"]
// A thread long enough that its scroller has somewhere to be: a switch's first content frame is its
// final position only where there is a position to place.
const LONG_NOTE = "A note only the weather thread holds"
const LONG_MESSAGES = 24

const SECOND_BOT = "Second bot"
// Three lines, so the sidebar's bot switch is measured over a chat that fits its pane at every
// width: the long thread below is where a scroller's own placement is put under strain.
const SECOND_MESSAGES = ["Stack the firewood", "Twenty logs by the shed", "The axe is put away"]

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
    async ([threads, messages, hour, day, long, note]) => {
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
      // The first thread's own flow, long enough to have scrolled somewhere when it opens.
      const began = now - 2.5 * day + 2
      await db.messages.bulkPut(
        Array.from({ length: long }, (_, index) => ({
          id: `${threads[0].id}-${index}`,
          conversationId: threads[0].id,
          role: index % 2 ? "assistant" : "user",
          content: index === 12 ? note : `Greenhouse note ${index + 1}`,
          status: "done",
          createdAt: began + index * 1000,
        })),
      )
      await db.conversations.update(mainId, { createdAt: now - 4 * day })
      return mainId
    },
    [THREADS, MESSAGES, HOUR, DAY, LONG_MESSAGES, LONG_NOTE],
  )
}

/**
 * A second bot with a Main thread of its own, so the sidebar's bot switch has two chats to land
 * between. It points at the same mock: no message is sent to it, so nothing else is needed.
 */
function seedSecondBot(page) {
  return page.evaluate(
    async ([name, messages, mock, hour]) => {
      const { addProfile, db, ensureMainThread, mainThreadId } = await import("/src/lib/db.ts")
      const profile = await addProfile({
        name,
        baseUrl: `${mock}/v1`,
        apiKey: "mock-key",
        model: "hermes-agent",
      })
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
    [SECOND_BOT, SECOND_MESSAGES, liveMock, HOUR],
  )
}

/**
 * Records what the browser paints from now on, one sample a frame, for the chat surface at `index`:
 * its header title, whether the frame is one of `chats` whole, the wrong states a switch must never
 * paint, and its scroller's place and content. `chats` is read as [the chat being left, the one
 * asked for], each `{ title, says }` with a line only that chat draws.
 */
function watchFrames(page, { chats, index = 0 }) {
  return page.evaluate(
    async ({ chats, index }) => {
      const { BOTS } = await import("/src/components/bots.tsx")
      const greetings = ["Good morning.", "Good afternoon.", "Good evening."]
      const hero = [...BOTS.flatMap((bot) => bot.lines), ...greetings]
      const sample = () => {
        // The chat's own slot, or the main pane on a build that has no slot of its own.
        const root =
          document.querySelectorAll('[data-slot="chat-pane"]')[index] ??
          (index === 0 ? document.querySelector("main") : undefined)
        if (!root)
          return {
            title: "",
            match: -1,
            wrong: ["no chat"],
            held: false,
            scrollTop: 0,
            atEnd: false,
            bottom: 0,
            count: 0,
          }
        const text = root.textContent ?? ""
        const title = root.querySelector('[data-slot="header-title"]')?.textContent?.trim() ?? ""
        const viewport = root.querySelector('[data-slot="message-scroller-viewport"]')
        const content = root.querySelector('[data-slot="message-scroller-content"]')
        return {
          title,
          match: chats.findIndex((chat) => title === chat.title && text.includes(chat.says)),
          // The scroller holds itself back while it places its content: a `data-pending-scroll`
          // viewport is `visibility: hidden`, so the browser paints none of that frame, and its
          // items are still at their `content-visibility: auto` estimate rather than their size.
          // A frame nobody sees is not a frame the switch paints.
          held: viewport ? getComputedStyle(viewport).visibility === "hidden" : false,
          wrong: [
            text.includes("Point Gots at your Hermes Agent API server") && "the setup copy",
            title === "New chat" && 'a "New chat" header',
            hero.some((line) => text.includes(line)) && "the new-chat hero",
          ].filter(Boolean),
          // Where the reader is: the scroller's offset, whether it sits at the end of its content,
          // and where the last thing drawn ends on screen. A bottom-anchored scroller's offset
          // follows its content's height as lazily laid-out items are measured, so the offset alone
          // says nothing about a jump: what must not move is the last item's own place.
          scrollTop: viewport ? Math.round(viewport.scrollTop) : 0,
          atEnd: viewport
            ? Math.abs(viewport.scrollTop + viewport.clientHeight - viewport.scrollHeight) <= 2
            : false,
          bottom: content
            ? Math.round(
                [...content.children]
                  .filter((child) => !child.hasAttribute("data-message-scroller-spacer"))
                  .at(-1)
                  ?.getBoundingClientRect().bottom ?? 0,
              )
            : 0,
          count: content ? content.children.length : 0,
        }
      }
      window.__frames = []
      window.__watching = true
      const tick = () => {
        if (!window.__watching) return
        window.__frames.push(sample())
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    { chats, index },
  )
}

/** Stops the frame recording and answers what it saw, with the frame it is on now. */
function stopFrames(page) {
  return page.evaluate(
    () =>
      new Promise((done) => {
        window.__watching = false
        requestAnimationFrame(() =>
          requestAnimationFrame(() => done(window.__frames ?? [])),
        )
      }),
  )
}

/** Asserts the chat surface at `what` is drawing a chat ready — its own title and its content. */
async function ready(page, what) {
  const seen = await page.evaluate(() => {
    const pane = document.querySelector('[data-slot="chat-pane"]') ?? document.querySelector("main")
    const content = pane?.querySelector('[data-slot="message-scroller-content"]')
    return {
      title: pane?.querySelector('[data-slot="header-title"]')?.textContent?.trim() ?? "",
      items: content ? content.children.length : 0,
      text: pane?.textContent ?? "",
    }
  })
  assert.ok(
    seen.title && seen.title !== "New chat",
    `${what}: the chat draws a title of its own (saw "${seen.title}")`,
  )
  assert.ok(seen.items > 0, `${what}: the chat draws its content (${seen.items} items)`)
  assert.equal(
    seen.text.includes("Point Gots at your Hermes Agent API server"),
    false,
    `${what}: the chat draws no setup copy`,
  )
  return seen
}

/**
 * Every frame a switch painted is one of its two chats whole — never a loading state, and never the
 * one it left with the one it asked for's title — and the chat it lands on keeps the reader where
 * the first frame that showed it put them: at the end, and still.
 *
 * "The first content frame" is the first one the browser paints with the incoming chat's content:
 * the scroller's own hold (`data-pending-scroll`, which is `visibility: hidden`) covers the frame
 * it mounts on, where its items are still at their `content-visibility` estimate. That frame is
 * excluded — nowhere else is one: a chat that held itself again after being shown fails here.
 */
function assertSwitchFrames(frames, { what }) {
  assert.ok(frames.length > 4, `${what}: frames were sampled (${frames.length})`)
  assert.deepEqual(
    frames.filter((frame) => frame.wrong.length).map((frame) => frame.wrong.join(", ")),
    [],
    `${what}: no frame paints the setup copy, a "New chat" header or the new-chat hero`,
  )
  const seen = [...new Set(frames.map((frame) => frame.title || "(no title)"))]
  assert.deepEqual(
    frames.filter((frame) => frame.match < 0),
    [],
    `${what}: every frame is one of the two chats, whole (saw ${seen.join(" → ")})`,
  )
  assert.equal(frames[0].match, 0, `${what}: the first frame is the chat being left`)
  const landed = frames.findIndex((frame) => frame.match === 1 && !frame.held)
  assert.ok(landed > 0, `${what}: the chat asked for lands after the one left`)
  assert.equal(frames.at(-1).match, 1, `${what}: and it is still the one on screen`)
  const after = frames.slice(landed)
  assert.deepEqual(
    after.filter((frame) => frame.held).map((frame) => frame.title),
    [],
    `${what}: the chat asked for never goes back into its hold once it is on screen`,
  )
  const ends = after.filter((frame) => !frame.atEnd)
  assert.equal(
    ends.length,
    0,
    `${what}: every frame from the first content one is placed at the end of its content (${ends
      .map((frame) => `${frame.scrollTop} of ${frame.count}`)
      .join(", ")})`,
  )
  const bottoms = after.map((frame) => frame.bottom)
  const drift = Math.max(...bottoms) - Math.min(...bottoms)
  assert.ok(
    drift <= 1,
    `${what}: the scroller's position never moves after the first content frame (last item at ${bottoms.join(" → ")})`,
  )
  return { scrollTop: after[0].scrollTop, frames: frames.length }
}

/**
 * Samples a switch: records frames, runs `act`, waits for the chat asked for to be on screen, lets
 * the fade run out, then asserts what was painted and where its scroller stood.
 */
async function sampleSwitch(page, { chats, index = 0, act, what }) {
  await watchFrames(page, { chats, index })
  // Two frames first, so the recording opens on the chat being left rather than the click's own.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  )
  await act()
  await page.waitForFunction(
    ({ title, index }) =>
      document
        .querySelectorAll('[data-slot="chat-pane"]')
        [index]?.querySelector('[data-slot="header-title"]')
        ?.textContent?.trim() === title,
    { title: chats[1].title, index },
    { timeout: 15_000 },
  )
  // A placement after the first content frame, and the swap's fade, both land inside this window.
  await page.waitForTimeout(400)
  const frames = await stopFrames(page)
  assertSwitchFrames(frames, { what })
  return frames
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

    // A card's thread opens as one change: what the browser paints between the two chats is only
    // ever one of them, and the thread's scroller makes no move after its first content frame.
    await sampleSwitch(page, {
      chats: [
        { title: "Test bot", says: MESSAGES[2] },
        { title: THREADS[0].title, says: LONG_NOTE },
      ],
      what: "a card's thread opens",
      act: () => card.getByRole("link", { name: /View thread/ }).click(),
    })
    await page.waitForURL(`**/c/${THREADS[0].id}`, { timeout: 15_000 })
    await page.getByText(THREADS[0].opener).first().waitFor({ timeout: 15_000 })
    await shot("thread-open")
    pass("a card opens its thread with no frame between the two chats but the two chats")

    // Back is the same switch the other way, over the same two chats.
    await sampleSwitch(page, {
      chats: [
        { title: THREADS[0].title, says: LONG_NOTE },
        { title: "Test bot", says: MESSAGES[2] },
      ],
      what: "back from a thread lands Main",
      act: () => page.getByRole("button", { name: `Back to Test bot` }).click(),
    })
    await page.waitForURL(`**${mainPath}`, { timeout: 15_000 })
    pass("back returns to Main through no frame but Main and the thread it left")

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

    // The same phone, read as it stands and then in the other theme: the chat is on screen whole,
    // not a loading state, at 390px either way.
    await ready(page, "the phone in light mode")
    await shot("phone-light")
    pass("the phone in light mode draws the chat ready")

    await page.emulateMedia({ colorScheme: "dark" })
    await until(
      () => page.evaluate(() => document.documentElement.classList.contains("dark")),
      15_000,
      "the dark theme on a phone",
    )
    await ready(page, "the phone in dark mode")
    await shot("phone-dark")
    pass("the phone in dark mode draws the chat ready")

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
    await ready(page, "the tablet in dark mode")
    await shot("tablet-dark")
    pass("on a tablet in dark mode Main still draws its cards, its heading and the move's line")

    await page.emulateMedia({ colorScheme: "light" })
    await until(
      () => page.evaluate(() => !document.documentElement.classList.contains("dark")),
      15_000,
      "the light theme on a tablet",
    )
    await ready(page, "the tablet in light mode")
    await shot("tablet-light")
    pass("the same tablet in light mode draws the chat ready")

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
    assert.equal(heads[0].title, "Test bot", "Main reads as the bot, not as \"Main\"")
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
    const boxes = await readHeader(page.locator('[data-slot="header-row"]').nth(1))
    centred(boxes, "the thread beside Main")
    await ready(page, "the laptop in light mode")
    await shot("laptop")
    pass(
      "on a laptop the thread beside Main carries no control of its own, and naming it changes nothing",
    )

    // A bot switch is the same change over two bots' Main threads: the sidebar's row is the tap, and
    // every frame it paints is one of the two Mains, whole.
    const secondBot = await seedSecondBot(page)
    const secondMain = `/c/main-${secondBot}`
    const secondRow = page.locator(`aside a[href="${secondMain}"]`).first()
    await secondRow.waitFor({ timeout: 15_000 })
    await until(
      async () => (await secondRow.textContent())?.includes(SECOND_BOT),
      15_000,
      "the second bot's row in the sidebar",
    )
    await sampleSwitch(page, {
      chats: [
        { title: "Test bot", says: MESSAGES[2] },
        { title: SECOND_BOT, says: SECOND_MESSAGES.at(-1) },
      ],
      what: "the sidebar's bot switch",
      act: () => secondRow.click(),
    })
    await page.waitForURL(`**${secondMain}`, { timeout: 15_000 })
    pass("switching bots lands the other bot's Main with no frame between them")

    await sampleSwitch(page, {
      chats: [
        { title: SECOND_BOT, says: SECOND_MESSAGES.at(-1) },
        { title: "Test bot", says: MESSAGES[2] },
      ],
      what: "and back to the first bot",
      act: () => page.locator(`aside a[href="${mainPath}"]`).first().click(),
    })
    await page.waitForURL(`**${mainPath}`, { timeout: 15_000 })
    pass("and switching back paints no frame but the two bots' Mains")

    await page.emulateMedia({ colorScheme: "dark" })
    await until(
      () => page.evaluate(() => document.documentElement.classList.contains("dark")),
      15_000,
      "the dark theme on a laptop",
    )
    await ready(page, "the laptop in dark mode")
    await shot("laptop-dark")
    pass("the laptop in dark mode draws the chat ready")
  },
  { viewport: { width: 390, height: 844 } },
)
