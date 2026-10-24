/**
 * A message sent while a reply runs, by what it carries: one whose attachments are all files steers,
 * so the running agent reads the log or document at once, and one carrying a photo waits in the
 * queue instead. What a steer the agent never read comes back to the queue as the message it was,
 * and a row waiting there with its files still sends first or goes.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { toast } from "sonner"

import { attachmentsText } from "@/lib/attachment-text"
import { removeQueued, requeueSteer, sendFromMain, sendQueued, stopMessage } from "@/lib/chat"
import { db, mainThreadId, type Attachment } from "@/lib/db"
import { botProfile, json, seedSettings, until } from "./component-kit.tsx"

const MAIN = mainThreadId("bot-1")
const MAIN_SESSION = `memento-${MAIN}`

type Seen = { path: string; method?: string; body: any }

/** Hosts whose runs never answer, so a reply started on them stays running. */
const hangingRuns = new Set<string>()
const hung = new Set<() => void>()

function endRuns() {
  for (const end of hung) end()
  hung.clear()
}

/** One host with the plugin's queue: what it was asked, and the item it says it queued. */
function host(name: string, { features = ["queue"], upload = true } = {}) {
  const seen: Seen[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    seen.push({ path: url.pathname, method: init?.method, body })
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/memento/info")) return json({ features })
    if (url.pathname.endsWith("/attachments") && init?.method === "POST") {
      const file = url.searchParams.get("name")
      if (!upload) return json({ error: { message: "The host is full." } }, 507)
      return json({ name: file, path: `/host/${file}`, size: 3 })
    }
    if (url.pathname.endsWith("/queue") && init?.method === "POST")
      return json({
        item: {
          id: "q_1",
          text: body?.text,
          attachments: body?.attachments,
          created_at: 3,
        },
      })
    if (url.pathname.endsWith("/queue/q_1/steer")) return json({ run_id: "r2", text: body })
    if (url.pathname.endsWith("/queue/q_1") && init?.method === "GET")
      return json({ items: [], sent: [], paused: false })
    // Hermes's own steer route, which a message the device holds goes through.
    if (/\/runs\/[^/]+\/steer$/.test(url.pathname)) return json({ ok: true })
    if (url.pathname.endsWith("/v1/runs") && init?.method === "POST")
      return json({ run_id: "r1", status: "running" })
    // A reply that goes on running: its events stream stays open until the turn is stopped.
    if (/\/runs\/r1\/events$/.test(url.pathname) && hangingRuns.has(name))
      return new Promise<Response>((_, reject) => {
        const keep = setInterval(() => {}, 100)
        hung.add(() => {
          clearInterval(keep)
          reject(new DOMException("stopped", "AbortError"))
        })
      })
    return json({})
  }) as typeof fetch
  return seen
}

async function seed(name: string) {
  const bot = botProfile(name)
  await seedSettings({})
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put({
    id: MAIN,
    profileId: bot.id,
    title: "Main",
    hermesSessionId: MAIN_SESSION,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 0,
    main: true,
  })
}

const messagesOf = (id: string) => db.messages.where("conversationId").equals(id).toArray()
const steerAsks = (seen: Seen[]) => seen.filter((r) => r.path.endsWith("/queue/q_1/steer"))
/** The turn the app queued on the host, as the plugin would start it. */
const queuedTurn = (seen: Seen[]) => seen.find((r) => r.path.endsWith("/queue"))?.body?.body
/** What a run body says to the model: its text parts, one after another, as the model reads them. */
const textOf = (input: any) =>
  ((input ?? []) as { content?: unknown }[])
    .flatMap((item) =>
      typeof item.content === "string"
        ? [item.content]
        : ((item.content ?? []) as { type?: string; text?: string }[])
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? ""),
    )
    .join("\n")

const note = (patch: Partial<Attachment> = {}): Attachment => ({
  id: "f1",
  name: "notes.txt",
  type: "text/plain",
  size: 2048,
  image: false,
  blob: new Blob(["hello"]),
  ...patch,
})

const photo = (): Attachment => ({
  id: "f2",
  name: "cat.png",
  type: "image/png",
  size: 64,
  image: true,
  blob: new Blob(["png"]),
})

/** Starts Main's reply and leaves it running, so the next message arrives mid-reply. */
async function startReply(name: string, seen: Seen[]) {
  hangingRuns.add(name)
  void sendFromMain(MAIN, "first")
  // The turn has its run once its events stream is opened, which is what a steer reaches.
  await until(async () => seen.some((r) => /\/runs\/r1\/events$/.test(r.path)), "Main's reply to run")
}

async function finishReply() {
  stopMessage(MAIN)
  endRuns()
  await until(
    async () => !(await messagesOf(MAIN)).some((m) => m.status === "streaming"),
    "Main's reply to stop",
  )
}

test("a mid-reply message carrying a file steers, and the steer names the file", async () => {
  await seed("steer-file")
  const seen = host("steer-file")
  try {
    await startReply("steer-file", seen)
    await sendFromMain(MAIN, "read this", [note()], { steer: true })
    assert.equal(steerAsks(seen).length, 1, "the waiting item is handed to the reply that runs")
    const said = textOf(queuedTurn(seen)?.input)
    assert.match(said, /name="notes.txt"/)
    assert.match(said, /path="\/host\/notes.txt"/, "the marker names where the host saved it")
    assert.match(said, /not included in this message/i, "and the sentence that says so")
    const held = (await messagesOf(MAIN)).filter((m) => m.content === "read this")
    assert.deepEqual(held, [], "it is in the reply now, not waiting behind it")
  } finally {
    await finishReply()
  }
})

