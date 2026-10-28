/**
 * A subagent's delivery, drawn by the chat: the row Hermes records draws nothing in the thread — the
 * turn's reply stays the last thing there — and the subagent's finding is read one tap away, in the
 * sub-thread its card opens. The chat reads the transcript, so a synced or reloaded one draws the
 * same thread.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db, getMessages, type Message, type Profile } from "@/lib/db"
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
    if (url.pathname.endsWith("/plugins/memento/sessions/chat-1-hermes/agents"))
      return json({ object: "memento.agents", agents })
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
    if (url.pathname.endsWith("/plugins/memento/runs/live"))
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
const bubble = (row: Element) => row.querySelector("[data-slot=bubble]")
/** A thread row carrying the subagent's finding, if one is drawn at all. */
const resultRow = () => rows().find((row) => row.textContent?.includes("The fixture is in place"))
const agentCard = () => document.querySelector("[data-slot=agent-card]")

const drawn = () => rows().map((row) => `${row.getAttribute("data-align")}:${row.textContent ?? ""}`)

/** The thread as it lands: the catch-up reads Hermes, then the turn's rows draw. */
async function landed() {
  await until(
    async () => rows().some((row) => row.textContent?.includes("Sent it off.")),
    "the thread to draw",
  )
  await import("@/components/chat/markdown-renderer")
  await settle()
}

test("a delivery draws nothing at the thread's end", async () => {
  await screen(async () => {
    await landed()
    assert.equal(resultRow(), undefined, "the subagent's finding is not a message of the thread")
    assert.equal(
      document.querySelector("[data-slot=subagent-result]"),
      null,
      "and no line of its own either",
    )
    const last = rows().at(-1)
    assert.match(last?.textContent ?? "", /Sent it off/, "the reply it arrived after is still last")
    assert.equal(last?.getAttribute("data-align"), "start", "the bot's own side")
    assert.equal(bubble(last!), null, "with no bubble, as a reply has none")
    assert.ok(
      !rows().some((row) =>
        /ASYNC DELEGATION|Original goal:|API calls/.test(row.textContent ?? ""),
      ),
      "and nothing of the notification the model was sent",
    )
  })
})

