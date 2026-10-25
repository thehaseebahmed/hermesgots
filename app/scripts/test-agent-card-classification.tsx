/**
 * What a reply draws for a `delegate_task` call: an agent's card only where the call set a subagent
 * to work, and an ordinary tool row for every other shape — a rule that matched the tool's name
 * would draw a card for all of them (ADR 0053).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { AgentPopup } from "@/components/chat/agent-card"
import { MessageItem } from "@/components/chat/message-item"
import { AgentsContext, CARD_WINDOW_S } from "@/lib/agents"
import type { Message, ToolEvent } from "@/lib/db"
import type { DelegatedAgent, HermesConfig, SessionMessage } from "@/lib/hermes"
import { DELEGATE_TOOL } from "@/lib/spawn"
import { click, connection, findAll, find, json, mount, settle, text } from "./component-kit.tsx"

const server: HermesConfig = connection("card-classification")
const SESSION = "parent-session"
const AGENT = "child-session"
const GOAL = "You are the Reviewer for CP3: read the parser end to end"
/** When the subagent started, in seconds. */
const STARTED = Math.round(Date.now() / 1000) - 60
/** A call's own moment: the far edge of the window a card widens around an agent it can't name. */
const AT = (STARTED + CARD_WINDOW_S) * 1000

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
    tool: DELEGATE_TOOL,
    label,
    status: "completed",
    startedAt: AT,
    endedAt: AT + 1_000,
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

function drawn(tools: ToolEvent[], body: () => Promise<void>, agents = [agent]) {
  globalThis.fetch = (async () => json({})) as typeof fetch
  return mount(
    <AgentsContext.Provider value={{ agents, server, sessionId: SESSION }}>
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
      assert.equal(
        row.getAttribute("aria-label") ?? "",
        "Listed subagents, steered subagent, stopped subagent",
        "four calls, each saying the action it took — and the two steer shapes sharing one phrase",
      )
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
    assert.match(text(), /Listed subagents/, "one call, saying the action its arguments named")
  })
})

test("a label that is an envelope never draws a card, whatever action it names", async () => {
  // A stored row whose arguments fell back as its label says what the call was given, never that it
  // started anything — even where the action it names is one the rule has no words for.
  await drawn(
    [
      call("c-archive", '{"action":"archive","subagent_id":"sub-9"}'),
      call("c-goal", `{"goal":${JSON.stringify(GOAL)}}`),
      call("c-tasks", '{"tasks":[{"goal":"read the parser"}]}'),
    ],
    async () => {
      assert.equal(cards().length, 0, "no card: an envelope is not proof of a spawn")
      assert.ok(toolRow(), "they are one group of tool rows")
      assert.match(toolRow()?.getAttribute("aria-label") ?? "", /Used 3 tools/)
    },
  )
})

test("a goal that opens on a control word keeps its card", async () => {
  // "stop the" is the short plain word a goal opens with, not the id a preview names after `stop`;
  // a call whose preview names an id is the control it is.
  await drawn(
    [call("c-stop-goal", "stop the"), call("c-steer-id", "steer sa-1-4f2a")],
    async () => {
      assert.equal(cards().length, 1, "the goal is the work it is")
      assert.match(cards()[0].textContent ?? "", /Sub-Agent/, "and it keeps the card a spawn has")
      const row = toolRow()
      assert.ok(row, "the steer names an id, so it is a row")
      assert.equal(row.getAttribute("aria-label"), "Steered subagent")
    },
  )
})

/** A row of the child session's own transcript, as Hermes wrote it. */
const childRows: SessionMessage[] = [
  { id: 1, role: "user", content: GOAL, timestamp: STARTED },
  {
    id: 2,
    role: "assistant",
    content: null,
    timestamp: STARTED,
    tool_calls: [
      {
        id: "call_child",
        type: "function",
        function: {
          name: DELEGATE_TOOL,
          arguments: JSON.stringify({ goal: "Audit the reader for unbounded reads" }),
        },
      },
    ],
  },
]

const nested: DelegatedAgent = {
  id: "grandchild-session",
  goal: "Audit the reader for unbounded reads",
  model: "test/model",
  startedAt: STARTED,
  endedAt: null,
  toolCalls: 1,
  status: "running",
}

test("a spawn inside a subagent's own pop-up still draws its card", async () => {
  // A subagent that delegated in turn: its own thread is drawn by the same parts, so the card
  // follows the spawn there too.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/messages")) return json({ data: childRows })
    return json({})
  }) as typeof fetch
  await mount(
    <AgentsContext.Provider value={{ agents: [agent, nested], server, sessionId: SESSION }}>
      <AgentPopup agent={agent} server={server} open onOpenChange={() => {}} />
    </AgentsContext.Provider>,
    async () => {
      await settle()
      assert.equal(cards().length, 1, "the nested spawn draws its card in the pop-up")
      assert.equal(cards()[0].getAttribute("data-agent"), nested.id)
      assert.equal(toolRow(), null, "and nothing about it is a tool row")
    },
  )
})
