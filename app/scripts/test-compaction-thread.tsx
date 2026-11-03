/**
 * The divider a thread draws where the host compacted a chat's context: the device reads the host's
 * list when the chat opens, keeps it on the conversation, and the first message written after the
 * compaction carries the divider above it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db, type Message } from "@/lib/db"
import { ChatPage } from "@/routes/chat"

import { botProfile, chatScreen, findAll, json, mount, seedChat, until } from "./component-kit.tsx"

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
  {
    id: "ask-1",
    conversationId: "",
    role: "user",
    content: FIRST,
    status: "done",
    createdAt: 1_000,
  },
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

/** What the thread drew, read while it is on the page: its dividers, and where one landed. */
interface Drawn {
  dividers: number
  /** The row holding the divider, and the row holding the message it was asked about. */
  place: { divider: number; after: number }
}

const dividers = () => findAll("[role=separator]")

/** What the thread has drawn: its dividers, and the row holding the message asked about. */
const drawnNow = (text = SECOND): Drawn => {
  const drawn = dividers()
  const items = findAll("[data-slot=message-scroller-item]")
  return {
    dividers: drawn.length,
    place: {
      divider: items.findIndex((item) => drawn.some((one) => item.contains(one))),
      after: items.findIndex((item) => item.textContent?.includes(text)),
    },
  }
}

async function screen(compactions: unknown[], id = "chat-1"): Promise<Drawn> {
  host(compactions)
  await seedChat({ id, messages: turn, profile: bot })
  let seen: Drawn = { dividers: 0, place: { divider: -1, after: -1 } }
  await mount(chatScreen(id), async () => {
    await until(async () => findAll("[data-slot=message]").length > 0, "the thread's rows")
    // The divider's words ride the markdown renderer, a lazy import on this route.
    await import("@/components/chat/markdown-renderer")
    if (compactions.length) await until(async () => dividers().length > 0, "the divider")
    seen = drawnNow()
  })
  return seen
}

test("the compaction the host recorded draws its divider above the next message", async () => {
  const drawn = await screen([{ at: AT, tokens: 168_000, window: 200_000 }], "chat-divided")
  assert.equal(drawn.dividers, 1, `one divider, found ${drawn.dividers}`)
  assert.equal(drawn.place.divider, drawn.place.after, "it sits on the turn after the compaction")
  // And the device keeps the host's list, so a reload draws it again from what it has.
  const conversation = await db.conversations.get("chat-divided")
  assert.deepEqual(
    conversation?.compactions?.map((one) => one.at),
    [AT],
    "the device kept the host's record",
  )
})

test("a device that loaded the chat after it was compacted still marks it", async () => {
  // The second device's view: Hermes keeps the rows a compaction took away off the transcript, so
  // everything this one loads is newer than the mark and the divider stands above the first of them.
  const drawn = await screen([{ at: 900 }], "chat-fresh")
  assert.equal(drawn.dividers, 1, `one divider, found ${drawn.dividers}`)
  assert.equal(drawn.place.divider, 0, "it stands above the first message held")
})

test("a chat the host never compacted draws nothing", async () => {
  const drawn = await screen([], "chat-open")
  assert.equal(drawn.dividers, 0, "no compaction, no divider")
})

test("a compaction newer than every message waits for the row written after it", async () => {
  const id = "chat-waiting"
  const AFTER = "the ask written after it"
  host([{ at: 3_000 }])
  await seedChat({ id, messages: turn, profile: bot })
  await mount(chatScreen(id), async () => {
    await until(async () => findAll("[data-slot=message]").length > 0, "the thread's rows")
    await import("@/components/chat/markdown-renderer")
    assert.equal(drawnNow().dividers, 0, "no divider at the foot of a thread holding messages")

    await db.messages.put({
      id: "ask-3",
      conversationId: id,
      role: "user",
      content: AFTER,
      status: "done",
      createdAt: 4_000,
    })
    await until(async () => drawnNow().dividers > 0, "the divider the next message gives it")
    const drawn = drawnNow(AFTER)
    assert.equal(drawn.dividers, 1, "one divider, not a second one at the foot")
    assert.equal(drawn.place.divider, drawn.place.after, "it sits above the row written after it")
  })
})
