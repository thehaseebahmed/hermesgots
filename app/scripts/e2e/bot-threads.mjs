import { app, assert, cardOf, flow, mockAuth, pass, settled, writeTranscript } from "./lib.mjs"

const NEW_MOCK = process.env.TRIAGE_NEW_MOCK_URL
const THREAD_MOCK = process.env.TRIAGE_THREAD_MOCK_URL
const HOST = process.env.MOCK_URL

const HOUR = 3_600_000
const DAY = 86_400_000

const THREADS = [
  { id: "e2e-card-a", title: "Weather station", opener: "Print the weather station case" },
  { id: "e2e-card-b", title: "Garden plan", opener: "Plan the beds for spring" },
]
const MESSAGES = ["Plan the sprint", "Notes from Tuesday", "Today's catch-up"]
const LONG_NOTE = "A note only the weather thread holds"
const LONG_MESSAGES = 24

const STARTED = "Rotate the greenhouse logs"
const TRIAGE_NEW = "Clean up the invoice folders"
const TRIAGE_THREAD = "Park the invoice for later"
const OLDER_THREAD = "Keep the gate open"

const count = (page, selector) => page.locator(selector).count()

/**
 * A card's way into its thread. The link's words are "View thread" but its accessible name is what
 * it names — `View <thread title>`, which is what a reader hears — so a card is asked for by that
 * name as a string: a title is data, and one holding a bracket would turn a pattern into a different
 * question.
 */
const viewLink = (card, title) =>
  card.getByRole("link", { name: title ? `View ${title}` : /^View / })

function sequence(page) {
  return page.evaluate((messages) => {
    const content = document.querySelector('[data-slot="message-scroller-content"]')
    if (!content) return []
    return [...content.children]
      .filter((child) => child.hasAttribute("data-slot"))
      .flatMap((child) => {
        const slot = child.getAttribute("data-slot")
        const said = child.textContent?.trim() ?? ""
        if (slot === "day-heading" || slot === "other") return []
        // By the thread the card draws: the words on it are not a stable key.
        if (slot === "thread-card") return [`card:${child.getAttribute("data-thread")}`]
        if (slot === "message-scroller-item")
          return [`message:${messages.find((message) => said.includes(message)) ?? said}`]
        return []
      })
  }, MESSAGES)
}

/**
 * The rows the seeded chats are drawn from, by session: every screen reads its host's transcript
 * (ADR 0111), so a seed writes here rather than into this device's rows — and writes again for each
 * host the flow switches to, since a transcript is the host's own.
 */
let seeded = []

/** Writes the seeded transcripts to one host. */
async function seedHost(host) {
  for (const { session, rows } of seeded) await writeTranscript(host, session, rows)
}

