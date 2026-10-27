/**
 * The running turn's reply, read from the transcript, when that turn is the wake run a finished
 * subagent starts. The run has no user message of its own, so it is asked for by the previous turn's:
 * the answer must be the wake reply, not the reply the previous turn already finished — which the
 * chat would draw a second time, whole, under it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { liveTurn } from "@/lib/history"
import type { SessionMessage } from "@/lib/hermes"
import { WAKE_PROMPT_FOOTER, WAKE_PROMPT_HEADER } from "@/lib/wake-prompt"
import { connection, json } from "./component-kit.tsx"

const server = connection("wake-live")
const REQUEST = "Do it"

let next = 0
const row = (role: string, content: string | null, extra: object = {}) =>
  ({ id: ++next, role, content, timestamp: 1_000 + next, ...extra }) as SessionMessage
const withCall = (name: string, text: string) => {
  const call = row("assistant", text, {
    tool_calls: [{ id: `call-${next + 1}`, type: "function", function: { name, arguments: "{}" } }],
  })
  const result = row("tool", '{"output":"ok"}', {
    tool_call_id: call.tool_calls![0].id,
    tool_name: name,
  })
  return [call, result]
}
const wakePrompt = () =>
  row(
    "user",
    `${WAKE_PROMPT_HEADER}child-1]\nA finding\n\n${WAKE_PROMPT_FOOTER} to keep you going]`,
  )

function serve(rows: SessionMessage[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const limit = Number(url.searchParams.get("limit"))
    const offset = Number(url.searchParams.get("offset"))
    return json({
      data: [...rows]
        .sort((a, b) => b.id - a.id)
        .slice(offset, offset + limit)
        .reverse(),
    })
  }) as typeof fetch
}

test("a wake run's reply is read as its own, not as the turn before it", async () => {
  next = 0
  serve([
    row("user", REQUEST),
    ...withCall("terminal", "Pass one is applied"),
    row("assistant", "Waiting on the subagent."),
    wakePrompt(),
    ...withCall("patch", "The finding changes the plan"),
  ])
  const reply = await liveTurn(server, "s", REQUEST)
  assert.equal(reply?.content, "The finding changes the plan")
  assert.deepEqual(
    reply?.tools?.map((tool) => tool.tool),
    ["patch"],
    "only the wake run's own calls",
  )
})

test("a wake run with nothing written yet is not the turn before it either", async () => {
  next = 0
  serve([row("user", REQUEST), ...withCall("terminal", "Pass one is applied"), wakePrompt()])
  const reply = await liveTurn(server, "s", REQUEST)
  assert.ok(
    !reply || !reply.content.includes("Pass one"),
    `drew the earlier reply: ${reply?.content}`,
  )
})

test("a turn the user started is still its own reply, wake runs before it left alone", async () => {
  next = 0
  serve([
    row("user", "Earlier ask"),
    ...withCall("terminal", "Earlier work"),
    wakePrompt(),
    ...withCall("patch", "Wake work"),
    row("user", REQUEST),
    ...withCall("terminal", "This turn's work"),
  ])
  const reply = await liveTurn(server, "s", REQUEST)
  assert.equal(reply?.content, "This turn's work")
})

test("a later turn of another device does not become this turn's reply", async () => {
  next = 0
  serve([
    row("user", REQUEST),
    ...withCall("terminal", "This turn's work"),
    row("user", "Sent from another device"),
    ...withCall("patch", "That turn's work"),
  ])
  const reply = await liveTurn(server, "s", REQUEST)
  assert.equal(reply?.content, "This turn's work")
})

test("a turn with no reply written yet reads as nothing, not as the next turn's reply", async () => {
  next = 0
  serve([
    row("user", REQUEST),
    row("user", "Sent from another device"),
    ...withCall("patch", "That turn's work"),
  ])
  assert.equal(await liveTurn(server, "s", REQUEST), undefined)
})
