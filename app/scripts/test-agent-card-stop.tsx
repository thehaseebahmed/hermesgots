/**
 * A subagent's card: its title and how it is doing, all of which opens its sub-thread, and Stop in
 * the right column while it works — whichever turn started it, and out of the tap target so a press
 * can't open the sub-thread by accident. Pressing it stops exactly that subagent on the host, and
 * the card then reads what the host answered — stopped, or why it wasn't. A host that doesn't
 * advertise `subagent_stop` shows no Stop at all, and a finished subagent offers none either.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { createRoot } from "react-dom/client"

import { AgentsContext } from "@/lib/agents"
import { AgentCards } from "@/components/chat/agent-card"
import type { ToolEvent } from "@/lib/db"
import type { HermesConfig } from "@/lib/hermes"
import { click, connection, findAll, json, mount, settle, text } from "./component-kit.tsx"

const server: HermesConfig = connection("agent-stop")
const legacyHost: HermesConfig = connection("agent-stop-legacy")
const SESSION = "parent-session"
const AGENT = "child-session"
const GOAL = "You are the Reviewer for CP3: read the parser end to end"
const DECLINED = "That subagent isn't running any more."
const WORKED = 180
const STARTED = Math.round(Date.now() / 1000) - WORKED

const agent = (status: "running" | "done" | "stopped") => ({
  id: AGENT,
  goal: GOAL,
  model: "test/model",
  startedAt: STARTED,
  endedAt: null,
  toolCalls: 2,
  status,
})

const tool = (status: "running" | "completed"): ToolEvent => ({
  toolCallId: "call-1",
  tool: "delegate_task",
  label: GOAL,
  status,
  startedAt: 1_000,
  endedAt: status === "running" ? undefined : 2_000,
})

type Call = { method: string; path: string }

/** The chat's host: the child's (empty) transcript, its plugin's features, and the stop route. */
function host({
  features = ["agents", "subagent_stop"],
  answer = { stopped: true },
}: { features?: string[]; answer?: { stopped: boolean; reason?: string } } = {}) {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push({ method, path: url.pathname })
    if (url.pathname.endsWith("/plugins/memento/info")) return json({ name: "memento", features })
    if (url.pathname.endsWith(`/agents/${AGENT}/stop`) && method === "POST")
      return json({ object: "memento.agent_stop", session_id: SESSION, agent_id: AGENT, ...answer })
    if (url.pathname.endsWith("/messages")) return json({ data: [] })
    return json({ error: "not found" }, 404)
  }) as typeof fetch
  return calls
}

const card = (
  delegated: ReturnType<typeof agent>,
  call: ToolEvent,
  body: () => Promise<void>,
  { target = server }: { target?: HermesConfig } = {},
) =>
  mount(
    <AgentsContext.Provider value={{ agents: [delegated], server: target, sessionId: SESSION }}>
      <AgentCards tool={call} />
    </AgentsContext.Provider>,
    body,
  )

const stops = (calls: Call[]) => calls.filter((call) => call.path.endsWith("/stop"))
const stopButton = () =>
  findAll("button").find((button) => button.getAttribute("aria-label")?.startsWith("Stop "))

/** The card, drawn again from a fresh list read as a poll would hand it over. */
const tree = (
  delegated: ReturnType<typeof agent>,
  call: ToolEvent,
  target: HermesConfig = server,
) => (
  <AgentsContext.Provider value={{ agents: [delegated], server: target, sessionId: SESSION }}>
    <AgentCards tool={call} />
  </AgentsContext.Provider>
)

async function mounted(element: React.ReactNode) {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(element))
  await settle()
  return {
    show: async (next: React.ReactNode) => {
      await act(async () => root.render(next))
      await settle()
    },
    close: async () => {
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

test("a working subagent offers a stop that stops it, beside its own two lines", async () => {
  const calls = host()
  await card(agent("running"), tool("completed"), async () => {
    assert.match(text(), /Sub-Agent: Reviewer · CP3/, "the title")
    assert.match(text(), /Working for 3 min/, "and how it is doing")
    assert.ok(stopButton(), "the card offers Stop while its agent works")
    await click(stopButton()!)
    const posted = stops(calls)
    assert.equal(posted.length, 1, "one stop was asked for")
    assert.equal(posted[0].method, "POST")
    assert.equal(posted[0].path, `/api/plugins/memento/sessions/${SESSION}/agents/${AGENT}/stop`)
    assert.match(text(), /Stopped after/, "the card reads the host's answer")
    assert.equal(stopButton(), undefined, "and offers no Stop again")
  })
})

test("the card leaves its goal and commands to the sub-thread", async () => {
  host()
  await card(agent("running"), tool("completed"), async () => {
    const shown = text()
    assert.match(shown, /Sub-Agent: Reviewer · CP3/)
    assert.match(shown, /Working for 3 min · 2 tool calls/, "the line counts the work")
    assert.doesNotMatch(shown, /read the parser end to end/, "not the goal as well")
  })
})

test("a stop the host declines says why", async () => {
  host({ answer: { stopped: false, reason: DECLINED } })
  await card(agent("running"), tool("completed"), async () => {
    await click(stopButton()!)
    await settle()
    assert.match(text(), new RegExp(DECLINED), "the host's reason, in its own words")
  })
})

test("a host row that has finished drops a refusal this device recorded", async () => {
  host({ answer: { stopped: false, reason: DECLINED } })
  const shown = await mounted(tree(agent("running"), tool("completed")))
  try {
    await click(stopButton()!)
    assert.match(text(), new RegExp(DECLINED), "the refusal, while the host still reports it running")
    await shown.show(tree(agent("stopped"), tool("completed")))
    assert.doesNotMatch(text(), new RegExp(DECLINED), "the host's own row outranks a stale answer")
    assert.match(text(), /Stopped after 3 min/, "and the card reads what the host reports")
  } finally {
    await shown.close()
  }
})

test("a turn still running does not take the card's stop away", async () => {
  host()
  await card(agent("running"), tool("completed"), async () => {
    assert.ok(stopButton(), "Stop is the card's own, whether or not the turn that started it runs")
    await click(stopButton()!)
  })
})

test("a finished subagent offers no Stop", async () => {
  host()
  await card(agent("done"), tool("completed"), async () => {
    assert.equal(stopButton(), undefined)
  })
})

test("a host without the stop route shows no Stop", async () => {
  const calls = host({ features: ["agents"] })
  await card(
    agent("running"),
    tool("completed"),
    async () => {
      assert.equal(stopButton(), undefined)
      assert.equal(stops(calls).length, 0)
    },
    { target: legacyHost },
  )
})
