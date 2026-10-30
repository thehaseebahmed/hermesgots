/**
 * A working reply's live cluster: the three rows it ends on stand thought, tools, status in that
 * order, one loader turns in the reply, and the colours say what a reader can press (ADR 0070).
 * The order is the placing rule's (`placeThinking`) and the foot is `statusLineOf`'s, both asked by
 * the one row component every screen draws a reply with, so this file reads what a reader sees
 * rather than which screen drew it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db, type Message, type ToolEvent } from "@/lib/db"
import { BUSY_WORDS } from "@/lib/busy-words"
import type { ReasoningRun } from "@/lib/thinking"
import { MessageItem } from "@/components/chat/message-item"
import {
  botProfile,
  chatScreen,
  findAll,
  json,
  mount,
  seedChat,
  settle,
  text,
} from "./component-kit.tsx"

const bot = botProfile("cluster", { name: "Cluster" })

const ASK = "Where does the parser read a reply?"
const FIRST = "I read the parser first."
const PARAGRAPH = "The parser reads it, then keeps its blocks."
const REASONING = "Read `parse.ts` first."
const SECOND = "Its blocks are what matter."

const run = (text: string, extra: Partial<ReasoningRun> = {}): ReasoningRun => ({ text, ...extra })

function call(toolCallId: string, at = 0, status: ToolEvent["status"] = "completed"): ToolEvent {
  return { toolCallId, tool: "terminal", label: "ls", status, startedAt: 2, contentOffset: at }
}

function turn(reply: Partial<Message> & { id: string }): Message[] {
  return [
    {
      id: "ask",
      conversationId: "",
      role: "user",
      content: ASK,
      status: "done",
      createdAt: 1,
    },
    {
      conversationId: "",
      role: "assistant",
      content: "",
      status: "done",
      createdAt: 2,
      ...reply,
    },
  ]
}

function host() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: [] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

/** The reply's own turn where the screen draws one, else the row component mounted on its own. */
const reply = () => {
  const items = findAll("[data-slot=message-scroller-item]")
  return items.length > 0 ? items[items.length - 1] : document.body
}

/** The live cluster's rows, in the order the reply draws them. */
const rowsOf = () => {
  const box = reply()
  return [
    ...box.querySelectorAll(
      "[data-slot=thinking-line], [data-slot=tool-group], [data-slot=status-line]",
    ),
  ].map((row) => row.getAttribute("data-slot"))
}

const loaders = () => reply().querySelectorAll("[data-slot=spinner]").length

const thinkingRow = () => reply().querySelector("[data-slot=thinking-line]")?.firstElementChild
const statusLine = () => reply().querySelector("[data-slot=status-line]")
const count = () =>
  [...reply().querySelectorAll("button")].find((one) =>
    /subagents? running/.test(one.textContent ?? ""),
  )

async function draw(messages: Message[], body: () => Promise<void>) {
  await seedChat({ id: "chat-1", messages, profile: bot })
  await mount(chatScreen("chat-1"), body)
}

async function stream(id: string, patch: Partial<Message> = {}) {
  await db.messages.put({ ...(await db.messages.get(id))!, status: "streaming", ...patch })
  await settle()
}

test("a reply that thought and then called ends on nothing but thought, tools, status", async () => {
  host()
  const id = "one-cluster"
  await draw(
    turn({
      id,
      content: `${FIRST} Then its blocks.`,
      tools: [call("call-1", FIRST.length)],
      reasoningRuns: [run(REASONING, { afterToolId: "call-1" })],
    }),
    async () => {
      await stream(id)
      assert.deepEqual(
        rowsOf(),
        ["thinking-line", "tool-group", "status-line"],
        "the working-out reads over the call it led into, and the line stands under both",
      )
      assert.equal(
        thinkingRow()?.getAttribute("aria-haspopup"),
        "dialog",
        "the first slot is the thought row, which opens its working-out",
      )
    },
  )
})

test("a reply that thinks, calls, writes, thinks and calls again keeps the order per cluster", async () => {
  host()
  const id = "two-clusters"
  const first = FIRST
  const both = `${first}\n\n${PARAGRAPH}`
  await draw(
    turn({
      id,
      content: `${both} And one more line.`,
      tools: [call("call-1", first.length), call("call-2", both.length)],
      reasoningRuns: [
        run(REASONING, { afterToolId: "call-1" }),
        run(SECOND, { afterToolId: "call-2" }),
      ],
    }),
    async () => {
      await stream(id)
      assert.deepEqual(
        rowsOf(),
        ["thinking-line", "tool-group", "thinking-line", "tool-group", "status-line"],
        "each cluster keeps thought-then-tools, and one line stands under the reply's last words",
      )
      assert.equal(
        reply().querySelectorAll("[data-slot=status-line]").length,
        1,
        "the line is drawn once, however many clusters the turn had",
      )
    },
  )
})

test("a turn whose model has said nothing shows no row, and the line says it is working", async () => {
  host()
  const id = "no-thought-yet"
  await draw(turn({ id }), async () => {
    await stream(id)
    assert.deepEqual(rowsOf(), ["status-line"], "no empty row stands at the foot")
    assert.ok(statusLine(), "the line says the turn is working from its first moment")
    assert.match(
      text(),
      new RegExp(`(${BUSY_WORDS.thinking.join("|")}|${BUSY_WORDS.writing.join("|")})…`),
      "in its rotating word",
    )
    assert.equal(loaders(), 1, "and one loader turns for the reply")
  })
})

test("a reply thinking with subagents at work turns one loader, in the row's own colour", async () => {
  const thinking: Message = {
    id: "m-1",
    conversationId: "c-1",
    role: "assistant",
    content: "",
    status: "streaming",
    createdAt: 2,
    reasoningRuns: [run(REASONING)],
  }
  let row: Element | null = null
  let line: Element | null = null
  let turning = 0
  let words = 0
  let counted = false
  await mount(
    <MessageItem
      message={thinking}
      showStats
      onShowSubagents={() => {}}
      subagents={2}
      subagentsInline
    />,
    async () => {
      row = thinkingRow()
      line = statusLine()
      turning = loaders()
      words = line?.querySelectorAll("[data-slot=status-words]").length ?? 0
      counted = Boolean(line?.querySelector("button"))
    },
  )
  assert.ok(row, "the thought row is the one saying the turn is thinking")
  assert.equal(words, 0, "so the line says no words of its own")
  assert.ok(counted, "holding only the count of subagents at work")
  assert.equal(turning, 1, "and one loader turns in the whole reply, never two")
  assert.match(row!.className, /(^|\s)text-muted-foreground(\s|$)/, "in the row's muted colour")
})

test("a stopped reply says so where its line would stand, and draws no line", async () => {
  const stopped: Message = {
    id: "m-3",
    conversationId: "c-1",
    role: "assistant",
    content: "Half an answer.",
    status: "stopped",
    createdAt: 2,
  }
  let line: Element | null = null
  let words = ""
  await mount(<MessageItem message={stopped} showStats onShowSubagents={() => {}} />, async () => {
    line = statusLine()
    words = text()
  })
  assert.equal(line, null, "a stopped reply draws no status line")
  assert.match(words, /Stopped/, "and its end stands plainly where the line would be")
})