test("the subagent's work is one tap away, on its card", async () => {
  await screen(async () => {
    await landed()
    const tap = agentCard()?.querySelector("button")
    assert.ok(tap, "the card opens its subagent")
    assert.match(tap.textContent ?? "", /Sub-Agent: Builder/, "naming the subagent that finished")
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

test("the count of what runs is drawn once, by the thread's last row", async () => {
  const running = {
    ...AGENT,
    id: "child-running",
    ended_at: null,
    status: "running",
    tool_calls: 2,
  }
  // A reply of the turn's own left empty, so it can be read as the one still streaming.
  const hostRows = [...transcript, { id: 6, role: "assistant", content: "", timestamp: 30 }]
  await screen(
    async () => {
      await landed()
      const count = () =>
        findAll("button").filter((one) => /subagent[s]? running/.test(one.textContent ?? ""))
      /** The row the count is drawn in, or null where it is the thread's own foot. */
      const inRow = () => count()[0]?.closest("[data-slot=message]") ?? null
      assert.equal(count()[0]?.textContent, "1 subagent running", "the count, said once")
      assert.equal(inRow(), null, "nothing streams, so it stands at the thread's foot")
      const last = async () => {
        const all = await db.messages.where("conversationId").equals("chat-1").toArray()
        return all.sort((a, b) => a.createdAt - b.createdAt).at(-1)!
      }
      const settled = await last()
      await db.messages.put({ ...settled, content: "", status: "streaming" })
      await settle()
      assert.equal(
        rows().at(-1)?.getAttribute("data-align"),
        "start",
        "the streaming reply is last",
      )
      assert.equal(count().length, 1, "the count is still said once")
      assert.equal(inRow(), rows().at(-1), "and rides in the streaming reply's own row")
      await db.messages.put({
        id: "sent",
        conversationId: "chat-1",
        role: "user",
        content: "Still going?",
        status: "queued",
        createdAt: 40,
      })
      try {
        await settle()
        const sent = rows().find((row) => row.textContent?.includes("Still going?"))
        assert.ok(sent, "the message sent during the turn drew")
        assert.equal(rows().at(-1), sent, "as the thread's last row")
        assert.equal(count().length, 1, "still said once")
        assert.equal(inRow(), null, "and the count is the thread's foot again")
        assert.ok(
          sent.compareDocumentPosition(count()[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
          "under the message it belongs to",
        )
      } finally {
        // The database outlives the test, so the rows it touched do not.
        await db.messages.put(settled)
        await db.messages.delete("sent")
        await settle()
      }
    },
    { agents: [running], rows: hostRows },
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

test("two deliveries draw nothing, and a catch-up adds nothing", async () => {
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
  /** The thread's rows, with the turn this pass sent left out. */
  const drawnTexts = () =>
    rows()
      .map((row) => row.textContent ?? "")
      .filter((text) => !text.includes("Anything else?"))
  await screen(
    async () => {
      await until(
        async () => rows().some((row) => row.textContent?.includes("Sent it off.")),
        "the turn that delegated",
      )
      await settle()
      assert.ok(
        !rows().some((row) => /The (parser|docs) (?:is|are) fine[.]/.test(row.textContent ?? "")),
        "neither delivery is a row of the thread",
      )
      const before = drawnTexts()
      // The chat catches up again, with a turn sent since: the deliveries stay out of it.
      lines.push({ id: 7, role: "user", content: "Anything else?", timestamp: 22 })
      // A catch-up already in flight is shared, and may have read the transcript before this turn
      // joined it, so ask again until one that began after it has landed.
      await until(async () => {
        await reconcileHistory("chat-1")
        await settle()
        return rows().some((row) => row.textContent?.includes("Anything else?"))
      }, "the turn sent since")
      assert.deepEqual(
        drawnTexts(),
        before,
        "and the catch-up adds nothing, nor takes anything away",
      )
    },
    { rows: lines },
  )
})

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
          /Sent it off.*Writing/,
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
      const stored = await getMessages("chat-1")
      assert.deepEqual(
        stored.filter((m) => m.role === "user").map((m) => m.content),
        [ASK],
        "the user's own message, and no message of the prompt",
      )
      assert.ok(
        stored.some((m) => m.role === "assistant" && m.content === "Sent it off."),
        "the turn before keeps its reply",
      )
      assert.ok(
        stored.some((m) => m.role === "assistant" && m.content === WAKE_ANSWER),
        "and the wake's answer starts its own message rather than joining that one",
      )
    },
    { rows: woken },
  )
})

/**
 * The wake run the plugin starts draws no user message, so a catch-up learns it from its reply alone
 * and adopts that reply for the run. Doing so must keep the one row the catch-up wrote for it — a
 * user never sees it go and come back under another id — and the delivery before it draws nothing.
 */
test("a wake reply keeps its row when its run is adopted, delivery and all", async () => {
  // The turn before the subagent finished, then the delivery, then the wake run's input and its reply.
  const hostRows: unknown[] = [
    transcript[0],
    { id: 2, role: "assistant", content: "On it.", timestamp: 11 },
    { ...transcript[4], id: 3, timestamp: 20 },
    { id: 4, role: "user", content: wakePrompt("child-session"), timestamp: 100 },
    { id: 5, role: "assistant", content: WAKE_ANSWER, timestamp: 110 },
  ]
  const run = followedRun()
  const stored = () => getMessages("chat-1")
  /** The wake run's reply: the row the transcript gave it, adopted and followed since. */
  const assertWake = async () => {
    const all = await stored()
    const one = all.filter((m) => m.id === "h-chat-1-hermes-5")
    assert.equal(one.length, 1, "the wake reply is one message, never a copy of it")
    assert.equal(all.at(-1)?.id, "h-chat-1-hermes-5", "and the thread's last")
    return one[0]
  }
  await screen(
    async () => {
      try {
        await until(
          async () =>
            (await stored()).some((m) => m.id === "h-chat-1-hermes-5" && m.status === "streaming"),
          "the wake run's reply to be adopted",
          10_000,
        )
        await settle()
        // The catch-up wrote the row the transcript holds; adopting it for the run keeps that id.
        assert.equal((await assertWake()).status, "streaming", "followed as the run's own reply")
        assert.equal((await assertWake()).runId, RUN, "on the run the host still works on")
        assert.equal((await assertWake()).content, "", "rebuilt from the run, not from its row")
        const before = drawn()
        assert.match(
          rows().at(-1)?.textContent ?? "",
          /Thinking|Writing/,
          "the wake reply is drawn, last, saying it is still at work",
        )
        assert.ok(
          !rows().some((row) => /ASYNC DELEGATION|Original goal:/.test(row.textContent ?? "")),
          "and the delivery before it draws nothing",
        )
        // The poll's catch-up, once more, landing while the reply streams.
        await reconcileHistory("chat-1")
        await settle()
        assert.deepEqual(drawn(), before, "a catch-up neither drops the reply nor draws it again")
        assert.equal((await assertWake()).id, "h-chat-1-hermes-5", "the same row, still")
        assert.equal((await assertWake()).status, "streaming", "and still streaming")
      } finally {
        run.end()
        await settledRun()
      }
    },
    { rows: hostRows, run: run.run },
  )
})
