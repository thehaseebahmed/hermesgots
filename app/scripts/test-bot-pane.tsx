import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { Link, MemoryRouter, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { ChatPage } from "@/routes/chat"
import { db, ensureMainThread, mainThreadId } from "@/lib/db"
import { SPLIT_KEY } from "@/lib/split"
import { lastThreadKey, rememberThread } from "@/lib/threads"
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
  SwitchTo,
  text,
  type,
  until,
} from "./component-kit.tsx"
import { FakeRecorder, dictationHost, installFakeMedia } from "./fake-dictation.ts"
import { fakeHost } from "./chat-next-host.ts"

const bot = botProfile("bot-pane", { id: "bot-1", name: "Mainly", apiKey: undefined })
const other = botProfile("bot-other", { id: "bot-2", name: "Otherly" })
const MAIN = mainThreadId(bot.id)
/** What a run writes into a thread whose pane the reader closed mid-reply. */
const LANDED = "Landed while the pane was away."

async function seed(threads: string[] = [], patch: { legacyChat?: boolean } = {}) {
  await seedSettings({ developer: true, activeProfileId: bot.id, ...patch })
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

/**
 * A thread a bot owns, as opening it wrote it: the record the bot's lane lists and the message that
 * opened it, which is what its card says it is about.
 */
async function openThread(id: string, profileId: string, at: number) {
  await db.conversations.put({
    id,
    profileId,
    title: `Thread ${id}`,
    titleEdited: true,
    hermesSessionId: `gots-${id}`,
    createdAt: at,
    updatedAt: at,
    changedAt: 10,
  })
  await db.messages.put({
    id: `${id}-open`,
    conversationId: id,
    role: "user",
    content: `Opened ${id}`,
    status: "done",
    createdAt: at + 1,
  })
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
    {/* The way to a feature's own lane, which slides where a bot's rearranges. */}
    <SwitchTo to="/code" replace />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="c/:id" element={<ChatPage slot="route" />} />
        <Route path="code" element={null} />
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
const openCards = () => findAll('[data-slot="thread-card"] [aria-current="page"]').filter(live)
const cardLink = (id: string) => find(`[data-slot="thread-card"] a[href="/c/${id}"]`)
/** The thread's own card in Main, wherever it was placed in the flow, as a selector. */
const cardSelector = (id: string) => `[data-slot="thread-card"][data-thread="${id}"]`
const remembered = (profileId: string) => localStorage.getItem(lastThreadKey(profileId))
/**
 * A thread this device remembers, written the way the app writes it. Storage on its own leaves the
 * lane's store holding the row it loaded earlier, so a close would move nothing and tell nobody —
 * which is a state no visit can produce.
 */
const remembers = (thread: string, profileId = bot.id) => rememberThread(profileId, thread)
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
 * The same Escape, pressed where the reader is typing: it goes to the field first — the composer
 * answers it, or leaves it — and then bubbles to the shell, which is the order the page has.
 */
async function escapeIn(field: Element | null) {
  assert.ok(field, "the field the key is pressed in")
  await act(async () => {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    )
  })
  await settle()
}
/** The thread's own composer, beside Main. */
const threadComposer = () =>
  find('[data-pane="thread"] textarea[aria-label="Message"]') as HTMLTextAreaElement | null
/**
 * The reopen chord, as the reader's keyboard sends it: a Mac passes Cmd where every other one passes
 * Ctrl, and the physical key is `Backslash` either way, which is what the lane reads.
 */
async function reopen() {
  const mac = /Mac/.test(navigator.platform)
  await act(async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "\\",
        code: "Backslash",
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
        cancelable: true,
      }),
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
 * The share the list's lane draws, read off the width the shell writes on it: a DOM without layout
 * can measure no box, and the clamp a split draws narrows and widens with the row, so the number it
 * holds is the share and not the px.
 */
const listShare = () => {
  const style = find('[data-slot="list-lane"]')?.getAttribute("style") ?? ""
  const found = /clamp\(412px, ([\d.]+)%/.exec(style)
  return found ? Number(found[1]) : null
}

/** The split's edge, as the reader reaches it: a separator between the two chats. */
const splitEdge = () => find('[data-slot="split-handle"]')

/** A key, as it arrives at the handle the reader has focused. */
async function key(name: string, init: KeyboardEventInit = {}) {
  const edge = splitEdge()
  assert.ok(edge, "the split's handle is on screen")
  await act(async () => {
    edge.dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }),
    )
  })
  await settle()
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
    await openThread("t-b", other.id, 20)
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
        assert.equal(
          listShare(),
          50,
          "the lane keeps the share it had while the list is unanswered",
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
  "a switch out of a closed lane never flashes the 412px rail",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    // The bot the reader switches to: its own thread is the one this device remembers, and its
    // thread count is what the lane waits on.
    await openThread("t-o", other.id, 20)
    localStorage.setItem(lastThreadKey(other.id), "t-o")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => text().includes("2 threads"), "this bot's threads to load")
      await settle()
      assert.ok(
        listLane().includes("w-full"),
        `this bot's lane stands closed (the lane took ${listLane().join(" ")})`,
      )
      const count = holdThreadCount()
      const frames: string[] = []
      const look = () => frames.push(find('[data-slot="list-lane"]')?.className ?? "")
      const observer = new MutationObserver(look)
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      })
      look()
      try {
        // The switch, while the other bot's thread list is still on its way: unknown is not
        // closed, so the lane keeps the state and the width it had (ADR 0110).
        await click(find("[data-to-other]"))
        await settle()
        count.release()
        await until(
          async () => titles().join("|") === "Otherly|Thread t-o",
          "the new bot's thread beside its Main",
        )
      } finally {
        count.release()
        observer.disconnect()
        count.restore()
      }
      const railed = frames.filter((frame) => /\bw-103\b/.test(frame))
      assert.deepEqual(
        railed,
        [],
        `no frame between the two bots draws the 412px rail (${railed.length} did, of ${frames.length})`,
      )
      assert.deepEqual(titles(), ["Otherly", "Thread t-o"], "both panes are the new bot's")
    })
  }),
)

