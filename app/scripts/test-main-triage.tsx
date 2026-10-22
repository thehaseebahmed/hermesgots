/**
 * Sending from a bot's Main thread, over a seeded device database with the HTTP boundary faked: the
 * message wears a routing state while the host decides, falls back to Main on a timeout or a failure,
 * is never triaged inside an open thread, and a host without the feature has a plain Main.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"

import { MovedMarker } from "@/components/chat/moved-marker"
import { sendFromMain, settleRouting, stopMessage } from "@/lib/chat"
import { db, mainThreadId, type Message } from "@/lib/db"
import { moveMarks, refreshMoves, undoMove } from "@/lib/moves"
import { TRIAGE_MS } from "@/lib/freshness"
import { botProfile, json, seedSettings, until } from "./component-kit.tsx"

const MAIN = mainThreadId("bot-1")
const MAIN_SESSION = `memento-${MAIN}`

type Answer = "stay" | "thread" | "new" | "fail" | "hang"

/** One host: what it advertises, how triage answers, and every request it was sent. */
const uploads: string[] = []
/** Hosts whose runs never answer, so a reply started on them stays running. */
const hangingRuns = new Set<string>()
const hung = new Set<() => void>()

/** Ends every run a host left hanging, so the reply that waited on it settles. */
function endRuns() {
  for (const end of hung) end()
  hung.clear()
}

function host(name: string, triage: Answer, features: string[] = ["queue", "triage", "moves"]) {
  const seen: { path: string; body: any }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
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
          : triage === "new"
            ? { decision: "new", thread: "n1", session_id: "memento-n1", item: { id: "q_2" } }
            : { decision: "main" },
      )
    }
    if (url.pathname.endsWith("/attachments") && init?.method === "POST") {
      uploads.push(url.searchParams.get("name") ?? "")
      return json({
        name: url.searchParams.get("name"),
        path: `/host/${url.searchParams.get("name")}`,
        size: 3,
      })
    }
    // The run is refused, so a send ends at once; that it was posted is what the tests read.
    if (url.pathname.endsWith("/v1/runs") && init?.method === "POST" && hangingRuns.has(name))
      return new Promise<Response>((_, reject) => {
        const keep = setInterval(() => {}, 100)
        hung.add(() => {
          clearInterval(keep)
          reject(new DOMException("stopped", "AbortError"))
        })
      })
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
  assert.deepEqual(await sendFromMain(MAIN, "more on Lisbon"), { threadId: "t1", created: false })
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

test("a message the host opened a new thread for never enters Main", async () => {
  await seed("route-new")
  const seen = host("route-new", "new")
  assert.deepEqual(await sendFromMain(MAIN, "plan my move"), { threadId: "n1", created: true })
  assert.equal(runsFor(seen, MAIN_SESSION).length, 0, "Main's session never starts a run")
  assert.deepEqual(await messagesOf(MAIN), [])
})

test("a message with files is triaged with them saved on the host first", async () => {
  await seed("route-files")
  uploads.length = 0
  const seen = host("route-files", "new")
  const attachment = {
    id: "a1",
    name: "brief.pdf",
    type: "application/pdf",
    size: 3,
    blob: new Blob(["pdf"]),
  }
  assert.deepEqual(await sendFromMain(MAIN, "read this", [attachment]), {
    threadId: "n1",
    created: true,
  })
  assert.deepEqual(uploads, ["brief.pdf"])
  const ask = triaged(seen)[0].body
  assert.deepEqual(ask.attachments, [
    { name: "brief.pdf", type: "application/pdf", size: 3, path: "/host/brief.pdf" },
  ])
  assert.match(JSON.stringify(ask.body.input), /\/host\/brief\.pdf/)
})

test("a stay keeps the files already saved and saves nothing twice", async () => {
  await seed("route-files-stay")
  uploads.length = 0
  const seen = host("route-files-stay", "stay")
  const attachment = {
    id: "a1",
    name: "brief.pdf",
    type: "application/pdf",
    size: 3,
    blob: new Blob(["pdf"]),
  }
  assert.equal(await sendFromMain(MAIN, "read this", [attachment]), undefined)
  assert.deepEqual(uploads, ["brief.pdf"])
  assert.equal(runsFor(seen, MAIN_SESSION).length, 1)
})

test("a move is read back from the host and leaves a marker, a stay leaves none", async () => {
  await seed("route-marks")
  host("route-marks", "stay")
  await refreshMoves(MAIN)
  assert.equal((await db.conversations.get(MAIN))?.moves, undefined)
  const move = { id: "m1", text: "more on Lisbon", thread: "t1", at: 10, undone: false, undoable: true }
  const fetchWith = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    return url.pathname.endsWith("/moves") ? json({ moves: [move] }) : fetchWith(input, init)
  }) as typeof fetch
  await refreshMoves(MAIN)
  assert.deepEqual((await db.conversations.get(MAIN))?.moves, [
    { id: "m1", text: "more on Lisbon", threadId: "t1", at: 10, undone: false, undoable: true },
  ])
  await refreshMoves("t1")
  assert.equal((await db.conversations.get("t1"))?.moves, undefined)
})

