import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { Link, MemoryRouter, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { ChatPage } from "@/routes/chat"
import { sendMessage } from "@/lib/chat"
import { db, ensureMainThread, mainThreadId } from "@/lib/db"
import { handOver, lastThreadKey, rememberThread, takeHandover } from "@/lib/threads"
import {
  atWidth,
  botProfile,
  click,
  find,
  findAll,
  json,
  laptop,
  mount,
  Path,
  path,
  seedSettings,
  settle,
  spyAnimate,
  text,
  until,
} from "./component-kit.tsx"

const bot = botProfile("bot-pane", { id: "bot-1", name: "Mainly" })
const other = botProfile("bot-other", { id: "bot-2", name: "Otherly" })
const MAIN = mainThreadId(bot.id)
/** What a run writes into a thread whose pane the reader closed mid-reply. */
const LANDED = "Landed while the pane was away."

async function seed(threads: string[] = [], patch: { botThreads?: boolean } = {}) {
  await seedSettings({ developer: true, botThreads: true, activeProfileId: bot.id, ...patch })
  await db.profiles.clear()
  await db.profiles.bulkPut([bot, other])
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut(
    threads.map((id, index) => ({
      id,
      profileId: bot.id,
      title: `Thread ${id}`,
      titleEdited: true,
      hermesSessionId: `gots-${id}`,
      createdAt: 10 + index,
      updatedAt: 10 + index,
      changedAt: 10,
    })),
  )
  // A thread with nothing said in it is "not started", and its header carries no title at all.
  await db.messages.bulkPut(
    threads.map((id, index) => ({
      id: `${id}-open`,
      conversationId: id,
      role: "user" as const,
      content: `Opened ${id}`,
      status: "done" as const,
      createdAt: 11 + index,
    })),
  )
  await ensureMainThread(bot.id)
  globalThis.fetch = async () => json({})
}

const screen = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    {/* The way back to Main, which the thread beside it deliberately no longer draws. */}
    <Link to={`/c/${MAIN}`} data-to-main>
      Main
    </Link>
    {/* The way to a thread, as a card in Main leads there. */}
    <Link to="/c/t-a" data-to-thread>
      Thread t-a
    </Link>
    {/* The way to another bot's Main, which is a switch of every pane the shell draws. */}
    <Link to={`/c/${mainThreadId(other.id)}`} data-to-other>
      Other
    </Link>
    <Routes>
      <Route element={<AppShell />}>
        <Route path="c/:id" element={<ChatPage slot="route" />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

/**
 * Code's screen with its list, which the shell keeps beside it: the second lane a test reads, so a
 * bot's split can be told apart from every feature's own. The route matches so the shell mounts —
 * what it opens beside the list is the app's, and this test only asks what the list's lane is.
 */
const codeScreen = (
  <MemoryRouter initialEntries={["/code"]}>
    <Path />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="code" element={null} />
      </Route>
    </Routes>
  </MemoryRouter>
)

/**
 * A pane fades its predecessor out over it (`PaneTransition` marks the copy `inert` and
 * `aria-hidden`), and the copy leaves with a timer; a query that counts both panes' chrome counts a
 * header the user no longer sees.
 */
const live = (node: Element) => node.closest('[aria-hidden="true"]') === null
/** Every header on screen, the pane's first and the item beside it second. */
const titles = () =>
  findAll('[data-slot="header-title"]')
    .filter(live)
    .map((node) => node.textContent)
/** The card of the thread the pane is showing: the only one that says it is here. */
const openCards = () =>
  findAll('[data-slot="thread-card"] [aria-current="page"]').filter(live)
const cardLink = (id: string) => find(`[data-slot="thread-card"] a[href="/c/${id}"]`)
/** The thread's own card in Main, wherever it was placed in the flow. */
const threadCard = (id: string) => `[data-slot="thread-card"][data-thread="${id}"]`
const remembered = (profileId: string) => localStorage.getItem(lastThreadKey(profileId))
/**
 * A thread this device remembers, written the way the app writes it. Storage on its own leaves the
 * lane's store holding the row it loaded earlier, so a close would move nothing and tell nobody —
 * which is a state no visit can produce.
 */
const remembers = (thread: string) => rememberThread(bot.id, thread)
/**
 * One Escape, as a reader's key arrives at the page: it bubbles and it can be claimed, which is what
 * a sheet or a menu answering the key does before the lane ever hears it.
 */
async function escape() {
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    )
  })
  await settle()
}
/**
 * The classes the shell gives the list's column, since the harness has no layout to measure. The
 * lane's share is one of them, so a lane that kept `w-103` and one split in half read apart.
 */
