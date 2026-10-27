/**
 * A wake run followed by its transcript, the way a chat follows it when the host's events stream
 * can't be read: the running reply must be the wake run's own words and calls, and the reply the
 * turn before it already finished must stay one message, never copied under it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db, type Profile } from "@/lib/db"
import type { HermesConfig } from "@/lib/hermes"
import { ChatPage } from "@/routes/chat"
import {
  connection,
  json,
  mount,
  seedChat,
  seedSettings,
  until,
  wakePromptText,
} from "./component-kit.tsx"

const server: HermesConfig = connection("wake-follow")
const bot: Profile = {
  id: "bot-1",
  name: "Waker",
  baseUrl: server.baseUrl,
  apiKey: "test-key",
  model: "test/model",
  botId: "bot-1",
  createdAt: 1,
  updatedAt: 1,
}

const SESSION = "chat-1-hermes"
const RUN = "run-wake"
const WAKE_STARTED = 100
const FIRST = "Pass one is applied and committed."
const WOKEN = "The finding changes the plan."

const wake = wakePromptText(
  "A background subagent you dispatched earlier has finished.\n--- RESULT ---\nDone.",
)

const call = (id: string, name: string) => ({
  id,
  type: "function",
  function: { name, arguments: "{}" },
})

/** A finished turn with a call of its own, then the wake run's reply so far. */
const transcript = [
  { id: 1, role: "user", content: "Look into the logs", timestamp: 10 },
  {
    id: 2,
    role: "assistant",
    content: FIRST,
    tool_calls: [call("call-first", "terminal")],
    timestamp: 11,
  },
  {
    id: 3,
    role: "tool",
    tool_call_id: "call-first",
    tool_name: "terminal",
    content: "{}",
    timestamp: 12,
  },
  { id: 4, role: "assistant", content: "Waiting on the subagent.", timestamp: 13 },
  { id: 5, role: "user", content: wake, timestamp: WAKE_STARTED },
  {
    id: 6,
    role: "assistant",
    content: WOKEN,
    tool_calls: [call("call-woken", "patch")],
    timestamp: WAKE_STARTED + 10,
  },
]

let over = false

function host() {
  over = false
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/plugins/memento/runs/live"))
      return json(over ? {} : { sessions: { [SESSION]: "running" }, run_ids: { [SESSION]: RUN } })
    if (url.pathname.endsWith(`/v1/runs/${RUN}/events`)) return json({ error: {} }, 404)
    if (url.pathname.endsWith(`/v1/runs/${RUN}`))
      return json(
        over
          ? { status: "completed", created_at: WAKE_STARTED, output: WOKEN, usage: {} }
          : { status: "running", created_at: WAKE_STARTED },
      )
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: transcript })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

const finished = async () => !(await db.messages.toArray()).some((m) => m.status === "streaming")

test("a wake run followed by its transcript draws its own reply, and the earlier reply once", async () => {
  host()
  await seedSettings()
  await seedChat({ id: "chat-1", profile: bot })
  await db.conversations.update("chat-1", { updatedAt: 2 })
  await mount(
    <MemoryRouter initialEntries={["/c/chat-1"]}>
      <Routes>
        <Route path="/c/:id" element={<ChatPage slot="route" />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      try {
        await until(
          async () =>
            (await db.messages.toArray()).some(
              (m) => m.status === "streaming" && m.content.includes(WOKEN),
            ),
          "the wake run's own words in the running reply",
          10_000,
        )
        const running = (await db.messages.toArray()).filter((m) => m.status === "streaming")
        assert.equal(running.length, 1, "one reply is running")
        assert.ok(
          !running[0].content.includes(FIRST),
          `it is not the earlier reply: ${running[0].content}`,
        )
        assert.deepEqual(
          running[0].tools?.map((tool) => tool.tool),
          ["patch"],
          "and carries only the wake run's calls",
        )
        const earlier = (await db.messages.toArray()).filter(
          (m) => m.role === "assistant" && m.content.includes(FIRST),
        )
        assert.equal(earlier.length, 1, "the earlier reply is held once")
      } finally {
        over = true
        // The failure above is what the case reports; a drain that also hangs adds nothing.
        await until(finished, "the run to end", 10_000).catch(() => {})
      }
    },
  )
})
