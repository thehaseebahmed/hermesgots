/**
 * Sending from a bot's Main thread, over a seeded device database with the HTTP boundary faked: the
 * message wears a routing state while the host decides, falls back to Main on a timeout or a failure,
 * is never triaged inside an open thread, and a host without the feature has a plain Main.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { sendFromMain, settleRouting } from "@/lib/chat"
import { db, mainThreadId } from "@/lib/db"
import { TRIAGE_MS } from "@/lib/freshness"
import { botProfile, json, seedSettings, until } from "./component-kit.tsx"

const MAIN = mainThreadId("bot-1")
const MAIN_SESSION = `memento-${MAIN}`

type Answer = "stay" | "thread" | "fail" | "hang"

/** One host: what it advertises, how triage answers, and every request it was sent. */
function host(name: string, triage: Answer, features: string[] = ["queue", "triage"]) {
  const seen: { path: string; body: any }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    seen.push({ path: url.pathname, body })
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/memento/info")) return json({ features })
    if (url.pathname.endsWith("/triage")) {
      if (triage === "fail") return json({ error: { message: "no" } }, 500)
      if (triage === "hang")
        return new Promise<Response>((_, reject) => {
          // AbortSignal.timeout's timer doesn't hold the event loop open, so something else must.
          const keep = setInterval(() => {}, 100)
          init?.signal?.addEventListener("abort", () => {
            clearInterval(keep)
            reject(new DOMException("t", "TimeoutError"))
          })
        })
      return json(
        triage === "thread"
          ? { decision: "thread", thread: "t1", session_id: "t1-hermes", item: { id: "q_1" } }
          : { decision: "main" },
      )
    }
    // The run is refused, so a send ends at once; that it was posted is what the tests read.
    if (url.pathname.endsWith("/v1/runs") && init?.method === "POST")
      return json({ error: { message: "stopped here" } }, 500)
    return json({})
  }) as typeof fetch
  return seen
}

async function seed(name: string, extra: { main?: boolean } = { main: true }) {
  const bot = botProfile(name)
  await seedSettings({ developer: true, botThreads: true })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut([
    {
      id: MAIN,
      profileId: bot.id,
      title: "Main",
      hermesSessionId: MAIN_SESSION,
      createdAt: 1,
      updatedAt: 1,
      changedAt: 0,
      main: extra.main,
    },
    {
      id: "t1",
      profileId: bot.id,
      title: "Trip to Lisbon",
      hermesSessionId: "t1-hermes",
      createdAt: 1,
      updatedAt: 5,
      changedAt: 1,
    },
  ])
}

const messagesOf = (id: string) => db.messages.where("conversationId").equals(id).toArray()
const triaged = (seen: { path: string }[]) => seen.filter((r) => r.path.endsWith("/triage"))
/** The turns posted to Hermes, by the session each was for. */
const runsFor = (seen: { path: string; body: any }[], session: string) =>
  seen.filter((r) => r.path.endsWith("/v1/runs") && r.body?.session_id === session)

test("a message holds in a routing state while the host decides", async () => {
  await seed("route-state")
  const seen = host("route-state", "hang")
  const sending = sendFromMain(MAIN, "more on Lisbon")
  await until(
    async () => (await messagesOf(MAIN)).some((m) => m.status === "routing"),
    "the routing state",
  )
  assert.equal(triaged(seen).length, 1)
  assert.equal(triaged(seen)[0].body.text, "more on Lisbon")
  assert.equal(triaged(seen)[0].body.body.session_id, MAIN_SESSION)
  assert.equal(TRIAGE_MS > 0, true)
  await sending
})

test("a timeout sends the message to Main", async () => {
  await seed("route-timeout")
  const seen = host("route-timeout", "hang")
  assert.equal(await sendFromMain(MAIN, "hello"), undefined)
  assert.equal(runsFor(seen, MAIN_SESSION).length, 1)
  const sent = await messagesOf(MAIN)
  assert.ok(sent.some((m) => m.role === "user" && m.content === "hello"))
  assert.ok(!sent.some((m) => m.status === "routing"))
})

test("a failed triage sends the message to Main", async () => {
  await seed("route-fail")
  const seen = host("route-fail", "fail")
  assert.equal(await sendFromMain(MAIN, "hello"), undefined)
  assert.equal(runsFor(seen, MAIN_SESSION).length, 1)
})

test("a message the host sent to a thread never enters Main", async () => {
  await seed("route-thread")
  const seen = host("route-thread", "thread")
  assert.equal(await sendFromMain(MAIN, "more on Lisbon"), "t1")
  assert.equal(runsFor(seen, MAIN_SESSION).length, 0, "Main's session never starts a run")
  assert.deepEqual(await messagesOf(MAIN), [])
})

test("a stay is a plain send to Main", async () => {
  await seed("route-stay")
  const seen = host("route-stay", "stay")
  assert.equal(await sendFromMain(MAIN, "what's 2+2"), undefined)
  assert.equal(runsFor(seen, MAIN_SESSION).length, 1)
})

test("an open thread is never triaged", async () => {
  await seed("route-open")
  const seen = host("route-open", "thread")
  assert.equal(await sendFromMain("t1", "hello"), undefined)
  assert.equal(triaged(seen).length, 0)
  assert.equal(runsFor(seen, "t1-hermes").length, 1)
})

test("a bot whose plugin lacks the feature has a plain Main", async () => {
  await seed("route-plain")
  const seen = host("route-plain", "thread", ["queue"])
  assert.equal(await sendFromMain(MAIN, "hello"), undefined)
  assert.equal(triaged(seen).length, 0)
  assert.equal(runsFor(seen, MAIN_SESSION).length, 1)
})

test("a message sent while another is triaged waits behind it, untriaged", async () => {
  await seed("route-second")
  const seen = host("route-second", "hang")
  const first = sendFromMain(MAIN, "first")
  await until(
    async () => (await messagesOf(MAIN)).some((m) => m.status === "routing"),
    "the first to be routing",
  )
  await sendFromMain(MAIN, "second")
  assert.equal(triaged(seen).filter((r) => r.body.text === "second").length, 0)
  assert.ok((await messagesOf(MAIN)).some((m) => m.content === "second" && m.status === "queued"))
  await first
  assert.ok(!(await messagesOf(MAIN)).some((m) => m.status === "routing"))
})

test("a repeated ask carries the same id, so the host can answer it as before", async () => {
  await seed("route-retry")
  const seen = host("route-retry", "hang")
  await sendFromMain(MAIN, "hello")
  const asks = triaged(seen)
  assert.equal(asks.length, 2)
  assert.equal(asks[0].body.id, asks[1].body.id)
})

test("a message left routing by a closed page becomes one to send again", async () => {
  await seed("route-stale")
  await db.messages.add({
    id: "m1",
    conversationId: MAIN,
    role: "user",
    content: "hi",
    status: "routing",
    createdAt: 5,
  })
  await settleRouting(MAIN)
  assert.equal((await db.messages.get("m1"))?.status, "error")
})

test("a thread answer without the queued message is not taken as sent", async () => {
  await seed("route-noitem")
  const seen = host("route-noitem", "thread")
  const fetchWith = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    return url.pathname.endsWith("/triage")
      ? json({ decision: "thread", thread: "t1" })
      : fetchWith(input, init)
  }) as typeof fetch
  assert.equal(await sendFromMain(MAIN, "more on Lisbon"), undefined)
  assert.equal(runsFor(seen, MAIN_SESSION).length, 1)
})
