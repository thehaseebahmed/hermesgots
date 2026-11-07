import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { db, ensureMainThread, mainThreadId, type Message } from "@/lib/db"
import type { Move } from "@/lib/hermes"
import { syncChatsOf } from "@/lib/sync"
import {
  botProfile,
  chatScreen,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  text,
  threadCard,
  until,
} from "./component-kit.tsx"

const bot = botProfile("card-undo", { id: "bot-1", name: "Cards", apiKey: undefined })
const MAIN = mainThreadId(bot.id)
const MOVED = "Plan my move"
const undos: string[] = []

interface Queued {
  id: string
  text: string
  attachments: { name: string; type?: string; size?: number; path?: string }[]
  created_at: number
}

function host(moves: Move[], { refuse = false } = {}) {
  undos.length = 0
  let undone = false
  let replied = false
  const queued: Queued[] = []
  const discarded = new Set<string>()
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith("card-undo")) return json({})
    if (init?.method === "POST" && url.pathname.endsWith("/undo")) {
      undos.push(url.pathname.split("/sessions/")[1])
      if (refuse) {
        replied = true
        return json({ error: { message: "The thread has already replied." } }, 409)
      }
      undone = true
      const move = moves.find((one) => url.pathname.includes(`/moves/${one.id}/undo`))
      if (move) {
        queued.push({
          id: `q-${move.id}`,
          text: move.text,
          attachments: [],
          created_at: Date.now(),
        })
        if (move.new) discarded.add(move.threadId)
      }
      return json({ object: "gots.move.undone", undone: true })
    }
    if (url.pathname.endsWith("/moves"))
      return json({
        moves: moves.map(({ threadId, ...move }) => ({
          ...move,
          thread: threadId,
          undone: undone || move.undone,
          undoable: undone || replied ? false : move.undoable,
        })),
      })
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ features: ["moves", "queue"] })
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/gots/chats")) {
      const posted = init?.body ? (JSON.parse(String(init.body)).chats ?? {}) : {}
      const chats: Record<string, unknown> = { ...posted }
      for (const id of discarded) chats[id] = { at: Date.now() + 1, deleted: true }
      return json({ object: "gots.chats", chats })
    }
    if (url.pathname.endsWith("/queue")) return json({ items: queued, sent: [] })
    return json({})
  }) as typeof fetch
}

const msg = (
  id: string,
  conversationId: string,
  role: Message["role"],
  content: string,
  createdAt: number,
): Message => ({ id, conversationId, role, content, status: "done", createdAt })

async function seed(moves: Move[], { copy = true } = {}) {
  await seedSettings({ developer: true })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await ensureMainThread(bot.id)
  await db.messages.bulkPut([msg("m10", MAIN, "user", "An earlier question", 10)])
  await db.conversations.bulkPut([
    {
      id: "t-old",
      profileId: bot.id,
      title: "Older thread",
      hermesSessionId: "gots-t-old",
      createdAt: 2,
      updatedAt: 5,
      changedAt: 0,
    },
    {
      id: "n1",
      profileId: bot.id,
      title: "New thread",
      hermesSessionId: "gots-n1",
      createdAt: 20,
      updatedAt: 20,
      changedAt: 0,
    },
  ])
  await db.messages.bulkPut([
    msg("o1", "t-old", "user", "An older plan", 2),
    ...(copy ? [msg("n1-1", "n1", "user", MOVED, 20)] : []),
  ])
  await db.conversations.update(MAIN, { moves })
}

const opened: Move = {
  id: "move-new",
  text: MOVED,
  threadId: "n1",
  at: 20,
  undone: false,
  undoable: true,
  new: true,
}

const joined: Move = {
  id: "move-old",
  text: "And one more thing",
  threadId: "t-old",
  at: 30,
  undone: false,
  undoable: true,
  new: false,
}

const card = (threadId: string) => threadCard(threadId) ?? null
const marker = () => findAll("p").find((one) => one.textContent?.startsWith("Moved to")) ?? null
/** The line's one link, which covers the line so a press anywhere on the sentence goes to the thread. */
const lineLink = () => marker()?.querySelector("a") ?? null
const settles = (threadId: string) => until(async () => card(threadId) !== null, `the ${threadId} card`)
const undoIn = (element: Element | null) =>
  [...(element?.querySelectorAll("button") ?? [])].find(
    (button) => button.getAttribute("aria-label") === "Undo",
  ) ?? null

