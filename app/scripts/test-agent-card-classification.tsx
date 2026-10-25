/**
 * What a reply draws for a `delegate_task` call: an agent's card only where the call set a subagent
 * to work, and an ordinary tool row for a control action that ran none. A card needs positive proof
 * of a spawn, and that proof is stamped where the call's arguments are in hand — so the reply below
 * carries all four shapes at once: a spawn, a control call stamped by the transcript parse, a
 * control call stamped from the stream's own preview, and a row stored before the stamp existed,
 * which is read from its label alone. A rule that matched the tool's name would draw a card for
 * every one of them (their labels fall inside the ±5s window a card matches by), so the counts here
 * are what hold the decision (ADR 0053).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { AgentsContext } from "@/lib/agents"
import { MessageItem } from "@/components/chat/message-item"
import type { Message, ToolEvent } from "@/lib/db"
import type { DelegatedAgent, HermesConfig } from "@/lib/hermes"
import { toMessages } from "@/lib/history"
import { spawnedAgent } from "@/lib/spawn"
import { click, connection, findAll, find, json, mount, text } from "./component-kit.tsx"

const server: HermesConfig = connection("card-classification")
const SESSION = "parent-session"
const AGENT = "child-session"
const GOAL = "You are the Reviewer for CP3: read the parser end to end"
/** When the subagent started, in seconds: each call sits at it, inside the ±5s window a card widens. */
const STARTED = Math.round(Date.now() / 1000) - 60

const agent: DelegatedAgent = {
  id: AGENT,
  goal: GOAL,
  model: "test/model",
  startedAt: STARTED,
  endedAt: null,
  toolCalls: 1,
  status: "running",
}

/** A `delegate_task` call stored as the thread keeps it, at the moment the subagent began. */
function call(toolCallId: string, label: string, extra: Partial<ToolEvent> = {}): ToolEvent {
  return {
    toolCallId,
    tool: "delegate_task",
    label,
    status: "completed",
    startedAt: STARTED * 1000,
    endedAt: STARTED * 1000 + 1_000,
    ...extra,
  }
}

function reply(tools: ToolEvent[]): Message {
  return {
    id: "m-1",
    conversationId: "c-1",
    role: "assistant",
    content: "",
    status: "done",
    createdAt: 2,
    tools,
  }
}

function drawn(tools: ToolEvent[], body: () => Promise<void>) {
  globalThis.fetch = (async () => json({})) as typeof fetch
  return mount(
    <AgentsContext.Provider value={{ agents: [agent], server, sessionId: SESSION }}>
      <MessageItem message={reply(tools)} />
    </AgentsContext.Provider>,
    body,
  )
}

const cards = () => findAll('[data-slot="agent-card"]')
const toolRow = () => find('[data-slot="tool-group"]')
const count = (needle: string) => text().split(needle).length - 1

test("a control call is a tool row and a spawn is a card, from the one rule", async () => {
  await drawn(
    [
      call("c-spawn", GOAL),
      // The transcript's own stamp: its arguments said `list`, which runs nothing.
      call("c-list", "list", { action: "list" }),
      // The stream's preview, stamped as it arrived: `steer <id>` is a control action too.
      call("c-steer", "steer sub-1", { action: "steer" }),
      // Stored before the stamp: the same call, with only its label to classify it by.
      call("c-steer-legacy", "steer sub-1"),
      call("c-stop-legacy", '{"action":"stop","subagent_id":"sub-2"}'),
    ],
    async () => {
      assert.equal(cards().length, 1, "one card, for the one call that set a subagent to work")
      assert.match(
        cards()[0].textContent ?? "",
        /Sub-Agent: Reviewer · CP3/,
        "the spawn's own card",
      )
      assert.equal(cards()[0].getAttribute("data-agent"), AGENT)

      const row = toolRow()
      assert.ok(row, "the control calls drew as one group of tool rows")
      assert.match(row.getAttribute("aria-label") ?? "", /Used 4 tools/, "four calls, as tools")
      assert.doesNotMatch(row.textContent ?? "", /Sub-Agent/, "and no card among them")

      // The row's own words, from the sheet it opens: the two shapes of the same steer call read the
      // same, and neither the list nor the stop reads as an agent.
      await click(row)
      assert.equal(count("steer sub-1"), 2, "the stamped call and the label-only row read alike")
      assert.equal(count("Sub-Agent: list"), 0, "a list never draws a card")
      assert.equal(count("Sub-Agent:"), 1, "only the spawn's card names a subagent")
    },
  )
})

test("proof of the control action outranks a label that would match a subagent", async () => {
  // A call whose arguments said `list` while its label reads like the subagent's goal: the card is
  // drawn for work set going, so the stamp's word settles it, not the words beside it.
  await drawn([call("c-list", GOAL, { action: "list" })], async () => {
    assert.equal(cards().length, 0, "a call that only listed draws no card")
    assert.ok(toolRow(), "it is a tool row")
    assert.match(text(), /Used a tool/, "one call, drawn as the tool it was")
  })
})

test("the transcript stamps what each call did, and words a control call as it streamed", () => {
  // The derivation the thread reads: a control call's arguments, parsed where they are in hand, give
  // it the action it did and the words Hermes previewed it with — never `{"action":"list"}`.
  const [reply] = toMessages("c-1", "s-1", [
    {
      id: 1,
      role: "assistant",
      content: null,
      timestamp: 1,
      tool_calls: [
        { id: "c-list", function: { name: "delegate_task", arguments: '{"action":"list"}' } },
        {
          id: "c-steer",
          function: {
            name: "delegate_task",
            arguments: '{"action":"steer","subagent_id":"sub-1"}',
          },
        },
        {
          id: "c-spawn",
          function: { name: "delegate_task", arguments: JSON.stringify({ goal: GOAL }) },
        },
      ],
    },
  ])
  const tools = reply.tools ?? []
  assert.deepEqual(
    tools.map((tool) => [tool.label, tool.action]),
    [
      ["list", "list"],
      ["steer sub-1", "steer"],
      [GOAL, undefined],
    ],
    "each call's words and its stamped action",
  )
  assert.deepEqual(
    tools.map((tool) => spawnedAgent(tool)),
    [false, false, true],
    "and the one rule reads them as a row, a row and a card",
  )
})
