/**
 * A retry in the current chat's fold — chat and code session alike, since both read this one fold:
 * the row the app posts when it re-asks a failed turn draws no message, the answer that follows it
 * lands, and a catch-up keeps that answer instead of dropping it (ADR 0112).
 *
 * Driven here rather than from the unit tier because `history.ts` imports through the app's `@/`
 * aliases, which the bare `node --experimental-strip-types` runner cannot resolve.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db, getMessages } from "@/lib/db"
import { reconcileHistory, toMessages } from "@/lib/history"
import type { SessionMessage } from "@/lib/hermes"
import { retryText } from "@/lib/retry-message"
import { botProfile, json, seedChat } from "./component-kit.tsx"

const SESSION = "retry-session"
const AT = 1_760_000_000

const row = (
  id: number,
  role: SessionMessage["role"],
  content: string,
  extra: Partial<SessionMessage> = {},
): SessionMessage => ({ id, role, content, timestamp: AT, ...extra })

const failed = (id: number) =>
  row(id, "assistant", "Your request was not processed.", { display_kind: "failed_turn" })

const drawn = (rows: SessionMessage[]) => toMessages("c-1", SESSION, rows)

test("a retry draws no message of its own, and its answer follows the turn that failed", () => {
  const messages = drawn([
    row(1, "user", "Look around"),
    failed(2),
    row(3, "user", retryText("Look around")),
    row(4, "assistant", "Looking."),
  ])
  assert.deepEqual(
    messages.map((one) => one.role),
    ["user", "assistant", "assistant"],
    "the request once, the failure, and the second try's answer",
  )
  assert.equal(messages[0].content, "Look around", "the request the failed turn ran")
  assert.equal(
    messages[1].statusText,
    "Your request was not processed.",
    "the host's own words on the reply that failed",
  )
  assert.equal(messages[2].content, "Looking.", "and the retry's answer under it")
})

test("the markers reach no message, and the row it would have drawn is absent", () => {
  const messages = drawn([
    row(1, "user", retryText("Look around")),
    row(2, "assistant", "Looking."),
  ])
  assert.equal(
    messages.some((one) => one.content.includes("RETRY")),
    false,
    "no bubble, and no marker",
  )
  assert.deepEqual(
    messages.map((one) => one.role),
    ["assistant"],
    "a thread of a retry alone reads as its answer",
  )
})

test("a message the user typed that quotes a retry is still the user's", () => {
  const typed = `${retryText("Look around")}\n\nand what did that mean?`
  const messages = drawn([row(1, "user", typed), row(2, "assistant", "Looking.")])
  assert.equal(messages[0].role, "user", "drawn as their message")
  assert.equal(messages[0].content, typed, "with every word they typed")
})

test("a catch-up keeps the answer to a retry, not only the failure it follows", async () => {
  // The chat already holds a message, so the empty-chat fallback cannot stand in for the reply.
  const profile = botProfile("retry-reconcile")
  const rows = [
    row(1, "user", "Look around"),
    failed(2),
    row(3, "user", retryText("Look around")),
    row(4, "assistant", "Looking."),
  ]
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (/\/api\/sessions\/c-1-hermes\/messages$/.test(url.pathname)) return json({ data: rows })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
  await db.messages.clear()
  await seedChat({
    id: "c-1",
    profile,
    messages: [
      {
        id: "m-old",
        conversationId: "c-1",
        role: "user",
        content: "Earlier",
        status: "done",
        createdAt: 1,
      },
    ],
  })
  await reconcileHistory("c-1")
  const after = (await getMessages("c-1")).map((one) => `${one.role}: ${one.content}`)
  assert.ok(
    after.includes("assistant: Looking."),
    `the retry's answer is written: ${after.join(" | ")}`,
  )
  assert.equal(
    after.filter((one) => one === "user: Look around").length,
    1,
    `and the request it re-asks draws once: ${after.join(" | ")}`,
  )
})