const listLane = () => {
  const lane = find('[data-slot="list-lane"]')
  assert.ok(lane, "the shell draws the list's lane")
  return [...lane.classList]
}

/**
 * Holds the thread count a bot's pane reads, so a test can look at the lane between a switch and the
 * answer that says what the bot has. `release()` lets the read through and `restore()` puts the
 * table back; nothing but the count is held, so the lists a screen draws are never delayed.
 */
function holdThreadCount() {
  const table = db.conversations as unknown as Record<string, (...args: unknown[]) => unknown>
  const where = table.where.bind(db.conversations)
  let release = () => {}
  const held = new Promise<void>((done) => {
    release = done
  })
  table.where = (key: unknown) => {
    const clause = where(key) as Record<string, (...args: unknown[]) => unknown>
    const between = clause.between.bind(clause)
    clause.between = (...range: unknown[]) => {
      const collection = between(...range) as Record<string, () => Promise<number>>
      const count = collection.count.bind(collection)
      collection.count = async () => {
        await held
        return count()
      }
      return collection
    }
    return clause
  }
  return {
    release,
    restore() {
      table.where = where
    },
  }
}

test(
  "a message Main handed a thread is taken by that thread's screen, once, and never by Main",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    // What `/thread` leaves behind: a message for a thread that has just been made (ADR 0096).
    handOver("t-a", { text: "Plan the move", attachments: [] })
    const runs: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      if (url.pathname.endsWith("/v1/runs") && init?.method === "POST") {
        runs.push(String(JSON.parse(String(init.body)).session_id))
        return json({ error: { message: "stopped here" } }, 500)
      }
      if (url.pathname.endsWith("/capabilities"))
        return json({ features: { run_submission: true, run_events_sse: true } })
      if (url.pathname.endsWith("/plugins/gots/info")) return json({ features: ["queue", "moves"] })
      if (url.pathname.endsWith("/skills")) return json({ object: "list", data: [] })
      return json({})
    }) as typeof fetch
    await mount(screen(`/c/${MAIN}`), async () => {
      // Main is drawn beside the thread the address names, and its screen reads the same handover:
      // it must leave it alone, or the reader is sent back to Main and the message is lost.
      await until(async () => titles().includes("Mainly"), "Main's own pane")
      await settle()
      assert.deepEqual(runs, [], "Main took nothing: the handover is the thread's, by its id")
      await click(find("[data-to-thread]"))
      await until(async () => path() === "/c/t-a", "the thread's own address")
      await until(async () => runs.length === 1, "the thread's first turn, posted once")
      assert.equal(runs[0], "gots-t-a", "on the thread's own session")
      assert.equal(takeHandover("t-a"), undefined, "and taken, so a remount sends nothing again")
    })
  }),
)

test(
  "a thread opened for a bot is the one its pane keeps",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    await mount(screen("/c/t-a"), async () => {
      await until(async () => remembered(bot.id) === "t-a", "the thread this device opened last")
    })
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().includes("Thread t-a"), "the remembered thread beside Main")
      assert.deepEqual(titles(), ["Mainly", "Thread t-a"], "Main is the pane, the thread its item")
    })
  }),
)