function seed(
  page,
  {
    profileId,
    threads = THREADS,
    messages = MESSAGES,
    hour = HOUR,
    day = DAY,
    long = LONG_MESSAGES,
    note = LONG_NOTE,
  } = {},
) {
  const now = Date.now()
  const began = now - 2.5 * day + 2
  const at = (ms) => ms / 1000
  const said = (text, when) => ({ role: "user", content: text, timestamp: at(when) })
  const times = [now - 3 * day, now - 2 * day, now - 2 * hour]
  const mainId = `main-${profileId}`
  // Every screen draws a chat from its host's transcript (ADR 0111), so the seed writes the rows
  // there — and this device's copy of them too, which is the chat a device that has read it once
  // holds: the one it draws without waiting on a read mid-switch.
  seeded = [
    { session: `gots-${mainId}`, rows: messages.map((text, index) => said(text, times[index])) },
    {
      session: `gots-${threads[0].id}`,
      rows: [
        said(threads[0].opener, now - 2.5 * day + 1),
        ...Array.from({ length: long }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: index === 12 ? note : `Greenhouse note ${index + 1}`,
          timestamp: at(began + index * 1000),
        })),
      ],
    },
    { session: `gots-${threads[1].id}`, rows: [said(threads[1].opener, now - hour + 1)] },
  ]
  return page.evaluate(
    async ({ threads, now, hour, day, seeded }) => {
      const { db, ensureMainThread, mainThreadId, saveSettings } = await import("/src/lib/db.ts")
      await saveSettings({ chatThreads: true })
      const profile = (await db.profiles.toArray())[0]
      // Whatever this device merged from its host before the seed is not part of what the flow
      // asserts: a chat that arrived from the host would stand beside the seeded threads and make
      // "exactly these" untrue, on a run that happens to sync first.
      await db.messages.clear()
      await db.conversations.clear()
      await db.sessionRows.clear()
      await ensureMainThread(profile.id)
      const mainId = mainThreadId(profile.id)
      await db.conversations.bulkPut(
        threads.map(({ id, title }, index) => ({
          id,
          profileId: profile.id,
          title,
          titleEdited: true,
          hermesSessionId: `gots-${id}`,
          createdAt: index === 0 ? now - 2.5 * day : now - hour,
          updatedAt: now - hour,
          changedAt: now,
        })),
      )
      // The card's own words: the message that opened each thread, which the card draws before its
      // screen has read anything.
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
      // This device's copy of each transcript, in the shape the app keeps them: the rows it holds
      // for a chat it has read, so opening one draws it rather than reading it again.
      for (const { session, rows } of seeded)
        await db.sessionRows.bulkPut(
          rows.map((row, index) => ({
            session,
            set: "live",
            id: index + 1,
            pos: index,
            row: { id: index + 1, session_id: session, ...row },
          })),
        )
      await db.conversations.update(mainId, { createdAt: now - 4 * day })
      return mainId
    },
    { threads, now, hour, day, seeded },
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
        // The chat being left is known by its words. The one asked for is known by its name, which
        // the screen draws before the rows it reads back from the host: a pane carrying the right
        // title and no rows yet is that chat arriving, not a third one — `whole` is what says it
        // landed, and every frame after the switch is waited on for it.
        const match = chats.findIndex((chat, index) =>
          index === 0
            ? title === chat.title && text.includes(chat.says)
            : title === chat.title,
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
          // A bot's item lane saying nothing is open: what a pane still answering must not be
          // read as while the chat it asked for arrives.
          empty: Boolean(root.querySelector('[data-slot="bot-chats-empty"]')),
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
          height: content ? Math.round(content.getBoundingClientRect().height) : 0,
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
  // The chat's name is drawn a beat before the rows it reads: the frames that matter start at the
  // first one holding content, which is where "placed at the end of it" first means anything.
  const landed = frames.findIndex(
    (frame) => frame.match === 1 && frame.count > 0 && !frame.held,
  )
  assert.ok(landed > 0, `${what}: the chat asked for lands after the one left`)
  assert.equal(frames.at(-1).match, 1, `${what}: and it is still the one on screen`)
  assert.ok(frames.at(-1).whole, `${what}: and drawn whole once the switch settles`)
  const after = frames.slice(landed)
  assert.deepEqual(
    after.filter((frame) => frame.held).map((frame) => frame.title),
    [],
    `${what}: the chat asked for never goes back into its hold once it is on screen`,
  )
  // A chat reads its transcript back a page at a time, so its content grows until the last page
  // lands and the end it is placed at moves with it. The frames that must be at the end are the
  // ones drawn whole — the same frames the drift check below reads — not the ones still arriving.
  const settledHeight = after.at(-1)?.height
  const steady = after.filter((frame) => frame.height === settledHeight)
  // The chat arrives at the end the first time it is placed there; from that frame on, it stays.
  const placed = steady.findIndex((frame) => frame.atEnd)
  assert.ok(placed >= 0, `${what}: the chat asked for is placed at the end of its content`)
  // Placed is where the chat's own claim starts: the frames before it are the ones it spent
  // arriving, which is the read's business and not the switch's.
  const set = steady.slice(placed)
  const ends = set.filter((frame) => !frame.atEnd)
  assert.equal(
    ends.length,
    0,
    `${what}: every frame drawn whole is placed at the end of its content (${ends
      .map((frame) => `${frame.scrollTop} of ${frame.count} h${frame.height}`)
      .join(", ")} among ${after.map((frame) => `${frame.scrollTop}/${frame.count}/${frame.height}/${frame.atEnd ? "end" : "off"}`).join(" ")})`,
  )
  assert.ok(set.length > 1, `${what}: the settled chat was sampled more than once`)
  const bottoms = set.map((frame) => frame.bottom)
  const drift = Math.max(...bottoms) - Math.min(...bottoms)
  assert.ok(
    drift <= 1,
    `${what}: the settled chat never moves (last item at ${bottoms.join(" → ")})`,
  )
  return { scrollTop: after[0].scrollTop, frames: frames.length }
}

const SETTLED_FRAMES = 3

async function sampleSwitch(page, { chats, pane = "route", act, what }) {
  const lanes = [{ pane, chats }]
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
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  )
  const frames = await stopFrames(page)
  assertSwitchFrames(frames[pane], { what })
  return frames
}