test(
  "with the legacy layout a bot is one screen, as it was",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"], { legacyChat: true })
    localStorage.setItem(lastThreadKey(bot.id), "t-b")
    await mount(screen("/c/t-a"), async () => {
      await until(async () => titles().length === 1, "one screen")
      await settle()
      assert.deepEqual(titles(), ["Thread t-a"], "one chat, and nothing beside it")
    })
  }),
)

test(
  "a thread beside Main carries the close cross and no picture",
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
        "and the close cross, where a phone's Back sits",
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
  "the close cross by the thread's title closes it, and Main takes the lane",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    remembers("t-a")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread beside Main")
      assert.equal(listShare(), 50, "the thread stands beside Main in half the row")
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

test(
  "a thread closed while it streams keeps running, and its card in Main still spins",
  laptop(async () => {
    localStorage.clear()
    await seed()
    // The bot whose thread this is: a server to call and a key to call it with, so the thread is
    // chat-next's and the run is the one its own screen starts and follows.
    await openThread("t-s", other.id, 10)
    remembers("t-s", other.id)
    // The host the thread's send runs on: the run is the fake host's, and the host's own ledger is
    // what a card's spinner stands on while nothing draws the thread.
    const host = fakeHost("gots-t-s", { plugin: true })
    await mount(screen(`/c/${mainThreadId(other.id)}`), async () => {
      await until(async () => titles().join("|") === "Otherly|Thread t-s", "the thread beside Main")
      await type(threadComposer(), "Write the long answer")
      await click(find('[data-pane="thread"] button[aria-label="Send"]'))
      await until(async () => host.asked.runs === 1, "the thread's turn posted")
      host.latest.run.say("Thinking it over")

      // The reader puts the surface away mid-reply.
      await click(find('[aria-label="Close thread"]'))
      await until(async () => titles().join("|") === "Otherly", "Main alone")

      assert.equal(host.asked.stops, 0, "nothing was posted to stop the run the reader put away")
      await until(
        async () => Boolean(find(`${cardSelector("t-s")} [data-slot="spinner"]`)),
        "the closed thread's card still spinning",
      )

      // The run goes on at the host, and its reply is written there while nothing draws the thread.
      host.latest.run.finish(LANDED)

      // The thread again, from its card in Main: the words the host wrote while it was away.
      await click(cardLink("t-s"))
      await until(async () => path() === "/c/t-s", "the address to name the thread")
      await until(async () => text().includes(LANDED), "the rows that landed while it was closed")
      assert.equal(host.asked.stops, 0, "and opening it again posts no stop either")
    })
  }),
)

test("Escape closes the lane, and only where the thread is a lane", async () => {
  localStorage.clear()
  await seed(["t-a"])
  remembers("t-a")
  // A laptop, where the thread is the lane beside Main, then a phone, where it is a screen of its
  // own with a Back: the key is the close cross's twin on the one and nothing at all on the other.
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
      assert.deepEqual(titles(), ["Mainly"], "Escape closes the lane the close cross would")
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
  "Escape in the thread's composer clears its text before it closes the lane",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    remembers("t-a")
    // The harness has no editing commands, and the composer clears through the field where it can:
    // a command it doesn't have answers false, which is the signal its own fallback waits for.
    const command = Object.getOwnPropertyDescriptor(document, "execCommand")
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false })
    try {
      await mount(screen(`/c/${MAIN}`), async () => {
        await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread beside Main")
        const field = threadComposer()
        await type(field, "Half a thought")
        assert.equal(field?.value, "Half a thought", "the thread's field holds what was typed")

        // The field's own pair, "Escape, Escape — Clear the message": the first press is half of
        // it, so it is the field's and not the lane's.
        await escapeIn(field)
        assert.deepEqual(titles(), ["Mainly", "Thread t-a"], "the first Escape leaves the lane up")
        assert.equal(field?.value, "Half a thought", "and the text where the reader left it")

        await escapeIn(field)
        assert.equal(field?.value, "", "the second clears it")
        assert.deepEqual(titles(), ["Mainly", "Thread t-a"], "and the lane is still up")

        // An empty field has nothing to clear, so the Escape is the lane's and closes it.
        await escapeIn(field)
        await until(async () => titles().join("|") === "Mainly", "the lane closed on the empty field")
        assert.equal(remembered(bot.id), null, "and the thread it put away is forgotten")
      })
    } finally {
      if (command) Object.defineProperty(document, "execCommand", command)
      else delete (document as { execCommand?: unknown }).execCommand
    }
  }),
)

