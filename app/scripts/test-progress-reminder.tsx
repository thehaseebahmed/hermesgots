import assert from "node:assert/strict"
import test from "node:test"

import { streamHandlers, type Turn } from "@/lib/chat"
import type { Message } from "@/lib/db"
import { toMessages } from "@/lib/history"
import { connection } from "./component-kit.tsx"
import { NOTE, stored } from "./progress-reminder-fixture.ts"

const UPDATE = "Halfway: the parser reads end to end, and the tests come next."

const interrupted = (refusal: string = stored(NOTE)) => [
  { id: 1, role: "user", content: "Read the parser", timestamp: 1 },
  {
    id: 2,
    role: "assistant",
    content: null,
    timestamp: 2,
    tool_calls: [{ id: "call-1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
  },
  { id: 3, role: "tool", content: refusal, tool_call_id: "call-1", timestamp: 3 },
  {
    id: 4,
    role: "assistant",
    content: UPDATE,
    timestamp: 4,
    tool_calls: [{ id: "call-2", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }],
  },
  { id: 5, role: "tool", content: "export const a = 1", tool_call_id: "call-2", timestamp: 5 },
]

function liveTurn(): Turn {
  const draft: Message = {
    id: "m-1",
    conversationId: "c-1",
    role: "assistant",
    content: "",
    tools: [],
    status: "streaming",
    createdAt: 1,
  }
  return {
    conversationId: "c-1",
    config: connection("progress-reminder"),
    draft,
    controller: new AbortController(),
    touch: () => {},
    firstTokenAt: null,
    resumed: true,
    close: async () => {},
  }
}

test("the thread draws the call that ran, not the one the reminder refused", () => {
  const [request, reply] = toMessages("c-1", "s-1", interrupted())
  assert.equal(request.role, "user")
  assert.deepEqual(
    reply.tools?.map((tool) => tool.toolCallId),
    ["call-2"],
    "the refused card is gone and the repeat is the one left",
  )
  assert.match(reply.content, /Halfway: the parser reads end to end/, "the update stays")
})

test("a refusal any other hook made is still drawn", () => {
  const [request, reply] = toMessages("c-1", "s-1", interrupted(stored("Blocked: no such path")))
  assert.equal(request.role, "user")
  assert.deepEqual(
    reply.tools?.map((tool) => tool.toolCallId),
    ["call-1", "call-2"],
    "a security hook's block is a thing the reader should read",
  )
  assert.equal(reply.tools?.[0]?.status, "failed")
})

test("a run's completion drops the refused card though it names no call", () => {
  const turn = liveTurn()
  const onTool = streamHandlers(turn).onTool!
  onTool({ tool: "read_file", status: "running", toolCallId: "run-1:1" })
  assert.equal(turn.draft.tools?.length, 1, "the call is drawn while it runs")
  onTool({ tool: "read_file", status: "failed", result: stored(NOTE) })
  assert.deepEqual(turn.draft.tools, [], "and leaves no card behind")
})

test("a normal completion still lands on the card it started", () => {
  const turn = liveTurn()
  const onTool = streamHandlers(turn).onTool!
  onTool({ tool: "read_file", status: "running", toolCallId: "run:1" })
  onTool({ tool: "read_file", status: "completed", result: "export const a = 1" })
  assert.equal(turn.draft.tools?.[0]?.status, "completed")
  assert.equal(turn.draft.tools?.[0]?.result, "export const a = 1")
})
