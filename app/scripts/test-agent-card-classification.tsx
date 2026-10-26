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
import { MAX_LABEL_CHARS, toMessages } from "@/lib/history"
import { controlAction, DELEGATE_TOOL, spawnedAgent } from "@/lib/spawn"
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

test("an envelope label proves a spawn where its arguments did, and is a row where they didn't", async () => {
  // A stored row whose arguments fell back as its label still carries them: a batch's `tasks` and a
  // spawn's `goal` are what a spawn was given, so each draws a card — a reloaded chat keeps the work
  // it showed while it streamed. An `action` the rule has no words for — `archive` — ran nothing, so
  // that call stays a tool row.
  await drawn(
    [
      call("c-archive", '{"action":"archive","subagent_id":"sub-9"}'),
      call("c-goal", `{"goal":${JSON.stringify(GOAL)}}`),
      call("c-tasks", '{"tasks":[{"goal":"read the parser"}]}'),
    ],
    async () => {
      assert.equal(cards().length, 2, "the goal and the batch are the calls that set work")
      for (const card of cards()) assert.equal(card.getAttribute("data-agent"), AGENT)
      const row = toolRow()
      assert.ok(row, "the archive call is a tool row, not a card")
      assert.equal(
        row.getAttribute("aria-label"),
        "Used a tool",
        "one call, and an action the table has no words for",
      )
      assert.doesNotMatch(row.textContent ?? "", /Sub-Agent/, "and nothing in it claims an agent")
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

test("the transcript stamps what each call did, and words a control call as it streamed", () => {
  // The derivation the thread reads: a control call's arguments, parsed where they are in hand, give
  // it the action it did and the words Hermes previewed it with — never `{"action":"list"}`. A
  // batch is worded as Hermes previews it too ("N tasks: goal1 | goal2"), so a fan-out's long
  // arguments never stand in as its label — the one rule reads it as the spawn it was.
  const [reply] = toMessages("c-1", "s-1", [
    {
      id: 1,
      role: "assistant",
      content: null,
      timestamp: 1,
      tool_calls: [
        { id: "c-list", function: { name: DELEGATE_TOOL, arguments: '{"action":"list"}' } },
        {
          id: "c-steer",
          function: {
            name: DELEGATE_TOOL,
            arguments: '{"action":"steer","subagent_id":"sub-1"}',
          },
        },
        {
          id: "c-spawn",
          function: { name: DELEGATE_TOOL, arguments: JSON.stringify({ goal: GOAL }) },
        },
        {
          id: "c-tasks",
          function: {
            name: DELEGATE_TOOL,
            arguments: '{"tasks":[{"goal":"read the parser"}]}',
          },
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
      [GOAL, "spawn"],
      ["1 tasks: read the parser", "spawn"],
    ],
    "each call's words and its stamped action",
  )
  assert.deepEqual(
    tools.map((tool) => spawnedAgent(tool)),
    [false, false, true, true],
    "and the one rule reads them as a row, a row, a card and a card",
  )
  // A control row stored before the stamp reads the same action from its label alone.
  assert.equal(controlAction({ ...tools[0], action: undefined }), "list")
  assert.equal(controlAction({ ...tools[1], action: undefined }), "steer")
})

test("a fan-out too long for its arguments to survive as a label still draws its cards", async () => {
  // The session this came from: a 26k-char, 7-agent review fan-out. As raw JSON its label was
  // clipped at MAX_LABEL_CHARS, the unfinished `tasks` array read as no spawn, and the call drew as an
  // ordinary row — no cards, while the plugin's list still counted the 7 running.
  const goals = [
    "Review this diff for CODE REUSE problems only.",
    "Review this diff for CODE QUALITY problems only.",
    "Review this diff for EFFICIENCY problems only.",
    "Review this diff for ALTITUDE problems only.",
    "You are Comment Sicko. Read the scope below, then report.",
    "Review this diff along the STANDARDS axis.",
    "Review this diff along the SPEC axis.",
  ]
  const args = JSON.stringify({
    tasks: goals.map((goal) => ({ goal, context: "x".repeat(2000) })),
  })
  assert.ok(args.length > MAX_LABEL_CHARS, "long enough that a JSON label would clip")
  const [reply] = toMessages("c-1", "s-1", [
    {
      id: 1,
      role: "assistant",
      content: null,
      timestamp: STARTED,
      tool_calls: [{ id: "c-batch", function: { name: DELEGATE_TOOL, arguments: args } }],
    },
  ])
  const tool = (reply.tools ?? [])[0]
  assert.equal(tool.action, "spawn", "the arguments prove the spawn, whatever the label became")
  assert.doesNotMatch(tool.label ?? "", /^\{/, "and its label is words, not clipped JSON")
  const agents = goals.map((goal, i) => ({ ...agent, id: `child-${i}`, goal }))
  await drawn(
    [tool],
    async () => {
      assert.equal(cards().length, goals.length, "every agent the fan-out started draws its card")
    },
    agents,
  )
})

test("a goal that opens on a brace draws its card, because the arguments stamped it", async () => {
  // A single spawn whose goal is itself JSON — a schema brief, say. Its label therefore opens on a
  // brace, which reads as an envelope with nothing in it and proved no spawn at all.
  const goal = '{"type":"object","properties":{"id":{"type":"string"}}}'
  const [reply] = toMessages("c-1", "s-1", [
    {
      id: 1,
      role: "assistant",
      content: null,
      timestamp: STARTED,
      tool_calls: [
        { id: "c-brace", function: { name: DELEGATE_TOOL, arguments: JSON.stringify({ goal }) } },
      ],
    },
  ])
  const tool = (reply.tools ?? [])[0]
  assert.equal(tool.label, goal, "its label is the goal, brace and all")
  assert.equal(tool.action, "spawn", "which the stamp reads whatever the label opens on")
  await drawn(
    [tool],
    async () => {
      assert.equal(cards().length, 1, "so its card is drawn, not a bare tool row")
    },
    [{ ...agent, goal }],
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
