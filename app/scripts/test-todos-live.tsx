/**
 * The todos pill's stop mark against the one definition of "the run is over": the run has ended
 * and no subagent it left at work still runs — the same answer `session-work.ts` reads for a
 * session's Working. The pill read it from this device's own streaming row alone, so a run the
 * host still holds, or one whose subagents still work after its turn ended, drew the pause.
 *
 * Assertions hold a boolean rather than the element itself: node:test serialises an assertion's
 * `actual`, and a DOM node reaches the whole document through it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db, type Message, type Todo } from "@/lib/db"
import {
  botProfile,
  chatScreen,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
} from "./component-kit.tsx"

const bot = botProfile("todos-live", { name: "Todos" })

const ID = "chat-1"
const SESSION = `${ID}-hermes`

/** One item the agent left in progress, and the progress the plugin worked out over the list. */
const items: Todo[] = [
  { id: "t1", content: "Read the parser", status: "completed", depth: 0 },
  { id: "t2", content: "Fix the off-by-one", status: "in_progress", depth: 0 },
]

const todos = { revision: 1, items, progress: { done: 1, total: 2 }, at: 1 }

const turn: Message[] = [
  {
    id: "ask",
    conversationId: "",
    role: "user",
    content: "Fix the parser",
    status: "done",
    createdAt: 1,
  },
  {
    id: "reply",
    conversationId: "",
    role: "assistant",
    content: "On it.",
    status: "done",
    createdAt: 2,
  },
]

/** What the host says of this session, merged over an answer that names nothing at all. */
function host(live: Record<string, unknown> = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/plugins/memento/runs/live"))
      return json({ sessions: {}, run_ids: {}, waiting: {}, subagents: {}, ...live })
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: [] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

async function screen(live: Record<string, unknown>, body: () => Promise<void>) {
  host(live)
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put({
    id: ID,
    profileId: bot.id,
    title: "A chat",
    hermesSessionId: SESSION,
    todos,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
  await db.messages.bulkPut(turn.map((message) => ({ ...message, conversationId: ID })))
  await mount(chatScreen(ID), body)
}

/** The pill above the composer, and whether it wears the stop mark. */
const pill = () => findAll("button").find((button) => /\btodos\b/.test(button.textContent ?? ""))
const stopped = () => Boolean(pill()?.querySelector('[aria-label="Stopped"]'))

test("a run the host still holds never reads as stopped", async () => {
  await screen({ sessions: { [SESSION]: "running" }, run_ids: { [SESSION]: "run-1" } }, async () => {
    await settle()
    assert.ok(pill(), "the todos pill is drawn")
    assert.ok(!stopped(), "its item in progress still spins while the run runs")
  })
})

test("a subagent still at work after the turn ended never reads as stopped", async () => {
  await screen({ subagents: { [SESSION]: 1 } }, async () => {
    await settle()
    assert.ok(pill(), "the todos pill is drawn")
    assert.ok(!stopped(), "the run has not finished while a subagent it left still works")
  })
})

test("a run that really has finished draws its stop mark", async () => {
  await screen({}, async () => {
    await settle()
    assert.ok(pill(), "the todos pill is drawn")
    assert.ok(stopped(), "nothing of the run is left at work, so the item reads as stopped")
  })
})