test(
  "Escape while dictating in the thread cancels the take and leaves the thread where it was",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    remembers("t-a")
    installFakeMedia()
    // A connection of this case's own: what a host answered about dictation is remembered for the
    // page, and every other case's bot has answered without it.
    const talking = botProfile("bot-pane-dictation", { id: bot.id, name: "Mainly" })
    await db.profiles.put(talking)
    // The bot hears a take; everything the real host answers that this case doesn't care about is
    // the empty answer the other cases fake.
    const hosted = dictationHost({ heard: "hello there" })
    const dictation = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await dictation(input, init)
      return answer.status === 404 ? json({}) : answer
    }) as typeof fetch
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread beside Main")
      const mic = find('[data-pane="thread"] [aria-label="Voice"]')
      await click(mic)
      await until(
        async () => Boolean(find('[role="group"][aria-label="Speech-to-text take"]')),
        "the take's bar",
      )
      await until(async () => FakeRecorder.slices > 0, "the take's first slice")

      // The take owns this Escape — the cheatsheet sells it as Cancel the recording — so it claims
      // the key where it takes it, and the lane beside it never hears one.
      await escape()
      await until(
        async () => Boolean(find('[data-pane="thread"] [aria-label="Voice"]')),
        "the bar back to the microphone",
      )
      assert.equal(hosted.cancels().length, 1, "the take was cancelled, not left running")
      assert.deepEqual(
        titles(),
        ["Mainly", "Thread t-a"],
        "both chats are still on screen: the lane did not also put the thread away",
      )
      assert.equal(remembered(bot.id), "t-a", "and the lane still remembers the thread it holds")
    })
  }),
)

