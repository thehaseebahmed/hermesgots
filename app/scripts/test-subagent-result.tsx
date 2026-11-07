/**
 * A subagent's delivery, drawn by the chat: the row Hermes records draws nothing in the thread — the
 * turn's reply stays the last thing there — and the subagent's finding is read one tap away, in the
 * sub-thread its card opens. The chat reads the transcript, so a synced or reloaded one draws the
 * same thread.
 */
import { BUSY_WORDS } from "@/lib/busy-words"
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db, getMessages, type Message, type Profile } from "@/lib/db"
import { reconcileHistory } from "@/lib/history"
import type { HermesConfig } from "@/lib/hermes"
import { ChatPage } from "@/routes/chat"
import {
  connection,
  findAll,
  json,
  mount,
  seedChat,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"

const server: HermesConfig = connection("subagent-result")

const bot: Profile = {
  id: "bot-1",
  name: "Results",
  baseUrl: server.baseUrl,
  // No key: the current screen is the one that draws a bot it cannot call.
  apiKey: undefined,
  model: "test/model",
  botId: "bot-1",
  createdAt: 1,
  updatedAt: 1,
}

const GOAL = "Builder: add the subagent fixture"
const ASK = "Add the fixture, would you?"
const RESULT = "The fixture is in place, with its test."

const DELIVERY = [
  "[ASYNC DELEGATION COMPLETE — d-1]",
  "A background subagent you dispatched earlier has finished. The full task source is below.",
  "",
  "Dispatched: 2026-10-23 10:00:00 (2 min ago)",
  `Original goal: ${GOAL}`,
  "Role: leaf   Model: test/model",
  "Status: completed   API calls: 12   Duration: 96.4s",
  "--- RESULT ---",
  RESULT,
].join("\n")

/** A turn that delegated, then the delivery Hermes wrote when the subagent finished. */
const transcript = [
  { id: 1, role: "user", content: ASK, timestamp: 10 },
  {
    id: 2,
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call-1",
        function: { name: "delegate_task", arguments: JSON.stringify({ goal: GOAL }) },
      },
    ],
    timestamp: 11,
  },
  {
    id: 3,
    role: "tool",
    tool_call_id: "call-1",
    tool_name: "delegate_task",
    content: JSON.stringify({
      status: "dispatched",
      mode: "background",
      count: 1,
      delegation_id: "d-1",
      goals: [GOAL],
      subagent_ids: ["sa-0-ab12cd34"],
      note: "Subagent is running in the background.",
    }),
    timestamp: 12,
  },
  { id: 4, role: "assistant", content: "Sent it off.", timestamp: 13 },
  {
    id: 5,
    role: "user",
    display_kind: "async_delegation_complete",
    content: DELIVERY,
    timestamp: 20,
  },
]

const CHILD = [
  { id: 1, role: "user", content: GOAL, timestamp: 11 },
  { id: 2, role: "assistant", content: "I added the fixture and wired its test.", timestamp: 19 },
]

const AGENT = {
  id: "child-session",
  goal: GOAL,
  model: "test/model",
  started_at: 100,
  ended_at: 190,
  tool_calls: 3,
  status: "done",
}

const RUN = "run-live"

/** A route the streaming cases need: the run a reply this device is writing still works. */
type RunRoute = (url: URL) => Response | undefined

function host({
  rows = transcript,
  agents = [AGENT],
  run,
}: {
  rows?: unknown[]
  agents?: unknown[]
  run?: RunRoute
}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const answered = run?.(url)
    if (answered) return answered
    if (url.pathname.endsWith("/plugins/gots/sessions/chat-1-hermes/agents"))
      return json({ object: "gots.agents", agents })
    if (/\/api\/sessions\/child-session\/messages$/.test(url.pathname)) return json({ data: CHILD })
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: rows })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

/**
 * The run behind a reply this device is still writing, until `end()`: its events are gone, so the
 * reply is followed by the run's status alone, and that status holds it streaming for as long as a
 * test looks at it. A run left running would keep following forever, so every case ends it.
 */
function followedRun() {
  let over = false
  const run = (url: URL) => {
    if (url.pathname.endsWith("/plugins/gots/runs/live"))
      return json(
        over ? {} : { sessions: { "chat-1-hermes": "running" }, run_ids: { "chat-1-hermes": RUN } },
      )
    if (url.pathname.endsWith(`/v1/runs/${RUN}/events`))
      return new Response("", { headers: { "content-type": "text/event-stream" } })
    if (url.pathname.endsWith(`/v1/runs/${RUN}`))
      return json(
        over
          ? { status: "completed", created_at: 100, output: "", usage: {} }
          : { status: "running", created_at: 100, output: "", usage: {} },
      )
    return undefined
  }
  return {
    run,
    end: () => {
      over = true
    },
  }
}