test(
  "the thread that was open is the one beside Main when the user comes back to it",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    localStorage.setItem(lastThreadKey(bot.id), "t-b")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().includes("Thread t-b"), "the thread left beside Main")
      await click(cardLink("t-a"))
      await until(async () => path() === "/c/t-a", "the address to name the thread")
      await until(async () => remembered(bot.id) === "t-a", "the thread this device opened last")
      await click(find("[data-to-main]"))
      await until(async () => path() === `/c/${MAIN}`, "Main again")
      await until(
        async () => titles().join("|") === "Mainly|Thread t-a",
        "the thread that was open beside Main",
      )
      assert.deepEqual(
        titles(),
        ["Mainly", "Thread t-a"],
        "the pane keeps the thread that was open, not the one before it",
      )
    })
  }),
)

test(
  "a remembered thread that is gone leaves the pane closed",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    localStorage.setItem(lastThreadKey(bot.id), "t-gone")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => text().includes("1 thread"), "Main's own threads to load")
      await settle()
      assert.deepEqual(titles(), ["Mainly"], "Main alone is better than a chat nothing holds")
      assert.equal(
        find('[data-slot="bot-pane-empty"]'),
        null,
        "a bot with threads is not the empty one",
      )
    })
  }),
)

test(
  "another bot's thread is never the one the pane keeps",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    await db.conversations.put({
      id: "t-other",
      profileId: other.id,
      title: "Thread t-other",
      hermesSessionId: "gots-t-other",
      createdAt: 30,
      updatedAt: 30,
      changedAt: 30,
    })
    localStorage.setItem(lastThreadKey(bot.id), "t-other")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => Boolean(find('[data-slot="thread-card"]')), "the bot's threads")
      assert.deepEqual(titles(), ["Mainly"], "the other bot's thread stays out of this pane")
    })
  }),
)

test(
  "a bot with no threads keeps the pane and says so",
  laptop(async () => {
    localStorage.clear()
    await seed()
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => Boolean(find('[data-slot="bot-pane-empty"]')), "the pane's own line")
      assert.equal(find('[data-slot="bot-pane-empty"]')?.textContent, "No threads yet")
      assert.ok(
        listLane().includes("w-103"),
        `a bot with no threads keeps the 412px rail that says so (the lane took ${listLane().join(" ")})`,
      )
      assert.ok(find('[data-slot="header-row"]'), "Main is still the pane it stands beside")
    })
  }),
)

test(
  "a bot switch leaves its thread lane blank, and no frame calls a bot thread-less before its list answers",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    // The other bot has a thread of its own, and this device remembers opening it.
    await ensureMainThread(other.id)
    await db.conversations.put({
      id: "t-b",
      profileId: other.id,
      title: "Thread t-b",
      titleEdited: true,
      hermesSessionId: "gots-t-b",
      createdAt: 20,
      updatedAt: 20,
      changedAt: 20,
    })
    await db.messages.put({
      id: "t-b-open",
      conversationId: "t-b",
      role: "user",
      content: "Opened t-b",
      status: "done",
      createdAt: 21,
    })
    localStorage.setItem(lastThreadKey(bot.id), "t-a")
    localStorage.setItem(lastThreadKey(other.id), "t-b")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().includes("Thread t-a"), "the thread beside Main")
      const seen: boolean[] = []
      const look = () => seen.push(Boolean(find('[data-slot="bot-pane-empty"]')))
      const observer = new MutationObserver(look)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      const count = holdThreadCount()
      try {
        // The switch, while the other bot's thread list is still on its way.
        await click(find("[data-to-other]"))
        const lane = () => find('[data-pane="thread"]')?.textContent ?? ""
        assert.equal(
          find('[data-slot="bot-pane-empty"]'),
          null,
          "nothing says the bot has no threads while its list is on its way",
        )
        assert.ok(
          !lane().includes("Opened t-a"),
          `the lane draws nothing of the thread it was showing (saw "${lane().slice(0, 80)}")`,
        )
        assert.notEqual(
          find('[data-pane="thread"]')?.hasAttribute("inert"),
          false,
          "and no live chat stands in it while the new bot's thread answers",
        )
        assert.ok(
          listLane().includes("w-1/2"),
          `the lane keeps the share it had while the list is unanswered (the lane took ${listLane().join(" ")})`,
        )
        count.release()

        await until(
          async () => titles().includes("Thread t-b"),
          "the new bot's thread beside its Main",
        )
        observer.disconnect()
        assert.deepEqual(seen.filter(Boolean), [], "no frame ever said the bot has no threads")
        assert.equal(find('[data-slot="bot-pane-empty"]'), null, "and it has one")
        assert.deepEqual(titles(), ["Otherly", "Thread t-b"], "both panes are the new bot's")
      } finally {
        count.restore()
      }
    })
  }),
)

