import { addBot, app, assert, centred, flow, mockAuth, pass, readHeader, settled } from "./lib.mjs"

const NEW_MOCK = process.env.TRIAGE_NEW_MOCK_URL
const THREAD_MOCK = process.env.TRIAGE_THREAD_MOCK_URL

const HOUR = 3_600_000
const DAY = 86_400_000

const THREADS = [
  { id: "e2e-card-a", title: "Weather station", opener: "Print the weather station case" },
  { id: "e2e-card-b", title: "Garden plan", opener: "Plan the beds for spring" },
]
const MESSAGES = ["Plan the sprint", "Notes from Tuesday", "Today's catch-up"]
const LONG_NOTE = "A note only the weather thread holds"
const LONG_MESSAGES = 24

const SECOND_BOT = "Second bot"
const SECOND_MESSAGES = ["Stack the firewood", "Twenty logs by the shed", "The axe is put away"]
// The second bot's own thread: a bot switch has a thread lane to swap as well as Main.
const SECOND_THREAD = { id: "e2e-second-thread", title: "Firewood stack" }
const SECOND_THREAD_SAY = "A note only the second bot's thread holds"

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
        .filter((child) => child.hasAttribute("data-slot"))
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

function seed(
  page,
  {
    threads = THREADS,
    messages = MESSAGES,
    hour = HOUR,
    day = DAY,
    long = LONG_MESSAGES,
    note = LONG_NOTE,
  } = {},
) {
  return page.evaluate(
    async ({ threads, messages, hour, day, long, note }) => {
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
    { threads, messages, hour, day, long, note },
  )
}

function watchFrames(page, { lanes }) {
  return page.evaluate(
    async ({ lanes }) => {
      const { BOTS } = await import("/src/components/bots.tsx")
      const { GREETINGS } = await import("/src/lib/greeting.ts")
      const { SETUP_COPY } = await import("/src/routes/chat.tsx")
      const hero = [...BOTS.flatMap((bot) => bot.lines), ...GREETINGS]
      const rowsIn = (content) =>
        content ? [...content.children].filter((child) => child.hasAttribute("data-slot")) : []
      const sample = (pane, chats) => {
        const root = document.querySelector(`[data-pane="${pane}"]`)
        if (!root)
          return {
            title: "",
            match: -1,
            whole: false,
            waiting: true,
            absent: true,
            wrong: [],
            held: false,
            empty: false,
            scrollTop: 0,
            atEnd: false,
            bottom: 0,
            count: 0,
          }
        const text = root.textContent ?? ""
        const title = root.querySelector('[data-slot="header-title"]')?.textContent?.trim() ?? ""
        const viewport = root.querySelector('[data-slot="message-scroller-viewport"]')
        const content = root.querySelector('[data-slot="message-scroller-content"]')
        const mine = rowsIn(content)
        // The chat being left is known by its words; the one asked for by its title over rows of its
        // own, since it draws its newest rows first and the words may be in the ones that follow.
        const match = chats.findIndex(
          (chat, index) =>
            title === chat.title && (index === 0 ? text.includes(chat.says) : mine.length > 0),
        )
        const whole = match >= 0 && text.includes(chats[match].says)
        // The pane waiting on the chat asked for: inert, untitled, and carrying neither chat.
        const waiting =
          match < 0 &&
          root.hasAttribute("inert") &&
          !title &&
          !chats.some((chat) => text.includes(chat.says))
        // The scroller holds itself back while it places its content: a `data-pending-scroll`
        // viewport is `visibility: hidden`, so the browser paints none of that frame, and its
        // items are still at their `content-visibility: auto` estimate rather than their size.
        // A frame nobody sees is not a frame the switch paints.
        const held = viewport ? getComputedStyle(viewport).visibility === "hidden" : false
        return {
          title,
          match,
          whole,
          waiting,
          absent: false,
          held,
          // A bot's pane saying it has no threads: what an unanswered list must never be read as.
          empty: Boolean(root.querySelector('[data-slot="bot-pane-empty"]')),
          wrong: [
            text.includes(SETUP_COPY) && "the setup copy",
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
          bottom:
            !held && match === 1 && mine.length
              ? Math.round(mine.at(-1)?.getBoundingClientRect().bottom ?? 0)
              : 0,
          count: mine.length,
        }
      }
      const same = (one, other) =>
        Boolean(one && other) &&
        one.title === other.title &&
        one.match === other.match &&
        one.whole === other.whole &&
        one.waiting === other.waiting &&
        one.held === other.held &&
        one.empty === other.empty &&
        one.scrollTop === other.scrollTop &&
        one.atEnd === other.atEnd &&
        one.bottom === other.bottom &&
        one.count === other.count &&
        one.wrong.length === other.wrong.length
      window.__frames = Object.fromEntries(lanes.map((lane) => [lane.pane, []]))
      window.__quiet = 0
      window.__watching = true
      const before = {}
      const tick = () => {
        if (!window.__watching) return
        let quiet = true
        for (const lane of lanes) {
          const frame = sample(lane.pane, lane.chats)
          quiet = quiet && same(before[lane.pane], frame)
          before[lane.pane] = frame
          window.__frames[lane.pane].push(frame)
        }
        window.__quiet = quiet ? window.__quiet + 1 : 0
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    { lanes },
  )
}

function stopFrames(page) {
  return page.evaluate(
    () =>
      new Promise((done) => {
        window.__watching = false
        requestAnimationFrame(() => requestAnimationFrame(() => done(window.__frames ?? [])))
      }),
  )
}

async function ready(page, what, pane = "route") {
  const seen = await page.evaluate(async (pane) => {
    const { SETUP_COPY } = await import("/src/routes/chat.tsx")
    const root = document.querySelector(`[data-pane="${pane}"]`)
    const content = root?.querySelector('[data-slot="message-scroller-content"]')
    return {
      found: Boolean(root),
      title: root?.querySelector('[data-slot="header-title"]')?.textContent?.trim() ?? "",
      items: content
        ? [...content.children].filter((child) => child.hasAttribute("data-slot")).length
        : 0,
      text: root?.textContent ?? "",
      setup: SETUP_COPY,
    }
  }, pane)
  assert.ok(seen.found, `${what}: the ${pane} pane is on screen`)
  assert.ok(
    seen.title && seen.title !== "New chat",
    `${what}: the chat draws a title of its own (saw "${seen.title}")`,
  )
  assert.ok(seen.items > 0, `${what}: the chat draws its content (${seen.items} items)`)
  assert.equal(seen.text.includes(seen.setup), false, `${what}: the chat draws no setup copy`)
  return seen
}

function assertSwitchFrames(frames, { what }) {
  assert.ok(frames.length > 4, `${what}: frames were sampled (${frames.length})`)
  assert.deepEqual(
    frames.filter((frame) => frame.wrong.length).map((frame) => frame.wrong.join(", ")),
    [],
    `${what}: no frame paints the setup copy, a "New chat" header or the new-chat hero`,
  )
  const seen = [...new Set(frames.map((frame) => frame.title || "(no title)"))]
  assert.deepEqual(
    frames.filter((frame) => frame.match < 0 && !frame.waiting),
    [],
    `${what}: every frame is one of the two chats, whole, or the pane waiting on the next (saw ${seen.join(" → ")})`,
  )
  assert.equal(frames[0].match, 0, `${what}: the first frame is the chat being left`)
  const left = frames.findIndex((frame) => frame.match !== 0)
  assert.deepEqual(
    frames
      .slice(left)
      .filter((frame) => frame.match === 0)
      .map((frame) => frame.title),
    [],
    `${what}: once a frame has left the chat, it is never drawn again`,
  )
  const landed = frames.findIndex((frame) => frame.match === 1 && !frame.held)
  assert.ok(landed > 0, `${what}: the chat asked for lands after the one left`)
  assert.equal(frames.at(-1).match, 1, `${what}: and it is still the one on screen`)
  assert.ok(frames.at(-1).whole, `${what}: and drawn whole once the switch settles`)
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

const SETTLED_FRAMES = 3

/**
 * A second pane sampled through the same switch — the thread beside the chat — must only ever draw a
 * chat of its own across it: the one it had, the one the bot asked for keeps, or nothing while that
 * one answers. Never a frame that calls the bot thread-less while its list is still answering, and
 * never the thread it had once it has left it.
 */
function assertLaneFrames(frames, { what }) {
  assert.ok(frames.length > 4, `${what}: frames were sampled (${frames.length})`)
  const seen = [...new Set(frames.map((frame) => frame.title || "(no title)"))]
  assert.deepEqual(
    frames
      .filter((frame) => frame.match < 0 && !frame.waiting)
      .map((frame) => frame.title || "(no title)"),
    [],
    `${what}: every frame is one of the two chats, whole, or waiting on the next (saw ${seen.join(" → ")})`,
  )
  const left = frames.findIndex((frame) => frame.match !== 0)
  assert.deepEqual(
    frames
      .slice(left)
      .filter((frame) => frame.match === 0)
      .map((frame) => frame.title),
    [],
    `${what}: once a frame has left the thread, it is never drawn again`,
  )
  assert.deepEqual(
    frames.filter((frame) => frame.empty).map((frame) => frame.title),
    [],
    `${what}: no frame says the bot has no threads`,
  )
  assert.equal(frames[0].match, 0, `${what}: the first frame is the chat being left`)
  assert.equal(frames.at(-1).match, 1, `${what}: and the last is the one it asked for`)
}

async function sampleSwitch(page, { chats, pane = "route", act, what, also = [] }) {
  const lanes = [{ pane, chats }, ...also]
  await watchFrames(page, { lanes })
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  )
  await act()
  await page.waitForFunction(
    ({ pane, title }) =>
      document
        .querySelector(`[data-pane="${pane}"]`)
        ?.querySelector('[data-slot="header-title"]')
        ?.textContent?.trim() === title,
    { pane, title: chats[1].title },
    { timeout: 15_000 },
  )
  // A long chat opens on its newest rows and draws the rest a beat later: the switch has settled
  // once the chat is whole, and the frames sampled until then are the ones that must not move.
  await page.waitForFunction(
    ({ pane, says }) =>
      document.querySelector(`[data-pane="${pane}"]`)?.textContent?.includes(says),
    { pane, says: chats[1].says },
    { timeout: 15_000 },
  )
  await settled(page)
  await page.waitForFunction((tail) => window.__quiet >= tail, SETTLED_FRAMES, {
    timeout: 15_000,
    polling: "raf",
  })
  const frames = await stopFrames(page)
  assertSwitchFrames(frames[pane], { what })
  for (const lane of also)
    assertLaneFrames(frames[lane.pane], { what: `${what}, the ${lane.pane} lane` })
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

/**
 * A bot's own thread, the message in it, and the pane's memory of opening it: a bot switch then has
 * two lanes to swap, Main and the thread beside it.
 */
function threadFor(page, profileId, { id, title, says }) {
  return page.evaluate(
    async ({ profileId, id, title, says }) => {
      const { db } = await import("/src/lib/db.ts")
      const { lastThreadKey } = await import("/src/lib/threads.ts")
      const now = Date.now()
      await db.conversations.put({
        id,
        profileId,
        title,
        titleEdited: true,
        hermesSessionId: `memento-${id}`,
        createdAt: now - 2 * 3_600_000,
        updatedAt: now - 3_600_000,
        changedAt: now,
      })
      await db.messages.put({
        id: `${id}-open`,
        conversationId: id,
        role: "user",
        content: says,
        status: "done",
        createdAt: now - 2 * 3_600_000 + 1,
      })
      localStorage.setItem(lastThreadKey(profileId), id)
    },
    { profileId, id, title, says },
  )
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
    await until(
      async () => (await count(page, '[data-pane="thread"] [data-slot="header-title"]')) === 1,
      15_000,
      "the thread's own pane beside Main",
    )
    // The pane reads as this thread before it is compared: until the address's thread is the one it
    // knows, the lane is still the thread it had, and naming this one then lands a pane of its own.
    await until(
      () =>
        page.evaluate((started) => {
          const pane = document.querySelector('[data-pane="thread"]')
          const title = pane?.querySelector('[data-slot="header-title"]')?.textContent ?? ""
          return Boolean(pane && !pane.hasAttribute("inert") && title.includes(started))
        }, STARTED),
      15_000,
      "the started thread's own pane, answered rather than held",
    )
    await settled(page)
    const held = await page.locator('[data-slot="header-row"]').nth(1).elementHandle()
    // Naming the same thread from its card again — which is what a tap on a thread that is already
    // the screen does — must draw no new pane: redrawing it is what made the thread flicker.
    await startedCard.getByRole("link", { name: /View thread/ }).click()
    await settled(page)
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
    const boxes = await readHeader(page.locator('[data-slot="header-row"]').nth(1))
    centred(boxes, "the thread beside Main")
    await ready(page, "the laptop in light mode", "main")
    await shot("laptop")
    pass(
      "on a laptop the thread beside Main carries no control of its own, and naming it changes nothing",
    )

    const secondBot = await addBot(page, { name: SECOND_BOT, messages: SECOND_MESSAGES })
    const secondMain = `/c/main-${secondBot}`
    // The second bot keeps a thread beside its Main too, so the switch has two lanes to read.
    await threadFor(page, secondBot, { ...SECOND_THREAD, says: SECOND_THREAD_SAY })
    const secondRow = page.locator(`aside a[href="${secondMain}"]`).first()
    await secondRow.waitFor({ timeout: 15_000 })
    await until(
      async () => (await secondRow.textContent())?.includes(SECOND_BOT),
      15_000,
      "the second bot's row in the sidebar",
    )
    // What the thread beside Main is called now, so the lane's frames can be read as chats.
    const threadTitle = await page.evaluate(
      () =>
        document
          .querySelectorAll('[data-slot="header-row"]')[1]
          ?.querySelector('[data-slot="header-title"]')
          ?.textContent?.trim() ?? "",
    )
    assert.ok(
      threadTitle,
      `the thread beside Main reads with a title to swap (saw "${threadTitle}")`,
    )
    await sampleSwitch(page, {
      chats: [
        { title: "Test bot", says: MESSAGES[2] },
        { title: SECOND_BOT, says: SECOND_MESSAGES.at(-1) },
      ],
      what: "the sidebar's bot switch",
      pane: "main",
      act: () => secondRow.click(),
      // The thread beside Main swaps with it: the old bot's thread or the new bot's, nothing else.
      also: [
        {
          pane: "thread",
          chats: [
            { title: threadTitle, says: STARTED },
            { title: SECOND_THREAD.title, says: SECOND_THREAD_SAY },
          ],
        },
      ],
    })
    await page.waitForURL(`**${secondMain}`, { timeout: 15_000 })
    pass("switching bots lands the other bot's Main with no frame between them")

    await sampleSwitch(page, {
      chats: [
        { title: SECOND_BOT, says: SECOND_MESSAGES.at(-1) },
        { title: "Test bot", says: MESSAGES[2] },
      ],
      what: "and back to the first bot",
      pane: "main",
      act: () => page.locator(`aside a[href="${mainPath}"]`).first().click(),
      also: [
        {
          pane: "thread",
          chats: [
            { title: SECOND_THREAD.title, says: SECOND_THREAD_SAY },
            { title: threadTitle, says: STARTED },
          ],
        },
      ],
    })
    await page.waitForURL(`**${mainPath}`, { timeout: 15_000 })
    pass("and switching back paints no frame but the two bots' Mains and their threads")

    await page.emulateMedia({ colorScheme: "dark" })
    await until(
      () => page.evaluate(() => document.documentElement.classList.contains("dark")),
      15_000,
      "the dark theme on a laptop",
    )
    await ready(page, "the laptop in dark mode", "main")
    await shot("laptop-dark")
    pass("the laptop in dark mode draws the chat ready")
  },
  { viewport: { width: 390, height: 844 } },
)
