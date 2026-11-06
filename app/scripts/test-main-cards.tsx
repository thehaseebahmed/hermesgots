import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { db, ensureMainThread, mainThreadId, type Message } from "@/lib/db"
import { dayOf } from "@/lib/days"
import {
  botProfile,
  chatScreen,
  click,
  find,
  findAll,
  flowRows,
  json,
  mount,
  seedSettings,
  settle,
  text,
  threadCard,
  until,
} from "./component-kit.tsx"

const bot = botProfile("main-cards", { id: "bot-1", name: "Cards" })
const HOUR = 3_600_000
const DAY = 86_400_000
const MIDNIGHT = new Date().setHours(0, 0, 0, 0)
const at = (days: number, hours: number) => MIDNIGHT + days * DAY + hours * HOUR

const MAIN_MESSAGES = ["Started three days ago", "Two days ago", "Today's message"]

const THREADS = [
  { id: "t-a", title: "Thread a", createdAt: at(-3, 11), opener: "Something about a plan" },
  { id: "t-b", title: "Thread b", createdAt: at(-2, 11), opener: "Thread b's opener" },
  { id: "t-d", title: "Thread d", createdAt: at(-2, 13), opener: "Thread d's opener", muted: true },
  { id: "t-c", title: "Thread c", createdAt: at(0, 11), opener: "Thread c's opener" },
]

const msg = (
  id: string,
  conversationId: string,
  role: Message["role"],
  content: string,
  createdAt: number,
): Message => ({ id, conversationId, role, content, status: "done", createdAt })

async function reset() {
  await seedSettings({ developer: true, botThreads: true })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await ensureMainThread(bot.id)
  return mainThreadId(bot.id)
}

/** Seeds Main and its threads; `without` names a thread this device is given no transcript of. */
async function seed({ without = [] }: { without?: string[] } = {}) {
  const mainId = await reset()
  await db.messages.bulkPut([
    msg("m1", mainId, "user", MAIN_MESSAGES[0], at(-3, 9)),
    msg("m2", mainId, "user", MAIN_MESSAGES[1], at(-2, 9)),
    msg("m3", mainId, "user", MAIN_MESSAGES[2], at(0, 9)),
  ])
  await db.conversations.bulkPut(
    THREADS.map(({ id, title, createdAt, muted, opener }) => ({
      id,
      profileId: bot.id,
      title,
      hermesSessionId: `gots-${id}`,
      createdAt,
      updatedAt: createdAt,
      changedAt: 0,
      muted,
      opener,
      openerAt: createdAt,
    })),
  )
  await db.messages.bulkPut(
    [
      msg("a-1", "t-a", "user", "Something about a plan", at(-3, 11)),
      msg("b-1", "t-b", "user", "Thread b's opener", at(-2, 11)),
      msg("b-2", "t-b", "assistant", "A reply", at(-2, 12)),
      msg("d-1", "t-d", "user", "Thread d's opener", at(-2, 13)),
      msg("c-1", "t-c", "user", "Thread c's opener", at(0, 11)),
    ].filter((row) => !without.includes(row.conversationId)),
  )
}

function flow(bodies = MAIN_MESSAGES) {
  return flowRows().map((child) => {
      const slot = child.getAttribute("data-slot")
      const said = child.textContent?.trim() ?? ""
      if (slot === "day-heading") return `day:${said}`
      // By the thread the card draws: the words on it are not a stable key.
      if (slot === "thread-card") return `card:${child.getAttribute("data-thread")}`
      if (slot === "moved-marker") return `marker:${child.getAttribute("data-move")}`
      if (child.getAttribute("role") === "separator") {
        const label = child.getAttribute("aria-label") ?? ""
        return label.startsWith("Compaction") ? "compaction" : `divider:${label}`
      }
      if (slot === "message-scroller-item")
        return `message:${bodies.find((one) => said.includes(one)) ?? said}`
      return `other:${said}`
    })
}

const cards = () => findAll('[data-slot="thread-card"]')
const card = (threadId: string) => threadCard(threadId)
const heading = (timestamp: number) => `day:${dayOf(timestamp, Date.now())}`
const drawn = () => until(async () => cards().length === THREADS.length, "Main's cards")

test("Main draws its threads as cards where they started, under its own day headings", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(chatScreen(mainThreadId(bot.id)), async () => {
    await drawn()
    assert.deepEqual(flow(), [
      heading(at(-3, 9)),
      `message:${MAIN_MESSAGES[0]}`,
      "card:t-a",
      heading(at(-2, 9)),
      `message:${MAIN_MESSAGES[1]}`,
      "card:t-b",
      "card:t-d",
      heading(at(0, 9)),
      `message:${MAIN_MESSAGES[2]}`,
      "card:t-c",
    ])
    assert.equal(findAll('[data-slot="day-heading"]').at(-1)?.textContent, "Today")
  })
})

