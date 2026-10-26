/**
 * The divider a thread draws where the host compacted a chat's context: the device reads the host's
 * list when the chat opens, keeps it on the conversation, and the first message written after the
 * compaction carries the divider above it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db, type Message } from "@/lib/db"
import { ChatPage } from "@/routes/chat"

import { botProfile, chatScreen, json, mount, seedSettings, settle } from "./component-kit.tsx"

const bot = botProfile("compaction")
const FIRST = "first turn's work"
const SECOND = "second turn's work"
// On the host's clock, between the two turns.
const AT = 1_050

async function host(compactions: unknown[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: [] })
    if (/\/api\/plugins\/memento\/sessions\/[^/]+\/context$/.test(url.pathname))
      return json({ object: "memento.context", prompt_tokens: 4_200, compactions })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

const turn: Message[] = [
  { id: "ask-1", conversationId: "", role: "user", content: FIRST, status: "done", createdAt: 1_000 },
  {
    id: "reply-1",
    conversationId: "",
    role: "assistant",
    content: "It came down fine.",
    status: "done",
    createdAt: 1_010,
  },
  {
    id: "ask-2",
    conversationId: "",
    role: "user",
    content: SECOND,
    status: "done",
    createdAt: 2_000,
  },
  {
    id: "reply-2",
    conversationId: "",
    role: "assistant",
    content: "And the second too.",
    status: "done",
    createdAt: 2_010,
  },
]

/** What the thread drew, read while it is on the page: its rows, and where each divider landed. */
interface Drawn {
  dividers: string[]
  items: number
  messages: number
  /** The row holding the divider, and the row holding the turn after the compaction. */
  place: { divider: number; second: number }
}

const dividers = () => [...document.querySelectorAll("[role=separator]")]

async function screen(compactions: unknown[]): Promise<Drawn> {
  host(compactions)
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put({
    id: "chat-1",
    profileId: bot.id,
    title: "A chat",
    hermesSessionId: "chat-1-hermes",
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
  await db.messages.bulkPut(turn.map((message) => ({ ...message, conversationId: "chat-1" })))
  let seen: Drawn = { dividers: [], items: 0, messages: 0, place: { divider: -1, second: -1 } }
  await mount(chatScreen("chat-1"), async () => {
    // The thread's markdown chunk is behind a lazy import; its rows land when it does.
    await import("@/components/chat/markdown-renderer")
    for (let tries = 0; tries < 20 && dividers().length === 0; tries += 1) await settle()
    const drawn = dividers()
    const items = [...document.querySelectorAll("[data-slot=message-scroller-item]")]
    seen = {
      dividers: drawn.map((one) => one.textContent?.trim() ?? ""),
      items: items.length,
      messages: document.querySelectorAll("[data-slot=message]").length,
      place: {
        divider: items.findIndex((item) => drawn.some((one) => item.contains(one))),
        second: items.findIndex((item) => item.textContent?.includes(SECOND)),
      },
    }
  })
  return seen
}

test("the compaction the host recorded draws its divider above the next message", async () => {
  const drawn = await screen([{ at: AT, tokens: 168_000, window: 200_000 }])
  assert.equal(drawn.items > 0, true, `the thread drew its rows (${drawn.messages} messages)`)
  assert.equal(drawn.dividers.length, 1, `one divider, found ${drawn.dividers.length}`)
  assert.match(drawn.dividers[0] ?? "", /^Compaction/, "it says what it marks")
  assert.match(drawn.dividers[0] ?? "", /168k of 200k/, "and how full the context was")
  // Above the first message written after it, in that message's own row.
  assert.equal(drawn.place.divider, drawn.place.second, "it sits on the turn after the compaction")
  // And the device keeps the host's list, so a reload draws it again from what it has.
  const conversation = await db.conversations.get("chat-1")
  assert.deepEqual(
    conversation?.compactions?.map((one) => one.at),
    [AT],
    "the device kept the host's record",
  )
})

test("a chat the host never compacted draws nothing", async () => {
  const drawn = await screen([])
  assert.equal(drawn.items > 0, true, `the thread drew its rows (${drawn.messages} messages)`)
  assert.deepEqual(drawn.dividers, [], "no compaction, no divider")
})