test(
  "⌘\\ reopens the thread just closed, and nothing after leaving the bot",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    // The bot to switch to: its Main is a place, whether or not it has a thread of its own.
    await ensureMainThread(other.id)
    await mount(screen(`/c/${MAIN}`), async () => {
      // Of the two threads, the older one is opened: the chord has to bring back the thread it
      // closed, which is not the newest one a "reopen the newest" would pick. The card is drawn
      // once the bot's threads have answered, so the press waits for it rather than racing it.
      await until(async () => Boolean(cardLink("t-a")), "the card that opens the older thread")
      await click(cardLink("t-a"))
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the older thread")
      await click(find('[aria-label="Close thread"]'))
      await until(async () => titles().join("|") === "Mainly", "Main alone")
      assert.equal(remembered(bot.id), null, "a close forgets the thread, whatever comes after it")
      // The lane really is closed — Main at the row's whole width — so the key below is one the
      // shell hears rather than one it is still standing down from.
      await until(async () => listLane().includes("w-full"), "the lane closed")

      await reopen()
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread, back")
      assert.deepEqual(
        titles(),
        ["Mainly", "Thread t-a"],
        "the thread this bot closed, and not the newest thread",
      )
      assert.equal(remembered(bot.id), "t-a", "and the lane holds it again")

      // A chord on an open lane is no key at all: it never closes one.
      await reopen()
      assert.deepEqual(titles(), ["Mainly", "Thread t-a"], "the key leaves an open lane alone")
      assert.equal(remembered(bot.id), "t-a", "and its thread remembered")

      // The close belongs to this visit and this bot: another bot's Main is another place, and the
      // visit that comes back finds nothing to put back.
      await click(find('[aria-label="Close thread"]'))
      await until(async () => titles().join("|") === "Mainly", "Main alone again")
      await click(find("[data-to-other]"))
      await until(async () => path() === `/c/${mainThreadId(other.id)}`, "the other bot's Main")
      await click(find("[data-to-main]"))
      await until(async () => path() === `/c/${MAIN}`, "this bot's Main again")
      // The bot's list has answered, so the lane is closed rather than still on its way: the key
      // below is one the shell really hears, and it opens nothing.
      await until(async () => text().includes("2 threads"), "this bot's threads to load")
      await settle()
      assert.ok(
        listLane().includes("w-full"),
        `the lane stands closed (it took ${listLane().join(" ")})`,
      )
      await reopen()
      assert.deepEqual(titles(), ["Mainly"], "nothing comes back: leaving the bot forgot the close")
      assert.equal(remembered(bot.id), null, "so the lane stands closed, and nothing remembered")
    })
  }),
)

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
      assert.equal(listShare(), 50, "Main and its thread take half the row each")
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
  "the split's arrow keys move the edge, and Enter puts it back to half",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a", "t-b"])
    remembers("t-a")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread beside Main")
      assert.equal(
        splitEdge()?.getAttribute("role"),
        "separator",
        "the edge between the chats is a separator of its own",
      )
      assert.equal(splitEdge()?.getAttribute("aria-orientation"), "vertical")
      assert.equal(splitEdge()?.getAttribute("tabindex"), "0", "and a reader's keys reach it")
      assert.equal(splitEdge()?.getAttribute("aria-valuenow"), "50", "it reads the share it holds")
      assert.equal(listShare(), 50, "which is the share the lane draws")

      await key("ArrowRight")
      assert.equal(
        splitEdge()?.getAttribute("aria-valuenow"),
        "54",
        "the right arrow gives Main more",
      )
      assert.equal(listShare(), 54, "and the lane follows the handle")
      assert.equal(localStorage.getItem(SPLIT_KEY), "0.54", "the move is kept on this device")
      await key("ArrowLeft", { shiftKey: true })
      assert.equal(
        splitEdge()?.getAttribute("aria-valuenow"),
        "38",
        "Shift moves it four times as far",
      )
      await key("Enter")
      assert.equal(splitEdge()?.getAttribute("aria-valuenow"), "50", "Enter puts it back to half")
      assert.equal(listShare(), 50, "the lane with it")
      assert.equal(localStorage.getItem(SPLIT_KEY), "0.5", "and half is what the device keeps")
    })
  }),
)

test(
  "the lane opens by rearranging, not by sliding",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    await mount(screen(`/c/${MAIN}`), async () => {
      // A bot with a thread and none remembered: Main alone, at the lane's whole width.
      await until(async () => Boolean(cardLink("t-a")), "the card that opens the thread")
      await settle()
      assert.deepEqual(titles(), ["Mainly"], "Main alone before the thread opens")
      assert.ok(
        listLane().includes("w-full"),
        `and the lane's whole width (the lane took ${listLane().join(" ")})`,
      )
      const animator = spyAnimate()
      try {
        await click(cardLink("t-a"))
        await until(
          async () => titles().join("|") === "Mainly|Thread t-a",
          "the thread beside Main",
        )
        await settle()
        assert.equal(listShare(), 50, "the edge landed half way")
        const slides = animator.asked
          .filter((one) =>
            one.keyframes.some((frame) => String(frame.transform ?? "").includes("translateX")),
          )
          .map(
            (one) => `${one.element} ${one.keyframes.map((frame) => frame.transform).join(" → ")}`,
          )
        assert.deepEqual(
          slides,
          [],
          `the lane opens by the edge moving, and nothing slides (saw ${slides.join("; ")})`,
        )
      } finally {
        animator.restore()
      }
      // And both ways of putting it away still close it: the cross, then the key.
      await click(find('[aria-label="Close thread"]'))
      await until(async () => titles().join("|") === "Mainly", "the close cross's close")
      await click(cardLink("t-a"))
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread again")
      await escape()
      await until(async () => titles().join("|") === "Mainly", "Escape's close")
    })
  }),
)