test("Main is never drawn as a card among its own messages", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(chatScreen(mainThreadId(bot.id)), async () => {
    await drawn()
    assert.equal(cards().length, THREADS.length)
    assert.ok(
      cards().every((one) => one.getAttribute("data-thread") !== mainThreadId(bot.id)),
      "no card is drawn for Main itself",
    )
  })
})

test("a card keeps its place when its thread gets a message", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(chatScreen(mainThreadId(bot.id)), async () => {
    await drawn()
    const before = flow()
    await act(async () => {
      await db.messages.put(msg("b-3", "t-b", "assistant", "A later reply", at(0, 12)))
      await db.conversations.update("t-b", { updatedAt: at(0, 12) })
    })
    await settle()
    assert.deepEqual(flow(), before, "the card holds the place its thread started in")
    assert.ok(
      card("t-b")?.textContent?.includes("2 replies"),
      "the card reads the thread's new state",
    )
  })
})

test("a card keeps its message in the bubble and its name on the card, with no avatar", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(chatScreen(mainThreadId(bot.id)), async () => {
    await drawn()
    const one = card("t-b")
    assert.ok(one, "the thread's card is on screen")
    const bubble = one.querySelector('[data-slot="bubble-content"]')
    assert.equal(bubble?.textContent, "Thread b's opener", "the message that opened it, in its bubble")
    assert.ok(one.textContent?.includes("Thread b"), "and the thread's name on the card below it")
    assert.notEqual(bubble?.textContent, "Thread b", "the bubble never carries the name instead")
    assert.equal(
      one.querySelector('[role="img"]'),
      null,
      "no bot avatar: a card is not a turn",
    )
    assert.ok(one.textContent?.includes("1 reply"), "how many replies it has")
    assert.ok(one.querySelector("svg.lucide-message-circle"), "its state, an icon")
    // The name is the card's line only: the bubble carries the message, never the name standing in
    // for a message this device does not hold.
    const words = card("t-a")
    assert.ok(
      words?.querySelector('[data-slot="bubble-content"]')?.textContent?.includes("Something about a plan"),
      "a card's bubble says the message that opened it",
    )
    assert.ok(card("t-d")?.querySelector('[aria-label="Muted"]'), "a muted thread's mark")
  })
})

test("a card stands where its opener was sent, not where the record was made", async () => {
  await seed()
  await db.conversations.update("t-d", { createdAt: at(0, 8), openerAt: at(-2, 13) })
  globalThis.fetch = async () => json({})
  await mount(chatScreen(mainThreadId(bot.id)), async () => {
    await drawn()
    const order = flow()
    const card = order.indexOf("card:t-d")
    assert.ok(card > order.indexOf(`message:${MAIN_MESSAGES[1]}`), "after the message before it")
    assert.ok(card < order.indexOf(`message:${MAIN_MESSAGES[2]}`), "and before the one after")
  })
})

test("a thread whose transcript isn't here draws the opener the host recorded", async () => {
  await seed({ without: ["t-a"] })
  globalThis.fetch = async () => json({})
  await mount(chatScreen(mainThreadId(bot.id)), async () => {
    await drawn()
    assert.equal(cards().length, THREADS.length, "the card keeps its place among the others")
    const one = card("t-a")
    assert.ok(one, "the thread's card is still drawn")
    assert.equal(
      one.querySelector('[data-slot="bubble-content"]')?.textContent,
      "Something about a plan",
      "the message the host says began it, in its bubble",
    )
    assert.ok(one.textContent?.includes("Thread a"), "and the card still says its name")
  })
})

test("a thread nothing names an opener for draws no bubble, only its name", async () => {
  await seed({ without: ["t-a"] })
  await db.conversations.update("t-a", { opener: undefined, openerAt: undefined })
  globalThis.fetch = async () => json({})
  await mount(chatScreen(mainThreadId(bot.id)), async () => {
    await drawn()
    const one = card("t-a")
    assert.ok(one, "the thread's card is still drawn")
    assert.equal(one.querySelector('[data-slot="bubble"]'), null, "with no message to show")
    assert.ok(one.textContent?.includes("Thread a"), "and says the one thing it has: its name")
  })
})

test("tapping a card opens its thread, and back returns to Main", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(chatScreen(mainThreadId(bot.id)), async () => {
    await drawn()
    const one = card("t-b")
    assert.ok(one, "the thread's card is on screen")
    await click(one.querySelector("a"))
    assert.ok(text().includes("Thread b"), "the thread opened")
    assert.ok(text().includes("A reply"), "with its own messages")
    await click(find('[aria-label="Back to Cards"]'))
    await until(async () => text().includes(MAIN_MESSAGES[2]), "back on Main")
    assert.ok(cards().length === THREADS.length, "with its cards in place")
  })
})