test(
  "with the switch off a bot is one screen, as it was",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"], { botThreads: false })
    localStorage.setItem(lastThreadKey(bot.id), "t-b")
    await mount(screen("/c/t-a"), async () => {
      await until(async () => titles().length === 1, "one screen")
      await settle()
      assert.deepEqual(titles(), ["Thread t-a"], "one chat, and nothing beside it")
    })
  }),
)

test(
  "a thread beside Main carries the collapse chevron and no picture",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    remembers("t-a")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().includes("Thread t-a"), "the thread beside Main")
      await until(
        async () => Boolean(findAll('[data-slot="header-row"]')[0]?.querySelector('[role="img"]')),
        "Main's picture beside its name",
      )
      const [main, thread] = findAll('[data-slot="header-row"]')
      assert.ok(main?.querySelector('[role="img"]'), "Main keeps the bot's picture beside its name")
      assert.equal(thread?.querySelector('[role="img"]'), null, "the thread beside it carries none")
      assert.ok(
        thread?.querySelector('[aria-label="Close thread"]'),
        "and the collapse chevron, where a phone's Back sits",
      )
      assert.equal(
        thread?.querySelector('[aria-label^="Back to"]'),
        null,
        "and no way back, which it doesn't need where its bot is on screen",
      )
      assert.ok(thread?.querySelector('[aria-label="Chat options"]'), "its own menu is still there")
    })
  }),
)

test(
  "the chevron by the thread's title closes it, and Main takes the lane",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    remembers("t-a")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread beside Main")
      assert.ok(
        listLane().includes("w-1/2"),
        `the thread stands beside Main (the lane took ${listLane().join(" ")})`,
      )
      await click(find('[aria-label="Close thread"]'))
      await until(async () => titles().join("|") === "Mainly", "Main alone")
      assert.deepEqual(titles(), ["Mainly"], "the bot's own header is the only one left")
      assert.ok(
        listLane().includes("w-full"),
        `and Main takes the row's whole width (the lane took ${listLane().join(" ")})`,
      )
      assert.equal(remembered(bot.id), null, "the thread it closed is forgotten")
    })
  }),
)

test(
  "closing the thread the address names lands Main with no slide",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    await mount(screen("/c/t-a"), async () => {
      // The lane answers with the address's thread first, so this is the thread beside Main.
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread beside Main")
      const animator = spyAnimate()
      try {
        await click(find('[aria-label="Close thread"]'))
        // The entry the thread took is replaced by this bot's Main, so the address comes back with
        // nothing pushed and nothing left to walk back into.
        await until(async () => path() === `/c/${MAIN}`, "the address back on the bot's Main")
        await until(async () => titles().join("|") === "Mainly", "Main alone")
        assert.deepEqual(titles(), ["Mainly"], "the thread's pane is not beside Main any more")
        assert.equal(remembered(bot.id), null, "the thread it closed is forgotten, not reopened")
        assert.deepEqual(
          animator.onScreen(),
          [],
          "and no page slide played for the Main that took its place",
        )
      } finally {
        animator.restore()
      }
    })
  }),
)

test(
  "a thread closed here is not reopened on the next visit",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    remembers("t-a")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread beside Main")
      await click(find('[aria-label="Close thread"]'))
      await until(async () => titles().join("|") === "Mainly", "Main alone")
    })
    // The next visit: the same bot, from its Main, with this page's store as the visit before left
    // it and storage as a launch would read it.
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => text().includes("2 threads"), "Main's own threads to load")
      await settle()
      assert.deepEqual(titles(), ["Mainly"], "the bot's own header is the only one left")
      assert.equal(remembered(bot.id), null, "and nothing is remembered for it")
      assert.equal(
        find('[data-slot="bot-pane-empty"]'),
        null,
        "a bot with threads is not the empty one",
      )
    })
  }),
)