async function useMock(page, profileId, mock, mainId) {
  // The host the flow is leaving behind holds Main's rows; the one it is switching to must too, or
  // Main opens with its cards and none of the messages they were written between.
  await seedHost(mock)
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
  const response = await fetch(`${mock}/api/plugins/gots/chats`, { headers: mockAuth })
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
  async ({ page, profileId, send, composer, until, shot }) => {
    const mainId = `main-${profileId}`
    const mainPath = `/c/${mainId}`
    // A bot this device has never opened draws its list, and Main is a row of that list.
    await page.goto(`${app}/`)
    await page.waitForURL(`**/b/${profileId}`, { timeout: 15_000 })
    pass("a bot this device has never opened draws its list")

    await seed(page, { profileId })
    await seedHost(HOST)
    // Main draws the host's transcript, so the seed lands there and the screen reads it: a reload is
    // this device opening the chat for the first time, not a merge of a copy it already held.
    await page.reload()
    await page.locator(`ul a[href="${mainPath}"]`).first().click()
    await page.waitForURL(`**${mainPath}`, { timeout: 15_000 })
    await until(
      async () => (await sequence(page)).length === MESSAGES.length + THREADS.length,
      20_000,
      "Main's messages and its cards",
    )
    await until(
      async () => (await count(page, '[data-slot="thread-card"]')) === 2,
      15_000,
      "Main's cards",
    )
    assert.deepEqual(
      await sequence(page),
      [
        `message:${MESSAGES[0]}`,
        `card:${THREADS[0].id}`,
        `message:${MESSAGES[1]}`,
        `message:${MESSAGES[2]}`,
        `card:${THREADS[1].id}`,
      ],
      "each card sits where its thread began, between the messages written around it",
    )
    const card = cardOf(page, THREADS[0].id)
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
      act: () => viewLink(card, THREADS[0].title).click(),
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

    // Tapping the command in the composer's own menu puts it in the field rather than opening a
    // thread on the spot (ADR 0096): the message typed after it is what the thread is started with.
    await composer.click()
    await composer.pressSequentially("/thread")
    await page.locator('[role="option"]').filter({ hasText: "/thread" }).first().click()
    await until(
      async () => (await composer.inputValue()) === "/thread ",
      15_000,
      "the command in the field",
    )
    assert.equal(
      await count(page, '[data-slot="thread-card"]'),
      2,
      "a pick starts nothing: the thread is the Send's to make",
    )
    await composer.fill("")
    pass("the menu's /thread lands in the field and opens no thread")

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
    // A turn the thread it started is running draws its own line in Main until it lands; the cards'
    // places are read once it has, which is the flow a reader keeps.
    await until(
      async () =>
        (await sequence(page)).filter((entry) => entry.startsWith("message:")).length ===
        MESSAGES.length,
      30_000,
      "Main's live line, once the new thread's turn has landed",
    )
    const after = await sequence(page)
    assert.deepEqual(
      after.slice(0, 5),
      [
        `message:${MESSAGES[0]}`,
        `card:${THREADS[0].id}`,
        `message:${MESSAGES[1]}`,
        `message:${MESSAGES[2]}`,
        `card:${THREADS[1].id}`,
      ],
      "the cards already there keep their places",
    )
    assert.equal(after.at(-1)?.startsWith("card:"), true, "the newest card closes the flow")
    const newest = await page.locator('[data-slot="thread-card"]').last().textContent()
    assert.equal(
      newest?.includes(STARTED),
      true,
      "the started thread's card holds the message that opened it",
    )
    assert.equal(
      after.filter((entry) => entry.startsWith("message:") && entry.includes(STARTED)).length,
      0,
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
      "nothing says where the message went: the card standing where it was is that sentence",
    )
    const last = page.locator('[data-slot="thread-card"]').last()
    assert.equal(
      await last.getByText(/View thread/).count(),
      1,
      "a thread triage opened reads like a /thread card, with the ordinary way in",
    )
    assert.equal(
      await last.evaluate((card) => {
        const body = card.querySelector('[data-slot="thread-card-body"]')
        const undo = card.querySelector('button[aria-label="Undo"]')
        return Boolean(body && undo) && !body.contains(undo)
      }),
      true,
      "and its Undo stands outside the card, at the end of the row",
    )
    const widths = await page.evaluate(() =>
      [...document.querySelectorAll('[data-slot="thread-card-body"]')].map((body) =>
        Math.round(body.getBoundingClientRect().width),
      ),
    )
    assert.ok(widths.length > 1, "more than one card is drawn")
    const gap = await page.evaluate(() => {
      const card = [...document.querySelectorAll('[data-slot="thread-card"]')].find((one) =>
        one.querySelector('button[aria-label="Undo"]'),
      )
      const body = card?.querySelector('[data-slot="thread-card-body"]')
      const undo = card?.querySelector('button[aria-label="Undo"]')
      if (!body || !undo) return null
      return Math.round(undo.getBoundingClientRect().left - body.getBoundingClientRect().right)
    })
    assert.ok(
      gap !== null && gap >= 0 && gap <= 8,
      `Undo stands at the card's edge (${gap}px away)`,
    )
    assert.equal(
      new Set(widths).size,
      1,
      `every card is the same width, with or without Undo (found ${widths.join(", ")})`,
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
      .locator('[data-slot="moved-marker"] p')
      .filter({ hasText: /Moved to/ })
      .first()
    await marker.waitFor({ timeout: 25_000 })
    const link = marker.locator(`a[href="/c/${olderId}"]`)
    assert.equal(await link.count(), 1, "the marker links the older thread it moved into")
    // A reader aims at the sentence, not at the thread's name: the whole line goes where it goes.
    // A reader aims at the sentence, not at the thread's name: the line's own empty space, past the
    // words and away from Undo, is the link that goes to the thread.
    assert.equal(
      await marker.evaluate((line, href) => {
        const box = line.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + 220, box.top + 16)
        return hit?.closest("a")?.getAttribute("href") === href
      }, `/c/${olderId}`),
      true,
      "the whole line answers a press",
    )
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

  },
  { viewport: { width: 390, height: 844 } },
)