test(
  "a bot's lane open plays no slide when the policy beside it slides",
  laptop(async () => {
    localStorage.clear()
    await seed(["t-a"])
    remembers("t-a")
    await mount(screen(`/c/${MAIN}`), async () => {
      await until(async () => titles().join("|") === "Mainly|Thread t-a", "the thread beside Main")
      await settle()
      const animator = spyAnimate()
      try {
        // Code's lane slides its item in where a bot's rearranges. The lane never closed — Main and
        // its thread were open before and the list's lane is open after — so the entrance is no
        // pane's to replay: it belongs to an opening, not to the policy that followed it (ADR 0110).
        await click(find("[data-switch]"))
        await until(async () => path() === "/code", "Code's own screen")
        await until(async () => Boolean(find('[data-slot="list-lane"]')), "Code's own lane")
        await settle()
        const slides = animator.asked
          .filter((one) =>
            one.keyframes.some((frame) => String(frame.transform ?? "").includes("translateX")),
          )
          .map(
            (one) => `${one.element} ${one.keyframes.map((frame) => frame.transform).join(" → ")}`,
          )
        assert.deepEqual(
          slides,
          [],
          `a lane that stayed open slides nothing in (saw ${slides.join("; ")})`,
        )
        assert.ok(
          listLane().includes("w-103"),
          `and Code's lane is the 412px one it was designed around (it took ${listLane().join(" ")})`,
        )
      } finally {
        animator.restore()
      }
    })
  }),
)

test(
  "a callable bot's Main is chat-next's, and the lane beside it is the same split",
  laptop(async () => {
    localStorage.clear()
    await seed()
    // The bot whose Main chat-next draws: a server to call and a key to call it with.
    await openThread("t-o", other.id, 20)
    remembers("t-o", other.id)
    await mount(screen(`/c/${mainThreadId(other.id)}`), async () => {
      await until(
        async () => titles().join("|") === "Otherly|Thread t-o",
        "the remembered thread beside chat-next's Main",
      )
      await until(async () => text().includes("1 thread"), "Main's own count of its threads")
      assert.ok(
        find('[data-pane="main"][data-chat-next]'),
        "the bot's Main is the screen chat-next draws",
      )
      assert.ok(
        find('[data-pane="thread"][data-chat-next]'),
        "and so is the thread beside it",
      )
      assert.equal(listShare(), 50, "the two share the row in half")
      assert.equal(splitEdge()?.getAttribute("aria-valuenow"), "50", "with the handle between them")

      const [main, thread] = findAll('[data-slot="header-row"]')
      assert.ok(main?.querySelector('[role="img"]'), "Main keeps the bot's picture beside its name")
      assert.equal(main?.querySelector('[aria-label="Close thread"]'), null, "and no close cross")
      assert.ok(
        thread?.querySelector('[aria-label="Close thread"]'),
        "the thread beside it carries the cross",
      )
      assert.equal(
        thread?.querySelector('[aria-label^="Back to"]'),
        null,
        "and no way back, which it doesn't need where its bot is on screen",
      )
      assert.equal(openCards()[0]?.getAttribute("href"), "/c/t-o", "Main marks the thread it holds")

      await click(find('[aria-label="Close thread"]'))
      await until(async () => titles().join("|") === "Otherly", "Main alone")
      assert.ok(
        listLane().includes("w-full"),
        `and chat-next's Main takes the row's whole width (the lane took ${listLane().join(" ")})`,
      )
      assert.equal(remembered(other.id), null, "the thread it closed is forgotten")

      await reopen()
      await until(async () => titles().join("|") === "Otherly|Thread t-o", "the thread, back")
      assert.equal(remembered(other.id), "t-o", "and the lane holds it again")

      await escape()
      await until(async () => titles().join("|") === "Otherly", "Escape's close, on chat-next's Main")
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