test("a triage-opened thread's card reads like any other, with Undo beside it", async () => {
  await seed([opened])
  host([opened])
  await mount(chatScreen(MAIN), async () => {
    await settles("n1")
    const drawn = card("n1")
    assert.ok(drawn, "the thread triage opened is a card in Main's flow")
    assert.ok(drawn.textContent?.includes(MOVED), "its opener shows the message that left Main")
    assert.match(drawn.textContent ?? "", /View thread/, "its way in reads as a /thread card's does")
    assert.doesNotMatch(drawn.textContent ?? "", /Moved to/, "and it does not say where the message went")
    assert.equal(findAll("p").filter((one) => one.textContent?.startsWith("Moved to")).length, 0)
    const undo = undoIn(drawn)
    assert.ok(undo, "the card offers Undo")
    const body = drawn.querySelector('[data-slot="thread-card-body"]')
    assert.ok(body && !body.contains(undo), "and it stands outside the card, at the end of its row")
  })
})

test("the card's opener is the moved message where this device holds no copy of it", async () => {
  await seed([opened], { copy: false })
  host([opened])
  await mount(chatScreen(MAIN), async () => {
    await settles("n1")
    const drawn = card("n1")
    assert.ok(drawn, "the thread triage opened is a card in Main's flow")
    assert.ok(
      drawn.textContent?.includes(MOVED),
      "its opener is the message that left Main, not the title the host gave the thread",
    )
  })
})

test("the card stops offering Undo once its thread has replied", async () => {
  const replied: Move = { ...opened, undoable: false }
  await seed([replied])
  host([replied])
  await mount(chatScreen(MAIN), async () => {
    await settles("n1")
    const drawn = card("n1")
    assert.ok(drawn, "the card is still there")
    assert.equal(undoIn(drawn), null, "a thread that replied can't be taken back")
    assert.match(
      drawn.textContent ?? "",
      /View thread/,
      "it still says how to get in, without the way to take it back",
    )
  })
})

test("a message moved into an older thread keeps its marker, and that thread's card its place", async () => {
  await seed([joined])
  host([joined])
  await mount(chatScreen(MAIN), async () => {
    await settles("t-old")
    assert.match(text(), /Moved to .*Older thread/, "the marker names the thread it joined")
    assert.equal(find('a[href="/c/t-old"]') !== null, true, "and links to it")
    assert.ok(undoIn(marker()), "the marker keeps its Undo")
    const drawn = card("t-old")
    assert.ok(drawn, "the older thread's own card is where it always was")
    assert.ok(drawn.textContent?.includes("An older plan"), "it keeps the opener it always had")
    assert.ok(
      !drawn.textContent?.includes(joined.text),
      "not the message triage moved into it: only a thread triage opened is its message's card",
    )
    assert.equal(undoIn(drawn), null, "the card carries no Undo: the move is marked, not carded")
  })
})

const PICK = { provider: "anthropic", model: "claude-sonnet-4.5" }

/** The host's answer to the merge, with one chat's record newer and naming no model at all. */
function answerWithoutPick(id: string) {
  const answer = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/plugins/gots/chats") && init?.body) {
      const posted = JSON.parse(String(init.body)).chats ?? {}
      const record = posted[id]
      if (record)
        return json({
          object: "gots.chats",
          chats: {
            ...posted,
            [id]: { at: record.at + 1, value: { ...record.value, modelChoice: undefined } },
          },
        })
    }
    return answer(input, init)
  }) as typeof fetch
}

/** The host's answer to the merge, with one chat's record newer and naming `choice`. */
test("a chat the host answers without a pick keeps the pin this device holds", async () => {
  // A record that carries no model has nothing to say about one: only a user's own change writes
  // the chat's pick, and a marker when they pick the Default row, so erasing it here would lose the
  // pin for good — and push the erasure back to the plugin with it.
  await seed([opened])
  host([opened])
  await db.conversations.update("t-old", { modelChoice: PICK })
  answerWithoutPick("t-old")
  await act(async () => void (await syncChatsOf([bot.id])))
  assert.deepEqual(
    (await db.conversations.get("t-old"))?.modelChoice,
    PICK,
    "the pin survived the merge",
  )
})

test("the whole Moved line goes to the thread, and Undo still answers for itself", async () => {
  // A reader aims at the sentence, not at its last word: the line's link covers the line, and the
  // one control that must not follow it (Undo) stands above that cover.
  await seed([joined])
  host([joined])
  await mount(chatScreen(MAIN), async () => {
    await settles("t-old")
    const line = marker()
    const link = lineLink()
    assert.ok(line && link, "the line and its link")
    assert.match(line.className, /relative/, "the line is the box the link covers")
    assert.match(link.className, /after:absolute after:inset-0/, "the link fills it")
    const undo = undoIn(line)
    assert.ok(undo, "Undo is on the line")
    assert.match(undo.className, /relative z-10/, "and above the cover, so a press on it undoes")
  })
})
