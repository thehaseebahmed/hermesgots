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
  json,
  mount,
  seedSettings,
  settle,
  text,
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

async function seed() {
  await seedSettings({ developer: true, botThreads: true })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await ensureMainThread(bot.id)
  const mainId = mainThreadId(bot.id)
  await db.messages.bulkPut([
    msg("m1", mainId, "user", MAIN_MESSAGES[0], at(-3, 9)),
    msg("m2", mainId, "user", MAIN_MESSAGES[1], at(-2, 9)),
    msg("m3", mainId, "user", MAIN_MESSAGES[2], at(0, 9)),
  ])
  await db.conversations.bulkPut(
    THREADS.map(({ id, title, createdAt, muted }) => ({
      id,
      profileId: bot.id,
      title,
      hermesSessionId: `memento-${id}`,
      createdAt,
      updatedAt: createdAt,
      changedAt: 0,
      muted,
    })),
  )
  await db.messages.bulkPut([
    msg("a-1", "t-a", "user", "Something about a plan", at(-3, 11)),
    msg("b-1", "t-b", "user", "Thread b's opener", at(-2, 11)),
    msg("b-2", "t-b", "assistant", "A reply", at(-2, 12)),
    msg("d-1", "t-d", "user", "Thread d's opener", at(-2, 13)),
    msg("c-1", "t-c", "user", "Thread c's opener", at(0, 11)),
  ])
}

const content = () => find('[data-slot="message-scroller-content"]')

function flow() {
  return [...(content()?.children ?? [])]
    .filter((child) => !child.hasAttribute("data-message-scroller-spacer"))
    .map((child) => {
      const slot = child.getAttribute("data-slot")
      const said = child.textContent?.trim() ?? ""
      if (slot === "day-heading") return `day:${said}`
      if (slot === "thread-card")
        return `card:${THREADS.find((thread) => said.includes(thread.title))?.title ?? said}`
      if (slot === "message-scroller-item")
        return `message:${MAIN_MESSAGES.find((said_) => said.includes(said_)) ?? said}`
      return `other:${said}`
    })
}

const cards = () => findAll('[data-slot="thread-card"]')
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
      "card:Thread a",
      heading(at(-2, 9)),
      `message:${MAIN_MESSAGES[1]}`,
      "card:Thread b",
      "card:Thread d",
      heading(at(0, 9)),
      `message:${MAIN_MESSAGES[2]}`,
      "card:Thread c",
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
    assert.ok(cards().every((card) => !card.textContent?.includes("Main")))
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
    const card = cards().find((one) => one.textContent?.includes("Thread b"))
    assert.ok(card?.textContent?.includes("2 replies"), "the card reads the thread's new state")
  })
})

test("a card reads as it did on the bot's screen", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(chatScreen(mainThreadId(bot.id)), async () => {
    await drawn()
    const card = cards().find((one) => one.textContent?.includes("Thread b"))
    assert.ok(card, "the thread's card is on screen")
    assert.ok(card.textContent?.includes("Thread b's opener"), "its opener above it")
    assert.ok(card.textContent?.includes("Thread b"), "its title")
    assert.ok(card.textContent?.includes("1 reply"), "how many replies it has")
    assert.ok(card.querySelector("svg.lucide-message-circle"), "its state, an icon")
    const muted = cards().find((one) => one.textContent?.includes("Thread d"))
    assert.ok(muted?.querySelector('[aria-label="Muted"]'), "a muted thread's mark")
  })
})

test("tapping a card opens its thread, and back returns to Main", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(chatScreen(mainThreadId(bot.id)), async () => {
    await drawn()
    const card = cards().find((one) => one.textContent?.includes("Thread b"))
    assert.ok(card, "the thread's card is on screen")
    await click(card.querySelector("a"))
    assert.ok(text().includes("Thread b"), "the thread opened")
    assert.ok(text().includes("A reply"), "with its own messages")
    await click(find('[aria-label="Back to Cards"]'))
    assert.ok(text().includes(MAIN_MESSAGES[2]), "back on Main")
    assert.ok(cards().length === THREADS.length, "with its cards in place")
  })
})