/**
 * A run in flight over a thread a reader closes: the host's answer to the send, its live-runs ledger,
 * and one event stream the test pushes into, so what lands while the pane is away is the host's own
 * stream and not a row this test wrote into the store. Every request is recorded, which is what
 * "the close posted nothing to stop it" is read from — a silence proves nothing.
 */
function liveRunInThread() {
  const encoder = new TextEncoder()
  const requests: { method: string; path: string }[] = []
  let push = (_event: unknown) => {}
  const events = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    },
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = (init?.method ?? "GET").toUpperCase()
    requests.push({ method, path: url.pathname })
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/gots/info")) return json({ features: [] })
    if (url.pathname.endsWith("/skills")) return json({ object: "list", data: [] })
    // The host's own account of the run, which is what a card's spinner stands on: the pane being
    // closed says nothing about it.
    if (url.pathname.endsWith("/plugins/gots/runs/live"))
      return json({ sessions: { "gots-t-a": "running" }, run_ids: { "gots-t-a": "run-1" } })
    if (url.pathname.endsWith("/v1/runs/run-1/events"))
      return new Response(events, { headers: { "content-type": "text/event-stream" } })
    if (url.pathname.endsWith("/v1/runs/run-1"))
      return json({ status: "running", created_at: 1, output: "", usage: {} })
    if (url.pathname.endsWith("/v1/runs") && method === "POST") return json({ run_id: "run-1" })
    return json({})
  }) as typeof fetch
  return { requests, push }
}

/**
 * The reply a run is writing in a thread: this device's own copy, which the screen being closed
 * neither finishes nor stops writing.
 */
async function replyOf(thread: string) {
  const rows = await db.messages.where("conversationId").equals(thread).toArray()
  return rows.filter((row) => row.role === "assistant").at(-1)
}

test(
  "a thread closed while it streams keeps running, and its card in Main still spins",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    remembers("t-a")
    const host = liveRunInThread()
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread beside Main")
      // The send the thread's own composer makes, over a host that answers with a run.
      void sendMessage("t-a", "Write the long answer").catch(() => undefined)
      await until(
        async () => host.requests.some((r) => r.method === "POST" && r.path.endsWith("/v1/runs")),
        "the run's POST",
      )
      await until(
        async () => host.requests.some((r) => r.path.endsWith("/v1/runs/run-1/events")),
        "the run's events being followed",
      )
      await until(async () => (await replyOf("t-a"))?.status === "streaming", "the reply streaming")

      // The reader puts the surface away mid-reply.
      await click(find('[aria-label="Close thread"]'))
      await until(async () => titles().join("|") === "Mainly", "Main alone")

      assert.deepEqual(
        host.requests.filter((r) => r.path.endsWith("/stop")),
        [],
        "nothing was posted to stop the run the reader put away",
      )
      assert.ok(
        host.requests.some((r) => r.path.endsWith("/plugins/gots/runs/live")),
        "the host still reports the run, which is what a card's spinner stands on",
      )
      assert.equal(
        (await replyOf("t-a"))?.status,
        "streaming",
        "and this device's copy of the reply is still being written",
      )
      await until(
        async () => Boolean(find(`${threadCard("t-a")} [data-slot="spinner"]`)),
        "the closed thread's card still spinning",
      )

      // The run goes on at the host: a row lands while nothing draws the thread.
      host.push({ event: "message.delta", delta: LANDED, seq: 1 })
      await until(
        async () => Boolean((await replyOf("t-a"))?.content.includes(LANDED)),
        "the row to land in the thread's store",
      )

      // The thread again, from its card in Main.
      await click(cardLink("t-a"))
      await until(async () => path() === "/c/t-a", "the address to name the thread")
      await until(async () => text().includes(LANDED), "the rows that landed while it was closed")
      assert.deepEqual(
        host.requests.filter((r) => r.path.endsWith("/stop")),
        [],
        "and opening it again posts no stop either",
      )
    })
  }),
)