test("a mid-reply message carrying a photo waits in the queue instead of steering", async () => {
  await seed("steer-photo")
  const seen = host("steer-photo")
  try {
    await startReply("steer-photo", seen)
    await sendFromMain(MAIN, "look at this", [photo()], { steer: true })
    assert.deepEqual(steerAsks(seen), [], "a steer can't carry what the model reads itself")
    const held = (await messagesOf(MAIN)).filter((m) => m.content === "look at this")
    assert.equal(held.length, 1)
    assert.equal(held[0].status, "queued")
    assert.deepEqual(
      held[0].attachments?.map((a) => a.name),
      ["cat.png"],
      "it waits with the photo it carries",
    )
  } finally {
    await finishReply()
  }
})

test("a steer on a host without the queue saves the file before its marker names the path", async () => {
  // The plugin's queue is what uploads for a host that has it; without one, the device composes
  // the markers, and a marker naming no path names no file the model can read.
  await seed("steer-no-queue")
  const seen = host("steer-no-queue", { features: [] })
  try {
    await startReply("steer-no-queue", seen)
    await sendFromMain(MAIN, "read this", [note()], { steer: true })
    assert.ok(
      seen.some((r) => r.path.endsWith("/attachments") && r.method === "POST"),
      "the file is saved on the host first",
    )
    const steer = seen.find((r) => /\/runs\/[^/]+\/steer$/.test(r.path))
    assert.ok(steer, "the message reaches the running reply as a steer")
    const said = String(steer.body?.input ?? "")
    assert.match(said, /name="notes.txt"/)
    assert.match(said, /path="\/host\/notes.txt"/, "and the path the model opens")
    const held = (await messagesOf(MAIN)).filter((m) => m.content === "read this")
    assert.deepEqual(held, [], "it is in the reply now, not waiting behind it")
  } finally {
    await finishReply()
  }
})

test("a steer whose file the host won't take stays in the queue, with the reason", async () => {
  await seed("steer-unuploaded")
  const seen = host("steer-unuploaded", { features: [], upload: false })
  const said: string[] = []
  const original = toast.error
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    await startReply("steer-unuploaded", seen)
    await sendFromMain(MAIN, "read this", [note()], { steer: true })
    assert.deepEqual(
      seen.filter((r) => /\/runs\/[^/]+\/steer$/.test(r.path)),
      [],
      "a marker with no path behind it is never steered",
    )
    assert.deepEqual(said, [
      "Couldn't attach notes.txt: The host is full. Couldn't steer this reply, so it's queued.",
    ])
    const held = (await messagesOf(MAIN)).filter((m) => m.content === "read this")
    assert.equal(held.length, 1, "nothing the user said is lost")
    assert.equal(held[0].status, "queued")
    assert.deepEqual(
      held[0].attachments?.map((a) => a.name),
      ["notes.txt"],
      "and it waits with its file",
    )
  } finally {
    toast.error = original
    await finishReply()
  }
})

test("a steer the agent never read comes back to the queue with its file", async () => {
  await seed("steer-unread")
  host("steer-unread")
  await db.messages.add({
    id: "later",
    conversationId: MAIN,
    role: "user",
    content: "and then",
    status: "queued",
    createdAt: 10,
  })
  // What Hermes hands back as `pending_steer`: the text the model was given, markers and all.
  await requeueSteer(MAIN, attachmentsText("read this", [note({ path: "/host/notes.txt" })]))
  const rows = await messagesOf(MAIN)
  const back = rows.find((m) => m.content === "read this")
  assert.ok(back, "the message reads as what the user typed, not as its markers")
  assert.equal(back.status, "queued")
  assert.equal(back.attachments?.[0].name, "notes.txt")
  assert.equal(back.attachments?.[0].path, "/host/notes.txt")
  assert.ok(
    back.createdAt < (rows.find((m) => m.id === "later")?.createdAt ?? 0),
    "it goes first, ahead of what already waited",
  )
})

test("a queued message with a file still sends first, markers and all", async () => {
  await seed("queue-send")
  const seen = host("queue-send")
  await db.messages.add({
    id: "held",
    conversationId: MAIN,
    role: "user",
    content: "read this",
    attachments: [note({ blob: undefined })],
    status: "queued",
    createdAt: 5,
  })
  try {
    hangingRuns.add("queue-send")
    void sendQueued((await messagesOf(MAIN))[0])
    await until(
      async () => seen.some((r) => r.path.endsWith("/v1/runs")),
      "the queued message to go",
    )
    const run = seen.find((r) => r.path.endsWith("/v1/runs") && r.method === "POST")
    assert.match(textOf(run?.body.input), /name="notes.txt"/)
  } finally {
    await finishReply()
  }
})

test("a queued message with a file goes when the plugin is asked", async () => {
  await seed("queue-now")
  const seen = host("queue-now")
  await db.messages.add({
    id: "q_9",
    conversationId: MAIN,
    role: "user",
    content: "read this",
    attachments: [note({ path: "/host/notes.txt" })],
    status: "queued",
    hostQueued: true,
    createdAt: 5,
  })
  await sendQueued((await messagesOf(MAIN))[0])
  assert.ok(seen.some((r) => r.path.endsWith("/queue/q_9/send")))
})

test("a queued message with a file is taken back when it's removed", async () => {
  await seed("queue-remove")
  const seen = host("queue-remove")
  await db.messages.add({
    id: "q_9",
    conversationId: MAIN,
    role: "user",
    content: "read this",
    attachments: [note({ path: "/host/notes.txt" })],
    status: "queued",
    hostQueued: true,
    createdAt: 5,
  })
  await removeQueued((await messagesOf(MAIN))[0])
  assert.ok(seen.some((r) => r.path.endsWith("/queue/q_9/remove")))
  assert.deepEqual(await messagesOf(MAIN), [])
})
