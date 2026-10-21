import assert from "node:assert/strict"
import test from "node:test"
import { reattachRun, sendMessage } from "@/lib/chat"
import { db, type Message, type Profile } from "@/lib/db"
import { thoughtSpan } from "@/lib/thinking"
import {
  botProfile,
  chatScreen,
  expanded,
  json,
  lineLabel,
  mount,
  onlyThinkingLine,
  seedChat,
  until,
} from "./component-kit.tsx"

const bot = botProfile("live-span", { name: "Live span" })

const runBot = botProfile("live-span-run", { id: "bot-2", name: "Live span runs" })

const ASK = "Where does the parser read a reply?"
const THOUGHT = "Read `parse.ts` first, then its blocks."
const ANSWER = "The parser reads it, then keeps its blocks."

const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`

function streamed(frames: unknown[], after: number) {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frames.slice(0, after).map(frame).join("")))
      setTimeout(() => {
        controller.enqueue(encoder.encode(frames.slice(after).map(frame).join("")))
        controller.close()
      }, 10)
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

const chunk = (delta: Record<string, string>, finish: string | null = null) => ({
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }],
})

const COMPLETION = [
  chunk({ role: "assistant" }),
  chunk({ reasoning_content: THOUGHT }),
  chunk({ content: ANSWER }),
  chunk({}, "stop"),
]

const RUN_EVENTS = [
  { event: "reasoning.available", text: THOUGHT, seq: 1 },
  { event: "message.delta", delta: ANSWER, seq: 2 },
  { event: "run.completed", status: "completed", output: ANSWER, seq: 3 },
]

function host(
  answer: (url: URL) => Response | undefined,
  { features = {}, between = 2 }: { features?: Record<string, boolean>; between?: number } = {},
) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    if (url.pathname === "/v1/capabilities") return json({ features })
    if (method === "GET" && /^\/v1\/runs\/[^/]+\/events$/.test(url.pathname))
      return streamed(RUN_EVENTS, between)
    const found = method === "POST" || method === "GET" ? answer(url) : undefined
    if (found) return found
    return json({ error: { message: `No route for ${method} ${url.pathname}` } }, 404)
  }) as unknown as typeof fetch
}

const completionHost = () =>
  host((url) => (url.pathname === "/v1/chat/completions" ? streamed(COMPLETION, 2) : undefined))

const runHost = () => host(() => undefined)

const runPathHost = () => {
  const sent: string[] = []
  host(
    (url) => {
      sent.push(url.pathname)
      return url.pathname === "/v1/runs" ? json({ run_id: "run-2" }) : undefined
    },
    { features: { run_submission: true, run_events_sse: true }, between: 1 },
  )
  return sent
}

async function seed(messages: Message[], profile: Profile = bot) {
  await seedChat({ id: "chat-1", messages, profile })
}

const screen = () => chatScreen("chat-1")

const assistant = async () =>
  (await db.messages.toArray()).filter((message) => message.role === "assistant").at(-1)

test("a turn this device watched reads a span, and keeps it off the reply row", async () => {
  completionHost()
  await seed([])
  await sendMessage("chat-1", ASK)

  const reply = await assistant()
  assert.ok(reply, "the reply was written")
  assert.equal(reply.status, "done", "the stream finished")
  assert.match(reply.reasoning ?? "", /parse\.ts/, "the reasoning arrived")
  assert.match(reply.content, /keeps its blocks/, "and the answer after it")
  const span = thoughtSpan(reply.id)
  assert.ok(span !== undefined, "a span was recorded for the turn this device watched")

  assert.deepEqual(
    Object.keys(reply).filter((key) => /thought|thinking|span/i.test(key)),
    [],
    "no thinking duration on the reply",
  )
  assert.equal(typeof reply.stats?.durationMs, "number", "only the turn's duration, in its stats")

  await mount(screen(), async () => {
    const line = onlyThinkingLine()
    assert.match(
      lineLabel(line),
      /^Thought for \d+s?m?/,
      "the screen draws the number this device watched",
    )
    assert.doesNotMatch(lineLabel(line), /\./, "whole seconds, never the stats line's tenths")
    assert.equal(expanded(line), "false", "folded over an answer")
  })
})

test("a turn picked up mid-thought reads bare Thought", async () => {
  runHost()
  const streaming: Message = {
    id: "reply-1",
    conversationId: "chat-1",
    role: "assistant",
    content: "",
    tools: [],
    status: "streaming",
    runId: "run-1",
    createdAt: 2,
  }
  await seed([
    {
      id: "ask-1",
      conversationId: "chat-1",
      role: "user",
      content: ASK,
      status: "done",
      createdAt: 1,
    },
    streaming,
  ])

  await reattachRun("chat-1")
  await until(
    async () => (await db.messages.get("reply-1"))?.status === "done",
    "the run to finish",
  )

  const reply = (await db.messages.get("reply-1"))!
  assert.match(reply.reasoning ?? "", /parse\.ts/, "the run's reasoning arrived")
  assert.match(reply.content, /keeps its blocks/, "and its answer")
  assert.equal(
    thoughtSpan(reply.id),
    undefined,
    "a resumed turn's first delta is mid-thought, not its first",
  )

  await mount(screen(), async () => {
    const line = onlyThinkingLine()
    assert.equal(lineLabel(line), "Thought", "no number for a turn this device didn't watch think")
    assert.doesNotMatch(lineLabel(line), /\d/, "no figure at all")
    assert.equal(expanded(line), "false", "and folded")
  })
})

test("a fresh turn on a host with runs notes the run's reasoning block", async () => {
  const sent = runPathHost()
  await seed([], runBot)

  await sendMessage("chat-1", ASK)

  const reply = await assistant()
  assert.ok(reply, "the reply was written")
  assert.equal(reply.status, "done", "the run finished")
  assert.ok(sent.includes("/v1/runs"), "the send took the run path")
  assert.ok(!sent.includes("/v1/chat/completions"), "not a chat completion")
  assert.match(reply.reasoning ?? "", /parse\.ts/, "the reasoning block arrived")
  assert.match(reply.content, /keeps its blocks/, "and the answer after it")
  const span = thoughtSpan(reply.id)
  assert.ok(
    span !== undefined,
    "a span was recorded for the run's reasoning.available block and its first message.delta",
  )

  await mount(screen(), async () => {
    const line = onlyThinkingLine()
    assert.match(
      lineLabel(line),
      /^Thought for \d+s?m?/,
      "the screen draws the number this device watched",
    )
    assert.doesNotMatch(lineLabel(line), /\./, "whole seconds")
    assert.equal(expanded(line), "false", "folded over an answer")
  })
})