/** Waits for the run this device was following to settle, so nothing follows it past the test. */
async function settledRun() {
  await until(
    async () => !(await db.messages.toArray()).some((m) => m.status === "streaming"),
    "the run to end",
    10_000,
  )
}

/** A chat synced from elsewhere: its transcript is only on Hermes, so opening it catches it up. */
async function screen(
  body: () => Promise<void>,
  { rows = transcript, agents = [AGENT], messages = [], run } = {} as {
    rows?: unknown[]
    agents?: unknown[]
    messages?: Message[]
    run?: RunRoute
  },
) {
  host({ rows, agents, run })
  await seedSettings()
  await seedChat({ id: "chat-1", profile: bot, messages })
  await db.conversations.update("chat-1", { updatedAt: 2 })
  await mount(
    <MemoryRouter initialEntries={["/c/chat-1"]}>
      <Routes>
        <Route path="/c/:id" element={<ChatPage slot="route" />} />
      </Routes>
    </MemoryRouter>,
    body,
  )
}

const rows = () => findAll("[data-slot=message]")

const drawn = () =>
  rows().map((row) => `${row.getAttribute("data-align")}:${row.textContent ?? ""}`)

/**
 * The reported case: a subagent finishes while this device is still writing a reply, so the delivery
 * Hermes records lands after a turn whose reply is streaming. Nothing may be pinned under that reply,
 * and no catch-up may make a row appear or go.
 */
test("nothing pins under a reply that is still streaming, and nothing goes", async () => {
  // This device's turn, its reply still streaming, before Hermes wrote that reply's own row.
  const said: Message = {
    id: "said-1",
    conversationId: "chat-1",
    role: "user",
    content: ASK,
    status: "done",
    createdAt: 10,
    hermesRowId: 1,
    hermesAt: 10_000,
  }
  const writing: Message = {
    id: "reply-1",
    conversationId: "chat-1",
    role: "assistant",
    content: "Sent it off",
    tools: [],
    status: "streaming",
    createdAt: 14,
    runId: RUN,
  }
  // Hermes holds that turn as far as its delegate call, then the delivery the subagent left.
  const hostRows = [...transcript.slice(0, 3), transcript[4]]
  const run = followedRun()
  const deliveryShown = () =>
    rows().some((row) => /ASYNC DELEGATION|Original goal:|API calls/.test(row.textContent ?? ""))
  await screen(
    async () => {
      try {
        await until(
          async () => rows().some((row) => row.textContent?.includes("Sent it off")),
          "the streaming reply to draw",
        )
        await settle()
        const before = drawn()
        assert.equal(before.length, 2, "the user's message, and the reply still streaming")
        assert.match(
          rows().at(-1)?.textContent ?? "",
          new RegExp(`Sent it off.*(${BUSY_WORDS.writing.join("|")})…`),
          "the reply is the thread's last row, and says it is still writing",
        )
        // A catch-up lands while that reply streams: Hermes has news of a finished subagent.
        await reconcileHistory("chat-1")
        await settle()
        assert.deepEqual(drawn(), before, "the catch-up draws nothing under the streaming reply")
        // The poll asks again a moment later, as it would.
        await reconcileHistory("chat-1")
        await settle()
        assert.deepEqual(drawn(), before, "nor does the next one take anything away")
        assert.ok(!deliveryShown(), "and nothing of the delivery is drawn anywhere")
        // The reply's stream ends: the catch-up after it is the one that reads the delivery row.
        await db.messages.update("reply-1", { status: "done" })
        await settle()
        const ended = drawn()
        await reconcileHistory("chat-1")
        await settle()
        assert.deepEqual(drawn(), ended, "the catch-up that reads the delivery changes nothing")
        assert.match(
          rows().at(-1)?.textContent ?? "",
          /Sent it off/,
          "the reply keeps the last row",
        )
        assert.ok(!deliveryShown(), "and the delivery is still drawn nowhere")
        const stored = await getMessages("chat-1")
        assert.equal(
          stored.filter((m) => /ASYNC DELEGATION|Original goal:/.test(m.content ?? "")).length,
          0,
          "the delivery was never a message of the thread",
        )
        // Writing again, so the run this test ends is what settles the reply and lets it go.
        await db.messages.update("reply-1", { status: "streaming" })
        await settle()
      } finally {
        // The database outlives the test, and so would a run nothing stops following.
        run.end()
        await settledRun()
      }
    },
    { messages: [said, writing], rows: hostRows, run: run.run },
  )
})

/**
 * The wake run the plugin starts draws no user message, so a catch-up learns it from its reply alone
 * and adopts that reply for the run. Doing so must keep the one row the catch-up wrote for it — a
 * user never sees it go and come back under another id — and the delivery before it draws nothing.
 */