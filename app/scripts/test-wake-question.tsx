/**
 * A question asked inside the wake run the plugin posts when a subagent finishes. That run draws no
 * user message, so the chat has to follow it by its reply: without the run followed nothing raises
 * the question, and the thread is left on the clarify call's "Waiting for an answer…".
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db, type Profile } from "@/lib/db"
import { WAKE_PROMPT_FOOTER, WAKE_PROMPT_HEADER } from "@/lib/wake-prompt"
import type { HermesConfig } from "@/lib/hermes"
import { ChatPage } from "@/routes/chat"
import { connection, find, json, mount, seedChat, seedSettings, until } from "./component-kit.tsx"

const server: HermesConfig = connection("wake-question")

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
const QUESTION = "Should the cap cover archived journals?"
const WAKE_STARTED = 100

const WAKE = [
  `${WAKE_PROMPT_HEADER}child-1]`,
  "A background subagent you dispatched earlier has finished.",
  "--- RESULT ---",
  "Done.",
  "",
  `${WAKE_PROMPT_FOOTER} to keep you going]`,
].join("\n")

/** A finished turn, then the wake turn: its prompt, and a clarify call nothing has answered. */
const transcript = [
  { id: 1, role: "user", content: "Look into the logs", timestamp: 10 },
  { id: 2, role: "assistant", content: "On it.", timestamp: 11 },
  { id: 3, role: "user", content: WAKE, timestamp: WAKE_STARTED },
  {
    id: 4,
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call-ask",
        function: {
          name: "clarify",
          arguments: JSON.stringify({ questions: [{ question: QUESTION }] }),
        },
      },
    ],
    timestamp: WAKE_STARTED + 10,
  },
]

/** The delivery's own last words: only the row it arrived in carries them. */
const DELIVERED = "Journals capped at 500M, which frees the most for one line."

/**
 * The transcript above, with the delivery row a finished subagent leaves behind inserted ahead of
 * the wake prompt the host posts for it: bookkeeping the thread draws nothing for, and one the run
 * would own if the fold read it as a turn of its own.
 */
const delivered = [
  { id: 1, role: "user", content: "Look into the logs", timestamp: 10 },
  { id: 2, role: "assistant", content: "On it.", timestamp: 11 },
  // Inside the window `adoptRun` follows (the run's start less its 5s slack), as the host writes it
  // just before the wake prompt: a row from before the run could not stand in for this case.
  {
    id: 3,
    role: "user",
    display_kind: "async_delegation_complete",
    content: [
      "[ASYNC DELEGATION COMPLETE — d-1]",
      "A background subagent you dispatched earlier has finished.",
      "Original goal: look into the logs",
      "--- RESULT ---",
      DELIVERED,
    ].join("\n"),
    timestamp: WAKE_STARTED - 1,
  },
  { id: 4, role: "user", content: WAKE, timestamp: WAKE_STARTED },
  {
    id: 5,
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call-ask",
        function: {
          name: "clarify",
          arguments: JSON.stringify({ questions: [{ question: QUESTION }] }),
        },
      },
    ],
    timestamp: WAKE_STARTED + 10,
  },
]

/** The run ends once the test is done with it, so nothing keeps following it. */
let over = false

function host(rows = transcript) {
  over = false
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/plugins/memento/runs/live"))
      return json(
        over
          ? {}
          : {
              sessions: { [SESSION]: "waiting_for_approval" },
              run_ids: { [SESSION]: RUN },
            },
      )
    // Only the run's status carries the question: the events stream is gone.
    if (url.pathname.endsWith(`/v1/runs/${RUN}/events`)) return json({ error: {} }, 404)
    if (url.pathname.endsWith(`/v1/runs/${RUN}`) && over)
      return json({ status: "completed", created_at: WAKE_STARTED, output: "", usage: {} })
    if (url.pathname.endsWith(`/v1/runs/${RUN}`))
      return json({
        status: "waiting_for_approval",
        created_at: WAKE_STARTED,
        clarify: {
          event: "clarify.request",
          run_id: RUN,
          clarify_id: "ask-1",
          questions: [
            { id: "q0", question: QUESTION, choices: ["Yes", "No"], multi_select: false },
          ],
        },
      })
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: rows })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

test("a question asked in a wake run reaches the user as a form", async () => {
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
      await until(async () => Boolean(find("button[aria-pressed]")), "the question's form", 10_000)
      assert.ok(
        [...document.querySelectorAll("button")].some((one) => one.textContent?.startsWith("Yes")),
        "its choices can be picked",
      )
      assert.ok(
        [...document.querySelectorAll("button")].some((one) => one.textContent === "Send"),
        "and sent",
      )
      over = true
      await until(
        async () => !(await db.messages.toArray()).some((m) => m.status === "streaming"),
        "the run to end",
        10_000,
      )
    },
  )
})

test("a delivery ahead of that wake run draws nothing, and its question still reaches the user", async () => {
  host(delivered)
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
      // The #573 guard holds with a delivery ahead of the wake turn too: the form still takes the
      // composer's place, so nothing waits on an answer the user can't see.
      await until(async () => Boolean(find("button[aria-pressed]")), "the question's form", 10_000)
      assert.ok(
        [...document.querySelectorAll("button")].some((one) => one.textContent?.startsWith("Yes")),
        "its choices can be picked",
      )
      assert.ok(
        [...document.querySelectorAll("button")].some((one) => one.textContent === "Send"),
        "and sent",
      )
      // A delivery is bookkeeping: it drew no row, and no stored message holds what it said.
      assert.ok(
        ![...document.querySelectorAll("[data-slot=message]")].some((row) =>
          row.textContent?.includes(DELIVERED),
        ),
        "the delivery draws nothing of the thread",
      )
      const stored = await db.messages.toArray()
      assert.ok(
        !stored.some((message) => message.content.includes(DELIVERED)),
        "and stores no message of its own",
      )
      assert.equal(
        stored.length,
        3,
        "the first turn's two messages and the wake run's reply, the delivery adding none",
      )
      assert.equal(
        document.querySelectorAll("[data-slot=message]").length,
        stored.length,
        "the thread draws one row per message, and none for the delivery",
      )
      over = true
      await until(
        async () => !(await db.messages.toArray()).some((m) => m.status === "streaming"),
        "the run to end",
        10_000,
      )
    },
  )
})