test("Escape closes the lane, and only where the thread is a lane", async () => {
  localStorage.clear()
  await seed(["t-a"])
  remembers("t-a")
  // A laptop, where the thread is the lane beside Main, then a phone, where it is a screen of its
  // own with a Back: the key is the chevron's twin on the one and nothing at all on the other.
  const beside = laptop(async () => {
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread beside Main")
      // A sheet or a menu that answers Escape itself keeps the key: the lane stands down.
      const claim = (event: KeyboardEvent) => event.preventDefault()
      window.addEventListener("keydown", claim, true)
      await escape()
      window.removeEventListener("keydown", claim, true)
      assert.deepEqual(titles(), ["Mainly", "Thread t-a"], "a claimed Escape closes nothing")
      assert.equal(remembered(bot.id), "t-a", "and the thread stays remembered")

      await escape()
      await until(async () => titles().join("|") === "Mainly", "Main alone")
      assert.deepEqual(titles(), ["Mainly"], "Escape closes the lane the chevron would")
      assert.equal(remembered(bot.id), null, "and the closed thread is forgotten")
    })
  })
  // A visit of its own to a phone, remembering the thread it opens.
  remembers("t-a")
  const alone = atWidth(390, async () => {
    await mount(screen("/c/t-a"), async () => {
      await until(async () => titles().join("|") === "Thread t-a", "the thread's own screen")
      assert.ok(find('[aria-label^="Back to"]'), "the thread is a screen, with a way back")
      await escape()
      assert.deepEqual(titles(), ["Thread t-a"], "Escape leaves a screen that is not a lane")
      assert.equal(remembered(bot.id), "t-a", "and the thread it names stays remembered")
    })
  })
  await beside()
  await alone()
})

test(
  "the thread beside Main is the card Main marks open, and naming it keeps the pane it is in",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    localStorage.setItem(lastThreadKey(bot.id), "t-a")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().includes("Thread t-a"), "the thread beside Main")
      await until(async () => openCards().length === 1, "the card marked open")
      assert.equal(
        openCards()[0]?.getAttribute("href"),
        "/c/t-a",
        "the card of the thread on screen",
      )
      const pane = findAll('[data-slot="header-row"]')[1]

      await click(openCards()[0])
      await until(async () => path() === "/c/t-a", "the address names the thread")
      assert.deepEqual(
        titles(),
        ["Mainly", "Thread t-a"],
        "Main and its thread are both still there",
      )
      assert.equal(
        findAll('[data-slot="header-row"]')[1]?.isSameNode(pane),
        true,
        "the same pane is still on screen: naming the thread it already held drew it again",
      )
    })
  }),
)

test(
  "a bot's lane splits the row in half, and a feature's list keeps its 412px lane",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    localStorage.setItem(lastThreadKey(bot.id), "t-a")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().includes("Thread t-a"), "the thread beside Main")
      await settle()
      assert.ok(
        listLane().includes("w-1/2"),
        `Main and its thread take half the row each (the lane took ${listLane().join(" ")})`,
      )
    })
    // The policy is the bot's lane's alone: Code's list is the lane it was designed around, so a
    // split for bots costs every other feature nothing (ADR 0110).
    await mount(codeScreen, async () => {
      await until(async () => Boolean(find('[data-slot="list-lane"]')), "Code's own list lane")
      await settle()
      assert.ok(
        listLane().includes("w-103"),
        `Code's list keeps the 412px lane (it took ${listLane().join(" ")})`,
      )
    })
  }),
)

test(
  "a card whose thread is already the screen says so and goes nowhere",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    localStorage.setItem(lastThreadKey(bot.id), "t-a")
    await mount(screen("/c/t-a"), async () => {
      await until(async () => openCards().length === 1, "the card marked open")
      const open = openCards()[0]

      await click(open)
      assert.equal(path(), "/c/t-a", "the address doesn't move: the thread is the screen")
    })
  }),
)
