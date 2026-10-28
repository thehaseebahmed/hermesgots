/**
 * What the live read of a turn is asked by: when its run began, from the host. A host that can't say
 * leaves the read for the next round rather than guessing from this device's clock, and a start the
 * host did give is kept for the turn.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { turnSource, type Turn } from "@/lib/chat"

import { botProfile, connection, json, seedChat } from "./component-kit.tsx"

const server = connection("turn-source")

async function turnWith(runId: string | undefined) {
  await seedChat({ id: "c", profile: botProfile("turn-source") })
  return {
    conversationId: "c",
    config: server,
    draft: { id: "r", runId, createdAt: 5_000_000 },
  } as unknown as Turn
}

function answerRun(reply: () => Response) {
  let asked = 0
  globalThis.fetch = (async () => {
    asked++
    return reply()
  }) as unknown as typeof fetch
  return () => asked
}

test("a run's start is the host's, kept for the turn", async () => {
  const asked = answerRun(() => json({ status: "running", created_at: 4_999 }))
  const turn = await turnWith("run-1")
  assert.equal((await turnSource(turn))?.since, 4_999)
  assert.equal((await turnSource(turn))?.since, 4_999)
  assert.equal(asked(), 1, "asked once")
})

test("a host that can't say leaves the read for the next round, and is asked again", async () => {
  let ok = false
  const asked = answerRun(() =>
    ok ? json({ status: "running", created_at: 4_999 }) : json({ error: { message: "down" } }, 500),
  )
  const turn = await turnWith("run-1")
  assert.equal(await turnSource(turn), undefined, "no guess from this device's clock")
  ok = true
  assert.equal((await turnSource(turn))?.since, 4_999)
  assert.equal(asked(), 2)
})

test("a run status without a start is not guessed either", async () => {
  answerRun(() => json({ status: "running" }))
  assert.equal(await turnSource(await turnWith("run-1")), undefined)
})

test("a turn with no run, a chat-completions one, is placed by when it was sent", async () => {
  const asked = answerRun(() => json({}))
  assert.equal((await turnSource(await turnWith(undefined)))?.since, 5_000)
  assert.equal(asked(), 0, "nothing to ask the host")
})
