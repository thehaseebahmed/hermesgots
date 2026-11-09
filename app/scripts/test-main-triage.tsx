/**
 * Sending from a bot's Main thread, over a seeded device database with the HTTP boundary faked: the
 * message wears a triaging state while the host decides, falls back to Main on a timeout or a failure,
 * is never triaged inside an open thread, and a host without the feature has a plain Main.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { act } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import Dexie from "dexie"

import { MovedMarker } from "@/components/chat/moved-marker"
import { Composer } from "@/components/chat/composer"
import {
  queueMessage,
  refreshQueue,
  sendFromMain,
  sendMessage,
  sendQueued,
  settleTriaging,
  stopMessage,
} from "@/lib/chat"
import { db, MESSAGE_STORES, mainThreadId, type Message, type Profile } from "@/lib/db"
import { prepareIntake } from "@/lib/attachments"
import type { Move } from "@/lib/hermes"
import { moveMarks } from "@/lib/move-marks"
import { refreshMoves, undoMove } from "@/lib/moves"
import { TRIAGE_MS } from "@/lib/freshness"
import {
  botProfile,
  click,
  connection,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  type,
  until,
} from "./component-kit.tsx"

/**
 * How long a test waits for a run to be posted. Every send here is queued, triaged and posted by the
 * app's own code rather than answered inline, and the component tier runs two files at once: on a
 * loaded runner the twelve seconds a wait is given by default has been spent before the post lands.
 */
const RUN_START = 30_000

const MAIN = mainThreadId("bot-1")
const MAIN_SESSION = `gots-${MAIN}`

type Answer = "stay" | "thread" | "new" | "fail" | "hang"

