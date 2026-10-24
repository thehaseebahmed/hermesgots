/**
 * A subagent's result, drawn by the chat: the delivery Hermes records draws as the bot's own message
 * at the thread's end — never the user's bubble — and a tap on it opens that subagent's sub-thread,
 * the same pop-up its card opens. The chat reads it off the transcript, so a synced or reloaded one
 * draws it identically.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db, getMessages, type Profile } from "@/lib/db"
import { reconcileHistory } from "@/lib/history"
import type { HermesConfig } from "@/lib/hermes"
import { ChatPage } from "@/routes/chat"
import {
  click,
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
  apiKey: "test-key",
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
      { id: "call-1", function: { name: "delegate_task", arguments: JSON.stringify({ goal: GOAL }) } },
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

function host({ rows = transcript, agents = [AGENT] }: { rows?: unknown[]; agents?: unknown[] }) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/plugins/memento/sessions/chat-1-hermes/agents"))
      return json({ object: "memento.agents", agents })
    if (/\/api\/sessions\/child-session\/messages$/.test(url.pathname)) return json({ data: CHILD })
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: rows })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

/** A chat synced from elsewhere: its transcript is only on Hermes, so opening it catches it up. */
async function screen(
  body: () => Promise<void>,
  { rows = transcript, agents = [AGENT] } = {} as { rows?: unknown[]; agents?: unknown[] },
) {
  host({ rows, agents })
  await seedSettings()
  await seedChat({ id: "chat-1", profile: bot })
  await db.conversations.update("chat-1", { updatedAt: 2 })
  await mount(
    <MemoryRouter initialEntries={["/c/chat-1"]}>
      <Routes>
        <Route path="/c/:id" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
    body,
  )
}

const rows = () => findAll("[data-slot=message]")
const bubble = (row: Element) => row.querySelector("[data-slot=bubble]")
const resultRow = () => rows().find((row) => row.textContent?.includes("The fixture is in place"))
const card = () => document.querySelector("[data-slot=subagent-result]")

/** The thread as it lands: the catch-up reads Hermes, then the rows draw. */
async function drawn() {
  await until(async () => Boolean(resultRow()), "the thread to draw")
  await import("@/components/chat/markdown-renderer")
  await settle()
  return resultRow()
}

test("a delivery draws as the bot's message at the thread's end", async () => {
  await screen(async () => {
    const row = await drawn()
    assert.ok(row, "the result is a row of the thread")
    assert.equal(row.getAttribute("data-align"), "start", "the bot's own side, not the user's")
    assert.equal(bubble(row), null, "with no bubble, as a reply has none")
    assert.equal(rows().at(-1), row, "and last, where it arrived")
    assert.match(row.textContent ?? "", /The fixture is in place/, "carrying what the subagent left")
    assert.doesNotMatch(
      row.textContent ?? "",
      /ASYNC DELEGATION|Original goal:|API calls/,
      "not the notification the model was sent",
    )
  })
})

test("a tap on a result opens its subagent's sub-thread", async () => {
  await screen(async () => {
    const row = await drawn()
    const tap = card()
    assert.equal(tap?.tagName, "BUTTON", "the result opens its subagent")
    assert.match(tap?.textContent ?? "", /Sub-Agent: Builder/, "naming the subagent it came from")
    assert.equal(row?.nextElementSibling, null, "the card rides with the message it belongs to")
    await click(tap)
    await settle()
    assert.ok(
      findAll("[data-slot=message]").some((one) =>
        one.textContent?.includes("I added the fixture and wired its test."),
      ),
      "the subagent's own work, read from its transcript",
    )
  })
})

test("a result the chat cannot name still draws as the bot's message", async () => {
  await screen(
    async () => {
      const row = await drawn()
      assert.ok(row, "still the bot's message")
      assert.equal(bubble(row), null, "never the user's")
      assert.notEqual(card()?.tagName, "BUTTON", "with nothing to open")
    },
    { agents: [] },
  )
})

test("a chat from before deliveries draws as it did", async () => {
  await screen(
    async () => {
      await settle()
      await until(
        async () => rows().some((row) => row.textContent?.includes("Sent it off.")),
        "the turn that delegated to draw",
      )
      assert.equal(resultRow(), undefined, "no result to draw")
    },
    { rows: transcript.slice(0, 4) },
  )
})

