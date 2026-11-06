/**
 * The queue Hermes itself holds for a chat, drawn where the composer would be: what waits is named,
 * and one button discards the turn a restart lost so the messages behind it run. Over a seeded
 * device with the HTTP boundary faked, the way every chat-screen test stands.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { THREAD_MISSING } from "@/components/chat/empty-states"
import { SUGGESTIONS } from "@/lib/suggestions"
import { db, type Message } from "@/lib/db"

import { botProfile, chatScreen, click, find, json, mount, seedChat, until } from "./component-kit.tsx"

const bot = botProfile("pending")

const turn: Message[] = [
  {
    id: "ask-1",
    conversationId: "",
    role: "user",
    content: "the question that was answered",
    status: "done",
    createdAt: 1_000,
  },
  {
    id: "reply-1",
    conversationId: "",
    role: "assistant",
    content: "And its answer.",
    status: "done",
    createdAt: 1_010,
  },
]

/** The turn a restart lost, and the message queued behind it: the state the TUI lists as `queued (2)`. */
const held = {
  items: [
    { id: "a", text: "a turn the server lost" },
    { id: "b", text: "the older message behind it" },
  ],
  lost: "a",
  running: false,
}

type Seen = { path: string; method: string }

/** One host: what it advertises, the queue it holds, and every request it was sent. */
function host(queue: unknown, { features = ["pending"] } = {}) {
  const seen: Seen[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const method = init?.method ?? "GET"
    seen.push({ path: url.pathname, method })
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/gots/info")) return json({ features })
    if (/\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: [] })
    if (/\/sessions\/[^/]+\/pending$/.test(url.pathname))
      return json({ object: "gots.pending", ...(queue as object) })
    if (/\/sessions\/[^/]+\/pending\/[^/]+\/discard$/.test(url.pathname) && method === "POST")
      return json({ object: "gots.pending.discarded", items: [], lost: null, running: false })
    return json({ error: { message: "no route" } }, 404)
  }) as typeof fetch
  return seen
}

const asks = (seen: Seen[]) => seen.filter((one) => /\/pending(\/|$)/.test(one.path))
const card = () => find("[data-discard-lost]")
const composer = () => find("textarea")

test("a chat whose queue a lost turn holds names what waits instead of the composer", async () => {
  host(held)
  await seedChat({ id: "chat-stuck", messages: turn, profile: bot })
  await mount(chatScreen("chat-stuck"), async () => {
    await until(() => Boolean(card()), "the paused-queue card")
    const words = document.body.textContent ?? ""
    assert.match(words, /This session's queue is paused/)
    assert.match(words, /a turn the server lost/)
    assert.match(words, /Lost when the server restarted/)
    assert.match(words, /the older message behind it/)
    assert.match(words, /Waiting/)
    assert.match(words, /Discard lost turn/)
    assert.equal(composer(), null, "nothing can be typed behind the lost turn")
  })
})

test("a queue still moving draws no card, and the composer stays", async () => {
  host({ items: [{ id: "b", text: "waiting its turn" }], lost: null, running: false })
  await seedChat({ id: "chat-moving", messages: turn, profile: bot })
  await mount(chatScreen("chat-moving"), async () => {
    await until(() => Boolean(composer()), "the composer")
    assert.equal(card(), null)
  })
})

test("a host without the route draws no card at all", async () => {
  // Its own bot: what a host answered about its features is remembered per connection, so a second
  // question for the same one would be the first host's answer.
  const seen = host(held, { features: [] })
  await seedChat({ id: "chat-old", messages: turn, profile: botProfile("pending-old") })
  await mount(chatScreen("chat-old"), async () => {
    await until(() => Boolean(composer()), "the composer")
    assert.equal(card(), null)
  })
  assert.equal(asks(seen).length, 0, "an older plugin is not asked")
})

test("Discard acknowledges the lost turn on its own route, and the composer comes back", async () => {
  const seen = host(held)
  await seedChat({ id: "chat-discard", messages: turn, profile: bot })
  await mount(chatScreen("chat-discard"), async () => {
    await until(() => Boolean(card()), "the paused-queue card")
    await click(card())
    await until(() => !card(), "the card gone")
    await until(() => Boolean(composer()), "the composer back")
    const posted = seen.filter((one) => one.method === "POST" && one.path.endsWith("/discard"))
    assert.deepEqual(
      posted.map((one) => one.path),
      ["/api/plugins/gots/sessions/chat-discard-hermes/pending/a/discard"],
      "the row the card named, on the chat's own session",
    )
  })
})

test("a fenced chat whose thread holds nothing waits, rather than claiming the thread didn't load", async () => {
  // The turn a restart lost never wrote its row, so the session's transcript is empty: a chat with a
  // past and no rows, which every other screen reads as a read that failed. The card says what it
  // is, so neither the pane nor a new session's face is drawn — and clearing the fence is what makes
  // the read worth making again, so the thread is read once more rather than left spinning.
  const seen = host(held)
  await seedChat({ id: "chat-empty", messages: [], profile: bot })
  // `updatedAt` past `createdAt` is the app's record that something was sent in this chat: what makes
  // an empty thread here a read it has to make, and a failed one the pane usually names.
  await db.conversations.update("chat-empty", { updatedAt: 2 })
  const reads = () => seen.filter((one) => one.method === "GET" && /\/messages$/.test(one.path))
  await mount(chatScreen("chat-empty"), async () => {
    await until(() => Boolean(card()), "the paused-queue card")
    const words = document.body.textContent ?? ""
    assert.ok(!words.includes(THREAD_MISSING), "no failed read is claimed")
    // Nor a new session's face, whose openers invite a first message: this chat has a past.
    assert.ok(!words.includes(SUGGESTIONS[0]), "and nothing invites a first message")
    // `assert.ok` on the element, never `equal(x, null)`: a failing element assertion serializes the
    // whole node and can take the runner's heap with it.
    assert.ok(!find('[data-slot="spinner"]'), "nor a read still running, which never lands")
    const before = reads().length
    await click(card())
    await until(() => !card(), "the card gone")
    await until(() => reads().length > before, "the thread read again once the fence lifted")
    assert.ok(
      !(document.body.textContent ?? "").includes(THREAD_MISSING),
      "and clearing the queue does not turn it into one",
    )
  })
})