test("a card and a marker in one gap stand by their own times, not one producer's list", async () => {
  // One message after both, so neither is a tail: the bucket above it holds a move sent first and a
  // thread begun second, and the flow reads them in the order they happened (ADR 0080, ADR 0097).
  const mainId = await reset()
  await db.messages.put(msg("m1", mainId, "user", "the one message", at(-1, 9)))
  await db.conversations.put({
    id: "t-late",
    profileId: bot.id,
    title: "A thread begun this morning",
    hermesSessionId: "gots-t-late",
    createdAt: at(-2, 12),
    updatedAt: at(-2, 12),
    changedAt: 0,
    opener: "The thread's opener",
    openerAt: at(-2, 12),
  })
  await db.conversations.update(mainId, {
    moves: [
      {
        id: "mv1",
        text: "The words that left Main first",
        threadId: "t-keeper",
        at: at(-2, 10),
        undone: false,
        undoable: false,
        new: false,
      },
    ],
  })
  globalThis.fetch = async () => json({})
  await mount(chatScreen(mainId), async () => {
    await until(async () => cards().length === 1, "the thread's card")
    assert.deepEqual(flow(), [
      heading(at(-2, 10)),
      "marker:mv1",
      "card:t-late",
      heading(at(-1, 9)),
      "message:the one message",
    ])
  })
})

/** The thread four messages were triaged into. */
const TAKING = { id: "t-gots", title: "Gots updates & Hermes docker restart" }
const MOVED = [
  { id: "mv1", text: "Update gots plugin for all profiles in hermes container.", at: at(0, 6) },
  { id: "mv2", text: "Update gots plugin for all working profiles please!", at: at(0, 6.1) },
  { id: "mv3", text: "Update gots plugin for all working profiles please!", at: at(0, 6.2) },
  { id: "mv4", text: "Update gots plugin.", at: at(0, 6.3) },
]
const STARTED_LATER = [
  { id: "t-clef", title: "clef:27b vs d3 comparison", createdAt: at(0, 8) },
  { id: "t-compile", title: "Compile requests per month table", createdAt: at(0, 8.5) },
  { id: "t-skill", title: "Create a skill with cli", createdAt: at(0, 9.3) },
  { id: "t-litellm", title: "LiteLLM config", createdAt: at(0, 14) },
]

async function seedTriaged() {
  // No message at all: every turn it held was triaged out, which is the state the report was drawn
  // from and the one nothing else in this file builds.
  const mainId = await reset()
  await db.conversations.bulkPut([
    {
      id: TAKING.id,
      profileId: bot.id,
      title: TAKING.title,
      hermesSessionId: `gots-${TAKING.id}`,
      createdAt: at(-1, 9),
      updatedAt: at(0, 6.3),
      changedAt: 0,
    },
    ...STARTED_LATER.map(({ id, title, createdAt }) => ({
      id,
      profileId: bot.id,
      title,
      hermesSessionId: `gots-${id}`,
      createdAt,
      updatedAt: createdAt,
      changedAt: 0,
    })),
  ])
  await db.conversations.update(mainId, {
    moves: MOVED.map((move) => ({
      id: move.id,
      text: move.text,
      threadId: TAKING.id,
      at: move.at,
      undone: false,
      undoable: false,
      new: false,
    })),
    // The host compacted Main after every message it holds. No divider is drawn for it: a divider
    // stands between two messages, and this Main holds none (compactions.ts).
    compactions: [{ at: at(0, 7), tokens: 8000, window: 200_000 }],
  })
}

const hostWithMoves = () =>
  (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/moves"))
      return json({
        moves: MOVED.map((move) => ({
          ...move,
          thread: TAKING.id,
          undone: false,
          undoable: false,
        })),
      })
    return json({})
  }) as typeof fetch

test("a Main left with no messages reads its moves and its cards by one clock", async () => {
  await seedTriaged()
  globalThis.fetch = hostWithMoves()
  await mount(chatScreen(mainThreadId(bot.id)), async () => {
    await until(
      async () => cards().length === STARTED_LATER.length + 1,
      "Main's cards and the thread its moves name",
    )
    assert.deepEqual(
      flow(),
      [
        heading(at(-1, 9)),
        "card:t-gots",
        heading(at(0, 6)),
        // Every one of these moves was made before the first of these threads began, so all four lead
        // the cards — the order the clock gives them, not the order the screens once appended their
        // lists in. The compaction after everything draws no divider: Main holds no message for one to
        // stand between.
        "marker:mv1",
        "marker:mv2",
        "marker:mv3",
        "marker:mv4",
        "card:t-clef",
        "card:t-compile",
        "card:t-skill",
        "card:t-litellm",
      ],
      "the newest thing in Main is drawn last, under every message triage took before it",
    )
  })
})