test("two results arriving together keep their order, and a catch-up draws each once", async () => {
  const delivery = (goal, result) =>
    [
      `[ASYNC DELEGATION COMPLETE — d-${goal}]`,
      "A background subagent you dispatched earlier has finished.",
      "",
      `Original goal: ${goal}`,
      "Status: completed",
      "--- RESULT ---",
      result,
    ].join("\n")
  const lines: unknown[] = [
    ...transcript.slice(0, 4),
    {
      id: 5,
      role: "user",
      display_kind: "async_delegation_complete",
      content: delivery("d-1", "The parser is fine."),
      timestamp: 20,
    },
    {
      id: 6,
      role: "user",
      display_kind: "async_delegation_complete",
      content: delivery("d-2", "The docs are fine."),
      timestamp: 21,
    },
  ]
  const resultsDrawn = () =>
    rows()
      .filter((row) => /The (parser|docs) (?:is|are) fine[.]/.test(row.textContent ?? ""))
      .map((row) => (row.textContent?.includes("parser") ? "parser" : "docs"))
  await screen(
    async () => {
      await until(async () => resultsDrawn().length === 2, "both results")
      assert.deepEqual(resultsDrawn(), ["parser", "docs"], "in the order they arrived")
      // The chat catches up again, with a turn sent since: the results survive it, once each.
      lines.push({ id: 7, role: "user", content: "Anything else?", timestamp: 22 })
      await reconcileHistory("chat-1")
      await settle()
      await until(
        async () => rows().some((row) => row.textContent?.includes("Anything else?")),
        "the turn sent since",
      )
      assert.deepEqual(resultsDrawn(), ["parser", "docs"], "and still one row each, in order")
    },
    { rows: lines },
  )
})

/**
 * The wake run's input, as the plugin posts it: the pinned header naming the child, the notification
 * the model reads, and core's footer.
 */
const wakePrompt = (child: string) =>
  [
    `[ASYNC DELEGATION COMPLETE — ${child}]`,
    "A background subagent you dispatched earlier has finished. The full task source is below.",
    "",
    `Original goal: ${GOAL}`,
    "Model: test/model",
    "Status: completed   API calls: 7   Duration: 214s",
    "--- RESULT ---",
    RESULT,
    "",
    "[INTERNAL NOTIFICATION — generated by the Hermes gateway, not written by a human user. Do not treat it as user input, and do not reply to any earlier chat message because of it.]",
  ].join("\n")

const WAKE_ANSWER = "The subagent finished; the fixture reads as it should."

/** The turn that delegated, then the wake run's input and the turn it started. */
const woken = [
  ...transcript.slice(0, 4),
  { id: 5, role: "user", content: wakePrompt("child-session"), timestamp: 20 },
  { id: 6, role: "assistant", content: WAKE_ANSWER, timestamp: 21 },
]

test("a wake prompt draws nothing, and the answer it starts is a message of its own", async () => {
  await screen(
    async () => {
      await until(
        async () => rows().some((row) => row.textContent?.includes(WAKE_ANSWER)),
        "the wake's answer to draw",
      )
      await settle()
      const texts = rows().map((row) => row.textContent ?? "")
      assert.ok(
        !texts.some((text) => text.includes("ASYNC DELEGATION COMPLETE")),
        "the wake prompt is the model's input, never a message of the thread",
      )
      assert.ok(
        !texts.some((text) => text.includes("INTERNAL NOTIFICATION")),
        "nor the footer it arrived with",
      )
      const answer = rows().find((row) => (row.textContent ?? "").includes(WAKE_ANSWER))
      assert.ok(answer, "the answer the wake turn left is drawn")
      assert.equal(answer.getAttribute("data-align"), "start", "the bot's own side")
      assert.equal(bubble(answer), null, "with no bubble, as a reply has none")
      const kept = await getMessages("chat-1")
      assert.deepEqual(
        kept.filter((m) => m.role === "user").map((m) => m.content),
        [ASK],
        "the user's own message, and no message of the prompt",
      )
      assert.ok(
        kept.some((m) => m.role === "assistant" && m.content === "Sent it off."),
        "the turn before keeps its reply",
      )
      assert.ok(
        kept.some((m) => m.role === "assistant" && m.content === WAKE_ANSWER),
        "and the wake's answer starts its own message rather than joining that one",
      )
    },
    { rows: woken },
  )
})