/** One host: what it advertises, how triage answers, and every request it was sent. */
const uploads: string[] = []
/** Hosts whose runs never answer, so a reply started on them stays running. */
const hangingRuns = new Set<string>()
/** Hosts that answer an upload with the 404 a plugin without the route gives. */
const noUploadRoute = new Set<string>()
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
    if (url.pathname.endsWith("/plugins/gots/info")) return json({ features })
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
            ? { decision: "new", thread: "n1", session_id: "gots-n1", item: { id: "q_2" } }
            : { decision: "main" },
      )
    }
    if (url.pathname.endsWith("/attachments") && init?.method === "POST") {
      if (noUploadRoute.has(name)) return json({ error: { message: "no such route" } }, 404)
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

async function seed(
  name: string,
  extra: {
    main?: boolean
    bot?: Partial<Profile>
    keepMessages?: boolean
    chatThreads?: boolean
  } = { main: true },
) {
  const bot = botProfile(name, extra.bot)
  await seedSettings({ developer: true, chatThreads: extra.chatThreads ?? true })
  await db.profiles.clear()
  await db.profiles.put(bot)
  if (!extra.keepMessages) await db.messages.clear()
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
const recordedMove = (overrides: Partial<Move> = {}): Move => ({
  id: "m1",
  text: "more on Lisbon",
  threadId: "t1",
  at: Date.now() - 1_000,
  undone: false,
  undoable: true,
  new: false,
  ...overrides,
})
const triaged = (seen: { path: string }[]) => seen.filter((r) => r.path.endsWith("/triage"))
/** The turns posted to Hermes, by the session each was for. */
const runsFor = (seen: { path: string; body: any }[], session: string) =>
  seen.filter((r) => r.path.endsWith("/v1/runs") && r.body?.session_id === session)

test("a message holds in a triaging state while the host decides", async () => {
  await seed("route-state")
  const seen = host("route-state", "hang")
  const sending = sendFromMain(MAIN, "more on Lisbon")
  await until(
    async () => (await messagesOf(MAIN)).some((m) => m.status === "triaging"),
    "the triaging state",
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
  assert.ok(!sent.some((m) => m.status === "triaging"))
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

test("with chat threads off, a Main send asks no triage and stays in Main", async () => {
  // The capabilities and info reads this log holds are the send's own; triage adds no ask.
  await seed("route-threads-off", { main: true, chatThreads: false })
  const seen = host("route-threads-off", "thread")
  assert.equal(await sendFromMain(MAIN, "hello"), undefined)
  assert.deepEqual(triaged(seen), [], "no /triage ask")
  const sent = await messagesOf(MAIN)
  assert.ok(
    sent.some((m) => m.role === "user" && m.content === "hello"),
    "the message is in Main",
  )
  assert.ok(!sent.some((m) => m.status === "triaging"), "nothing was held for a decision")
  assert.equal(runsFor(seen, MAIN_SESSION).length, 1, "its turn posted on Main's session")
})

test("a message sent while another is triaged waits behind it, untriaged", async () => {
  await seed("route-second")
  const seen = host("route-second", "hang")
  const first = sendFromMain(MAIN, "first")
  await until(
    async () => (await messagesOf(MAIN)).some((m) => m.status === "triaging"),
    "the first to be triaging",
  )
  await sendFromMain(MAIN, "second")
  assert.equal(triaged(seen).filter((r) => r.body.text === "second").length, 0)
  assert.ok((await messagesOf(MAIN)).some((m) => m.content === "second" && m.status === "queued"))
  await first
  assert.ok(!(await messagesOf(MAIN)).some((m) => m.status === "triaging"))
})

test("a repeated ask carries the same id, so the host can answer it as before", async () => {
  await seed("route-retry")
  const seen = host("route-retry", "hang")
  await sendFromMain(MAIN, "hello")
  const asks = triaged(seen)
  assert.equal(asks.length, 2)
  assert.equal(asks[0].body.id, asks[1].body.id)
})

test("a message left triaging by a closed page becomes one to send again", async () => {
  await seed("route-stale")
  await db.messages.add({
    id: "m1",
    conversationId: MAIN,
    role: "user",
    content: "hi",
    status: "triaging",
    createdAt: 5,
  })
  await settleTriaging(MAIN)
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

/** The run a triage ask carries, as the host reads it for the thread the message lands in. */
const namedInAsk = (seen: { path: string; body: any }[]) => triaged(seen)[0]?.body.body

test("the triage ask names a bot's own default model, both halves", async () => {
  const chosen = { provider: "anthropic", model: "claude-sonnet-4.5" }
  await seed("route-model-bot", { main: true, bot: { modelChoice: chosen } })
  const seen = host("route-model-bot", "new")
  assert.deepEqual(await sendFromMain(MAIN, "plan my move"), { threadId: "n1", created: true })
  const run = namedInAsk(seen)
  assert.deepEqual([run.model, run.provider], [chosen.model, chosen.provider])
})

test("a bot with no default names the host's remembered model, both halves", async () => {
  const remembered = { provider: "openrouter", model: "openai/gpt-5" }
  await seed("route-model-host", { main: true, bot: { hostModel: remembered } })
  const seen = host("route-model-host", "thread")
  assert.deepEqual(await sendFromMain(MAIN, "more on Lisbon"), {
    threadId: "t1",
    created: false,
  })
  const run = namedInAsk(seen)
  assert.deepEqual([run.model, run.provider], [remembered.model, remembered.provider])
})

test("a Main that holds a pick of its own names that, not the bot's default", async () => {
  const mainPick = { provider: "openai", model: "gpt-5" }
  const botDefault = { provider: "anthropic", model: "claude-sonnet-4.5" }
  await seed("route-model-main", {
    main: true,
    bot: { modelChoice: botDefault },
  })
  await db.conversations.update(MAIN, { modelChoice: mainPick })
  const seen = host("route-model-main", "thread")
  assert.deepEqual(await sendFromMain(MAIN, "more on Lisbon"), {
    threadId: "t1",
    created: false,
  })
  const run = namedInAsk(seen)
  assert.deepEqual([run.model, run.provider], [mainPick.model, mainPick.provider])
})

test("a device that can name no model names none, and asks the host nothing", async () => {
  await seed("route-model-none")
  const seen = host("route-model-none", "new")
  assert.deepEqual(await sendFromMain(MAIN, "plan my move"), { threadId: "n1", created: true })
  const run = namedInAsk(seen)
  assert.equal("model" in run, false)
  assert.equal("provider" in run, false)
  assert.equal(
    seen.some((r) => r.path.endsWith("/models")),
    false,
    "no model read on the send path",
  )
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

test("a stored photo with no part still goes inline when its message is sent again", async () => {
  const older = new Dexie("gots")
  older.version(34).stores({ messages: MESSAGE_STORES, conversations: "id, updatedAt" })
  await db.close()
  await Dexie.delete("gots")
  await older.open()
  await older.table("conversations").add({
    id: MAIN,
    profileId: "bot-1",
    title: "Main",
    hermesSessionId: MAIN_SESSION,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 0,
    main: true,
  })
  await older.table("messages").add({
    id: "stored-photo",
    conversationId: MAIN,
    role: "user",
    content: "look at this",
    status: "error",
    createdAt: 5,
    attachments: [
      {
        id: "p1",
        name: "cat.png",
        type: "image/png",
        size: 3,
        image: true,
        blob: new Blob(["png"], { type: "image/png" }),
      },
    ],
  })
  await older.close()
  await db.open()
  await seed("route-stored-photo", { keepMessages: true })
  const seen = host("route-stored-photo", "stay")
  await sendQueued((await db.messages.get("stored-photo"))!)
  const parts = runsFor(seen, MAIN_SESSION)[0]?.body.input.at(-1).content as {
    type: string
    image_url?: { url: string }
  }[]
  const photo = parts.find((part) => part.type === "image_url")
  assert.ok(photo, "the photo rides in the message, as the build before this one sent it")
  assert.match(photo.image_url?.url ?? "", /^data:image\/png;base64,/, "with its own bytes")
})

test("a photo that travels as a file says why it never reached the agent when the host won't take it", async () => {
  await seed("route-photo-refused")
  uploads.length = 0
  noUploadRoute.add("route-photo-refused")
  const seen = host("route-photo-refused", "stay")
  try {
    const picked = await prepareIntake(
      [new File(["heic"], "IMG_0001.heic", { type: "image/heic", lastModified: 9 })],
      { readsImages: false, route: "unknown" },
    )
    assert.equal(picked.attachments.length, 1, "the photo the pick hands the send")
    assert.equal(picked.attachments[0].image, true, "is the picture it is")
    assert.equal(picked.attachments[0].inline, undefined, "with its bytes left for the host to keep")

    await assert.rejects(
      () => sendFromMain(MAIN, "look at this", picked.attachments),
      /Couldn't attach IMG_0001\.heic\. Check that Hermes is reachable and its Gots plugin is up to date\./,
    )
    assert.deepEqual(runsFor(seen, MAIN_SESSION), [], "nothing reached the agent")
  } finally {
    noUploadRoute.delete("route-photo-refused")
  }
})

/** The tiles the message carries, by name: each one's own Remove button. */
const tileNames = () =>
  findAll("[aria-label^='Remove ']").map((button) =>
    button.getAttribute("aria-label")!.replace("Remove ", ""),
  )

/** A pick from the `+` menu's own Camera input, the way the browser hands one over. */
async function pickCamera(file: File) {
  const input = document.querySelector('input[name="camera"]')
  assert.ok(input, "the menu's picker is on screen")
  Object.defineProperty(input, "files", { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}

test("a photo picked for a model that reads no images reaches the agent as a path, never as bytes", async () => {
  // The seam a pick crosses, end to end: the composer's `onSend`, the send to Main, the plugin's
  // upload and the body the run is started with — where the composer's own test stops at the send.
  await seed("route-blind-photo", { main: true, bot: { imageInput: false } })
  uploads.length = 0
  const seen = host("route-blind-photo", "stay")
  const bot = (await db.profiles.get("bot-1"))!
  await mount(
    <Composer
      busy={false}
      connection={connection("route-blind-photo")}
      filesFeature="yes"
      imagesAvailable={bot.imageInput !== false}
      onSend={(text, attachments) => sendFromMain(MAIN, text, attachments)}
      onQueue={() => {}}
      onStop={() => {}}
      onCommand={() => {}}
    />,
    async () => {
      await pickCamera(new File(["heic"], "IMG_0001.heic", { type: "image/heic", lastModified: 7 }))
      assert.deepEqual(tileNames(), ["IMG_0001.heic"], "the pick lands on the message")
      await type(document.querySelector("textarea"), "what is this?")
      await click(findAll("button").find((one) => one.getAttribute("aria-label") === "Send"))
      await until(async () => runsFor(seen, MAIN_SESSION).length > 0, "the run to Main", RUN_START)

      assert.deepEqual(uploads, ["IMG_0001.heic"], "the host was handed the photo itself")
      assert.equal(triaged(seen).length, 1, "the confirmed route was the one the send asked")
      const content = runsFor(seen, MAIN_SESSION)[0].body.input.at(-1).content
      const parts = Array.isArray(content) ? content : [{ type: "text", text: content }]
      assert.deepEqual(
        parts.filter((part) => part.type !== "text"),
        [],
        "no image part for a model that can't read one",
      )
      const said = parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      assert.match(
        said,
        /<attachment name="IMG_0001\.heic" type="image\/heic" size="4" path="\/host\/IMG_0001\.heic" \/>/,
        "the message names the copy the agent opens",
      )
      assert.match(said, /is not included in this message/, "and says the bytes stayed on the host")
      assert.doesNotMatch(said, /\[screenshot\]/, "with no photo promised inline")
    },
  )
})

test("a move is read back from the host and leaves a marker, a stay leaves none", async () => {
  await seed("route-marks")
  host("route-marks", "stay")
  await refreshMoves(MAIN)
  assert.equal((await db.conversations.get(MAIN))?.moves, undefined)
  const move = {
    id: "m1",
    text: "more on Lisbon",
    thread: "t1",
    at: 10,
    undone: false,
    undoable: true,
    new: false,
  }
  const fetchWith = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    return url.pathname.endsWith("/moves") ? json({ moves: [move] }) : fetchWith(input, init)
  }) as typeof fetch
  await refreshMoves(MAIN)
  assert.deepEqual((await db.conversations.get(MAIN))?.moves, [
    {
      id: "m1",
      text: "more on Lisbon",
      threadId: "t1",
      at: 10,
      undone: false,
      undoable: true,
      new: false,
    },
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

test("the ask carries the message's own send time, and the held row keeps it", async () => {
  await seed("route-skew")
  const seen = host("route-skew", "stay")
  const move = recordedMove()
  await db.conversations.update(MAIN, { moves: [move] })
  await db.messages.add({
    id: "r0",
    conversationId: MAIN,
    role: "assistant",
    content: "before the move",
    status: "done",
    createdAt: move.at - 60_000,
  })
  const fetchWith = globalThis.fetch
  let answer: (() => void) | undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/triage")) await new Promise<void>((done) => (answer = done))
    return fetchWith(input, init)
  }) as typeof fetch
  const sending = sendFromMain(MAIN, "and this stays")
  const held = async () => (await messagesOf(MAIN)).find((m) => m.status === "triaging")
  await until(async () => Boolean((await held()) && answer), "the held row and its ask")
  const heldAt = (await held())!.createdAt
  assert.ok(heldAt > move.at, "the held row sorts after the move it follows")
  answer!()
  assert.equal(await sending, undefined)
  assert.equal(
    triaged(seen).at(-1)?.body.at,
    heldAt,
    "and the ask said when it was sent, so the marker stands there (ADR 0089)",
  )
  const rows = (await messagesOf(MAIN)).sort((a, b) => a.createdAt - b.createdAt)
  const sent = rows.find((m) => m.content === "and this stays")
  // The refused run takes its empty reply with it, so the message is the last row drawn.
  assert.equal(rows.at(-1)?.id, sent?.id, "nothing follows the message for a marker to sit under")
  const marks = moveMarks(rows, [move], new Set<string>())
  assert.deepEqual(
    marks.before.get(sent?.id ?? "")?.map((m) => m.id),
    ["m1"],
  )
  assert.deepEqual(marks.trailing, [])
})

test("a plain Main send keeps its own time, and stands after an older move", async () => {
  await seed("route-skew-plain")
  host("route-skew-plain", "stay")
  const move = recordedMove()
  await db.conversations.update(MAIN, { moves: [move] })
  await sendMessage(MAIN, "typed later")
  const sent = (await messagesOf(MAIN)).find((m) => m.content === "typed later")
  assert.ok(sent && sent.createdAt > move.at, "the message sorts after the move")
})

test("a message waiting in the queue keeps its own time, so the marker stays put", async () => {
  await seed("route-skew-queued")
  host("route-skew-queued", "stay", ["triage", "moves"])
  const move = recordedMove()
  await db.conversations.update(MAIN, { moves: [move] })
  await queueMessage(MAIN, "typed while it runs")
  const rows = await messagesOf(MAIN)
  const waiting = rows.find((m) => m.content === "typed while it runs")
  assert.equal(waiting?.status, "queued")
  assert.ok(waiting.createdAt > move.at, "the waiting row sorts after the move")
  const marks = moveMarks(rows, [move], new Set<string>())
  assert.deepEqual(marks.trailing, [], "so the marker is not left at the end of the chat")
})

/** A second chat, so a sync that leaves two replies streaming leaves them here, not in Main. */
const ADOPTED = "main-adopt"

test("two turns the host started in one pass take a time each, after the move", async () => {
  await seed("route-skew-adopt")
  host("route-skew-adopt", "stay")
  const move = recordedMove()
  await db.conversations.put({
    id: ADOPTED,
    profileId: (await db.profiles.toArray())[0].id,
    title: "Adopted",
    hermesSessionId: `gots-${ADOPTED}`,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 0,
    moves: [move],
  })
  const fetchWith = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/queue"))
      return json({
        items: [],
        sent: [
          { id: "s1", text: "first", created_at: 1, run_id: "r1", run_status: "running" },
          { id: "s2", text: "second", created_at: 2, run_id: "r2", run_status: "running" },
        ],
        paused: false,
      })
    // A reply followed by its run's own status, which says it is over: a run left running would be
    // followed for the rest of the file.
    if (/\/runs\/[^/]+\/events$/.test(url.pathname))
      return new Response("", { headers: { "content-type": "text/event-stream" } })
    if (/\/v1\/runs\/[^/]+$/.test(url.pathname))
      return json({ status: "completed", created_at: 1, output: "", usage: {} })
    return fetchWith(input, init)
  }) as typeof fetch
  await refreshQueue(ADOPTED)
  const rows = (await messagesOf(ADOPTED)).sort((a, b) => a.createdAt - b.createdAt)
  const users = rows.filter((m) => m.role === "user")
  assert.deepEqual(
    users.map((m) => m.content),
    ["first", "second"],
  )
  assert.ok(users[0].createdAt > move.at, "the first lands after the move")
  assert.ok(users[1].createdAt > users[0].createdAt, "and the second after it, not on its time")
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
  await until(async () => runsFor(seen, MAIN_SESSION).length === 1, "Main's reply to run", RUN_START)
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
  await until(async () => runsFor(seen, MAIN_SESSION).length === 1, "Main's reply to run", RUN_START)
  assert.equal(await sendFromMain(MAIN, "and this"), undefined)
  assert.equal(triaged(seen).filter((r) => r.body.text === "and this").length, 1)
  // The row is written beside the ask, not before it answers: a send that returns before the row
  // lands is the shape of every queued send, so the row is waited for rather than sampled once — a
  // loaded runner drew this empty and failed a claim the app keeps.
  await until(
    async () => (await messagesOf(MAIN)).some((m) => m.content === "and this"),
    "the queued row in Main",
  )
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
