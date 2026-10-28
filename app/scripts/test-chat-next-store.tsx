/**
 * What chat-next keeps on the device (ADR 0065): the rows a read gave and the turn being streamed,
 * written only where they moved, while what the page is doing starts over each time the thread is
 * opened again.
 */
import assert from "node:assert/strict"
import test from "node:test"

import type { RunEvent } from "@/chat-next/api"
import type { Row } from "@/chat-next/fold"
import { readRows, storeFor } from "@/chat-next/store"
import { db, deleteConversation, type SessionDb } from "@/lib/db"
import { FLUSH_INTERVAL_MS } from "@/lib/freshness"
import { deviceDatabase } from "./chat-next-devices.tsx"

const user = (id: number, content: string): Row => ({ id, role: "user", content })
const reply = (id: number, content: string): Row => ({
  id,
  role: "assistant",
  content,
  finish_reason: "stop",
})
const run = (event: Omit<RunEvent, "seq">, seq = 1): RunEvent => ({ seq, ...event }) as RunEvent

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Counts every row the database is asked to write, so a read that moved nothing can be told apart. */
function countWrites(database: SessionDb) {
  const writes = { rows: 0, states: 0 }
  database.sessionRows.hook("creating", () => void writes.rows++)
  database.sessionRows.hook("updating", () => void writes.rows++)
  database.sessionRows.hook("deleting", () => void writes.rows++)
  database.sessionStates.hook("creating", () => void writes.states++)
  database.sessionStates.hook("updating", () => void writes.states++)
  return writes
}

/** A store kept open, the way a page showing the thread keeps it. */
function opened(database: SessionDb, session: string) {
  const store = storeFor(database, session)
  const leave = store.subscribe(() => {})
  return { store, leave }
}

test("a read keeps its rows in the host's order, and a read that moved nothing writes nothing", async () => {
  const database = deviceDatabase()
  const writes = countWrites(database)
  const { store, leave } = opened(database, "s-order")
  // A compaction's re-emitted rows carry newer ids above older ones: the order is the read's.
  const rows = [user(9, "carried"), reply(10, "Kept."), user(3, "older id, later place")]
  await store.apply({ type: "transcript", rows })
  assert.deepEqual(
    (await readRows(database, "s-order", "live")).map((row) => row.id),
    [9, 10, 3],
  )
  const after = { ...writes }
  await store.apply({ type: "transcript", rows: rows.map((row) => ({ ...row })) })
  assert.deepEqual(writes, after, "the same rows again write nothing")
  await store.apply({ type: "transcript", rows: [...rows, reply(11, "More.")] })
  assert.equal(writes.rows, after.rows + 1, "one new row is one write")
  leave()
})

test("a row the host no longer gives is dropped, and one that changed is written again", async () => {
  const database = deviceDatabase()
  const { store, leave } = opened(database, "s-gone")
  await store.apply({ type: "transcript", rows: [user(1, "one"), reply(2, "First.")] })
  await store.apply({ type: "transcript", rows: [user(1, "one"), reply(2, "First, edited.")] })
  assert.deepEqual(
    (await readRows(database, "s-gone", "live")).map((row) => row.content),
    ["one", "First, edited."],
  )
  await store.apply({ type: "transcript", rows: [reply(2, "First, edited.")] })
  assert.deepEqual(
    (await readRows(database, "s-gone", "live")).map((row) => row.id),
    [2],
  )
  leave()
})

test("streamed words reach the device at the flush's pace, a tool call at once", async () => {
  const database = deviceDatabase()
  const { store, leave } = opened(database, "s-stream")
  await store.apply({ type: "transcript", rows: [] })
  await store.apply({ type: "sent", user: "go" })
  const held = () => database.sessionStates.get("s-stream")
  assert.equal((await held())?.live?.turn.user, "go", "the turn sent is kept at once")

  await store.apply({ type: "run", event: run({ event: "message.delta", delta: "Hal" }) })
  assert.deepEqual((await held())?.live?.turn.parts, [], "a word waits for the flush")
  await sleep(FLUSH_INTERVAL_MS * 2)
  assert.deepEqual((await held())?.live?.turn.parts, [{ kind: "text", text: "Hal" }])

  await store.apply({
    type: "run",
    event: run({ event: "tool.started", tool: "terminal", tool_call_id: "c1" }, 2),
  })
  const parts = (await held())?.live?.turn.parts ?? []
  assert.equal(parts.at(-1)?.kind, "tools", "a call is kept as it starts")
  leave()
})

test("a thread opened again starts from the device's copy, running and waiting on nothing", async () => {
  const database = deviceDatabase()
  const first = opened(database, "s-again")
  await first.store.apply({ type: "transcript", rows: [user(1, "go")] })
  await first.store.apply({ type: "attach" })
  await first.store.apply({
    type: "run",
    event: run({
      event: "approval.request",
      run_id: "r1",
      prompt_id: "p1",
      command: "rm -rf build",
      choices: ["once", "deny"],
    }),
  })
  await first.store.apply({ type: "run", event: run({ event: "message.delta", delta: "Hm" }, 2) })
  assert.equal(first.store.doing().running, true)
  assert.equal(first.store.doing().waiting?.kind, "approval")
  // The page closes mid-run: nothing ends the stream for it.
  first.leave()
  await sleep(FLUSH_INTERVAL_MS * 2)

  const again = opened(database, "s-again")
  assert.notEqual(again.store, first.store, "nobody held the thread, so it is read from the device")
  // Any event waits for the store to read what the device holds.
  await again.store.apply({ type: "answered" })
  assert.equal(again.store.doing().running, false, "a run left behind holds no read back")
  assert.equal(
    again.store.doing().waiting,
    undefined,
    "nor answers a prompt the host may have settled",
  )
  assert.deepEqual(
    again.store.get().live?.turn.parts,
    [{ kind: "text", text: "Hm" }],
    "what was streamed is still drawn until the host's transcript replaces it",
  )
  again.leave()
})

test("deleting a chat deletes what chat-next kept of its session", async () => {
  const session = "memento-delete-me"
  await db.conversations.put({
    id: "c-delete",
    profileId: "p",
    title: "Delete me",
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
    hermesSessionId: session,
  } as never)
  const { store, leave } = opened(db, session)
  await store.apply({ type: "transcript", rows: [user(1, "go"), reply(2, "Gone soon.")] })
  await store.apply({ type: "earlier", rows: [user(1, "go")] })
  await store.apply({ type: "agents", agents: [] })
  leave()
  await sleep(10)
  await deleteConversation("c-delete")
  assert.equal(
    await db.sessionRows.where("[session+set+id]").between([session], [session, []]).count(),
    0,
    "both reads of its rows",
  )
  assert.equal(await db.sessionStates.get(session), undefined, "and its state")
})