test("markers sit in time order among Main's messages, and an undone move has none", () => {
  const at = (id: string, createdAt: number) =>
    ({ id, conversationId: MAIN, role: "user", content: id, createdAt }) as Message
  const marks = moveMarks(
    [at("a", 5), at("b", 20), at("c", 30)],
    [
      { id: "m1", text: "x", threadId: "t1", at: 10, undone: false, undoable: true },
      { id: "m2", text: "y", threadId: "t1", at: 15, undone: false, undoable: true },
      { id: "m3", text: "z", threadId: "t1", at: 99, undone: false, undoable: true },
      { id: "m4", text: "w", threadId: "t1", at: 12, undone: true, undoable: false },
    ],
  )
  assert.deepEqual(
    marks.before.get("b")?.map((m) => m.id),
    ["m1", "m2"],
  )
  assert.equal(marks.before.size, 1)
  assert.deepEqual(
    marks.trailing.map((m) => m.id),
    ["m3"],
  )
})

test("tapping a marker opens its thread", async () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <MovedMarker
        move={{ id: "m1", text: "more on Lisbon", threadId: "t1", at: 10, undone: false, undoable: true }}
        title="Trip to Lisbon"
        profileId="bot-1"
      />
    </MemoryRouter>,
  )
  assert.match(html, /href="\/c\/t1"/)
  assert.match(html, /Moved to \u201c.*Trip to Lisbon.*\u201d/)
  // The message itself is drawn as the user's bubble, with the line under it.
  assert.ok(html.indexOf("more on Lisbon") < html.indexOf("Moved to"))
})

test("Undo shows on a fresh marker and goes once the thread has replied", () => {
  const render = (undoable: boolean) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <MovedMarker
          move={{ id: "m1", text: "more on Lisbon", threadId: "t1", at: 10, undone: false, undoable }}
          profileId="bot-1"
          onUndo={() => undefined}
        />
      </MemoryRouter>,
    )
  assert.match(render(true), />Undo</)
  assert.doesNotMatch(render(false), /Undo/)
})

test("undoing a move asks the host, then reads the markers again", async () => {
  await seed("route-undo")
  host("route-undo", "stay")
  const fetchWith = globalThis.fetch
  const calls: string[] = []
  let undone = false
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/moves/m1/undo")) {
      calls.push(`${init?.method} ${url.pathname.split("/sessions/")[1]}`)
      undone = true
      return json({ undone: true })
    }
    if (url.pathname.endsWith("/moves"))
      return json({
        moves: [{ id: "m1", text: "more", thread: "t1", at: 10, undone, undoable: !undone }],
      })
    return fetchWith(input, init)
  }) as typeof fetch
  await refreshMoves(MAIN)
  assert.equal((await db.conversations.get(MAIN))?.moves?.[0].undoable, true)
  await undoMove(MAIN, "m1")
  assert.deepEqual(calls, [`POST ${MAIN_SESSION}/moves/m1/undo`])
  const [after] = (await db.conversations.get(MAIN))?.moves ?? []
  assert.deepEqual([after.undone, after.undoable], [true, false])
})

test("a Main send while Main's reply runs is triaged at once and moves without waiting", async () => {
  await seed("route-busy-move")
  hangingRuns.add("route-busy-move")
  const seen = host("route-busy-move", "stay")
  void sendFromMain(MAIN, "first")
  await until(async () => runsFor(seen, MAIN_SESSION).length === 1, "Main's reply to run")
  const busy = host("route-busy-move", "thread")
  busy.push(...seen)
  assert.deepEqual(await sendFromMain(MAIN, "more on Lisbon", [], { steer: true }), {
    threadId: "t1",
    created: false,
  })
  const ask = triaged(busy).find((r) => r.body.text === "more on Lisbon")
  assert.equal(ask?.body.steer, true, "the user's setting rides along for the thread")
  assert.ok(!(await messagesOf(MAIN)).some((m) => m.content === "more on Lisbon"))
  stopMessage(MAIN)
  endRuns()
  await until(
    async () => !(await messagesOf(MAIN)).some((m) => m.status === "streaming"),
    "Main's reply to stop",
  )
})

test("a Main send that stays while Main's reply runs waits queued in Main", async () => {
  await seed("route-busy-stay")
  hangingRuns.add("route-busy-stay")
  const seen = host("route-busy-stay", "stay")
  void sendFromMain(MAIN, "first")
  await until(async () => runsFor(seen, MAIN_SESSION).length === 1, "Main's reply to run")
  assert.equal(await sendFromMain(MAIN, "and this"), undefined)
  assert.equal(triaged(seen).filter((r) => r.body.text === "and this").length, 1)
  const held = (await messagesOf(MAIN)).filter((m) => m.content === "and this")
  assert.equal(held.length, 1)
  assert.equal(held[0].status, "queued")
  stopMessage(MAIN)
  endRuns()
  await until(
    async () => !(await messagesOf(MAIN)).some((m) => m.status === "streaming"),
    "Main's reply to stop",
  )
})
