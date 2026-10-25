/**
 * The session's Stop, asked of the host as one call where it advertises `subagents_stop_all`, and as
 * one call per agent where it doesn't — the same reach either way. A host whose call never lands
 * throws, for the caller to say so, and nothing is recorded against an agent it was never answered
 * about.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { stopSubagents } from "@/lib/agents"
import type { DelegatedAgent, HermesConfig } from "@/lib/hermes"

import { connection, json } from "./component-kit.tsx"

const server: HermesConfig = connection("subagent-stop-all")
const SESSION = "parent-session"

const agent = (id: string, status: DelegatedAgent["status"]): DelegatedAgent => ({
  id,
  goal: "You are the Builder: write the parser",
  model: "test/model",
  startedAt: 1_700_000_000,
  endedAt: status === "running" ? null : 1_700_000_600,
  toolCalls: 3,
  status,
})

type Call = { method: string; path: string }

function host(handler?: (path: string) => Response | undefined) {
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push({ method, path: url.pathname })
    const answer = handler?.(url.pathname)
    if (answer) return answer
    if (url.pathname.endsWith("/plugins/memento/info"))
      return json({ name: "memento", features: ["agents", "subagent_stop", "subagents_stop_all"] })
    if (url.pathname.endsWith("/agents/stop") && method === "POST")
      return json({
        object: "memento.agents_stop",
        session_id: SESSION,
        stopped: 2,
        agents: [
          { id: "first", stopped: true },
          { id: "second", stopped: false, reason: "That subagent isn't running any more." },
        ],
      })
    if (url.pathname.endsWith("/stop") && method === "POST")
      return json({ object: "memento.agent_stop", session_id: SESSION, stopped: true })
    return json({ error: "not found" }, 404)
  }) as typeof fetch
  return calls
}

test("one call stops every subagent a session holds, and reads the host's answer per agent", async () => {
  const calls = host()
  const agents = [agent("first", "running"), agent("second", "running"), agent("third", "done")]
  const answer = await stopSubagents(server, SESSION, agents, { stopAll: true })
  const posted = calls.filter((call) => call.path.endsWith("/stop"))
  assert.equal(posted.length, 1, "one press, one call")
  assert.equal(posted[0].path, `/api/plugins/memento/sessions/${SESSION}/agents/stop`)
  assert.deepEqual(
    answer.rows.map((row) => [row.id, row.stopped]),
    [
      ["first", true],
      ["second", false],
    ],
    "the host names what it did, and why it didn't for the rest",
  )
  assert.equal(answer.rows.filter((row) => row.stopped).length, 1, "one it stopped")
  assert.equal(answer.rows.filter((row) => !row.stopped).length, 1, "and one it couldn't")
})

test("a host from before the route is asked once per agent instead", async () => {
  const calls = host((path) =>
    path.endsWith("/agents/stop") ? json({ error: "not found" }, 404) : undefined,
  )
  const agents = [agent("first", "running"), agent("second", "running"), agent("third", "done")]
  const answer = await stopSubagents(server, SESSION, agents, { stopAll: false })
  const posted = calls.filter((call) => call.path.endsWith("/stop"))
  assert.deepEqual(
    posted.map((call) => call.path),
    [
      `/api/plugins/memento/sessions/${SESSION}/agents/first/stop`,
      `/api/plugins/memento/sessions/${SESSION}/agents/second/stop`,
    ],
    "one call per agent at work, and none for the one that finished",
  )
  assert.deepEqual(
    answer.rows.map((row) => [row.id, row.stopped]),
    [
      ["first", true],
      ["second", true],
    ],
  )
})

test("the one call is made even when this device last read nothing running", async () => {
  const calls = host()
  await stopSubagents(server, SESSION, [agent("third", "done")], { stopAll: true })
  assert.equal(
    calls.filter((call) => call.path.endsWith("/agents/stop")).length,
    1,
    "the host decides which of its children are still at work",
  )
})

test("a call that never lands throws, for the caller to say so", async () => {
  host(() => json({ error: { message: "nope" } }, 500))
  await assert.rejects(
    () => stopSubagents(server, SESSION, [agent("first", "running")], { stopAll: true }),
    "a failed call is not an answer about any agent",
  )
})
