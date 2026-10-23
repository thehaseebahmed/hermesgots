/**
 * A subagent's card once the turn that started it has ended: it offers Stop, which stops exactly
 * that subagent on the host, and the card then reads what the host answered — stopped, or why it
 * wasn't. A host that doesn't advertise `subagent_stop` shows no Stop at all, and a turn still
 * running leaves stopping to the composer.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { AgentsContext } from "@/lib/agents"
import { AgentCards } from "@/components/chat/agent-card"
import type { ToolEvent } from "@/lib/db"
import type { HermesConfig } from "@/lib/hermes"
import { click, connection, findAll, json, mount, settle, text } from "./component-kit.tsx"

const server: HermesConfig = connection("agent-stop")
const legacyHost: HermesConfig = connection("agent-stop-legacy")
const SESSION = "parent-session"
const AGENT = "child-session"
const GOAL = "Review the parser for the reader"
const DECLINED = "That subagent isn't running any more."

const agent = (status: "running" | "done" | "stopped") => ({
  id: AGENT,
  goal: GOAL,
  model: "test/model",
  startedAt: 1,
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
  target: HermesConfig = server,
) =>
  mount(
    <AgentsContext.Provider value={{ agents: [delegated], server: target, sessionId: SESSION }}>
      <AgentCards tool={call} />
    </AgentsContext.Provider>,
    body,
  )

const stops = (calls: Call[]) => calls.filter((call) => call.path.endsWith("/stop"))
const stopButton = () => findAll("button").find((button) => button.textContent?.trim() === "Stop")

test("a subagent still working after its turn ended offers Stop, which stops it", async () => {
  const calls = host()
  await card(agent("running"), tool("completed"), async () => {
    assert.ok(stopButton(), "the card offers Stop once the turn has ended")
    await click(stopButton()!)
    const posted = stops(calls)
    assert.equal(posted.length, 1, "one stop was asked for")
    assert.equal(posted[0].method, "POST")
    assert.equal(posted[0].path, `/api/plugins/memento/sessions/${SESSION}/agents/${AGENT}/stop`)
    assert.match(text(), /Stopped after/, "the card reads the host's answer")
    assert.equal(stopButton(), undefined, "and offers no Stop again")
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

test("a turn still running leaves stopping to the composer", async () => {
  host()
  await card(agent("running"), tool("running"), async () => {
    assert.equal(stopButton(), undefined, "no Stop while the turn that started it runs")
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
    legacyHost,
  )
})
