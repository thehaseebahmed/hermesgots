import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { db, ensureMainThread, mainThreadId, type Message } from "@/lib/db"
import type { Move } from "@/lib/hermes"
import { syncChatsOf } from "@/lib/sync"
import {
  botProfile,
  chatScreen,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  text,
  until,
} from "./component-kit.tsx"

const bot = botProfile("card-undo", { id: "bot-1", name: "Cards" })
const MAIN = mainThreadId(bot.id)
const MAIN_SESSION = `memento-${MAIN}`
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
      return json({ object: "memento.move.undone", undone: true })
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
    if (url.pathname.endsWith("/plugins/memento/info"))
      return json({ features: ["moves", "queue"] })
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/memento/chats")) {
      const posted = init?.body ? (JSON.parse(String(init.body)).chats ?? {}) : {}
      const chats: Record<string, unknown> = { ...posted }
      for (const id of discarded) chats[id] = { at: Date.now() + 1, deleted: true }
      return json({ object: "memento.chats", chats })
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
  await seedSettings({ developer: true, botThreads: true })
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
      hermesSessionId: "memento-t-old",
      createdAt: 2,
      updatedAt: 5,
      changedAt: 0,
    },
    {
      id: "n1",
      profileId: bot.id,
      title: "New thread",
      hermesSessionId: "memento-n1",
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

const cards = () => findAll('[data-slot="thread-card"]')
const card = (title: string) => cards().find((one) => one.textContent?.includes(title)) ?? null
const marker = () => findAll("p").find((one) => one.textContent?.startsWith("Moved to")) ?? null
const settles = (title: string) => until(async () => card(title) !== null, `the ${title} card`)
const undoIn = (element: Element | null) =>
  [...(element?.querySelectorAll("button") ?? [])].find(
    (button) => button.getAttribute("aria-label") === "Undo",
  ) ?? null

test("a triage-opened thread's card carries Undo, and no marker is drawn beside it", async () => {
  await seed([opened])
  host([opened])
  await mount(chatScreen(MAIN), async () => {
    await settles("New thread")
    const drawn = card("New thread")
    assert.ok(drawn, "the thread triage opened is a card in Main's flow")
    assert.ok(drawn.textContent?.includes(MOVED), "its opener shows the message that left Main")
    assert.ok(undoIn(drawn), "the card offers Undo")
    assert.doesNotMatch(text(), /Moved to/, "nothing is drawn twice")
  })
})

test("the card's opener is the moved message where this device holds no copy of it", async () => {
  await seed([opened], { copy: false })
  host([opened])
  await mount(chatScreen(MAIN), async () => {
    await settles("New thread")
    const drawn = card("New thread")
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
    await settles("New thread")
    const drawn = card("New thread")
    assert.ok(drawn, "the card is still there")
    assert.equal(undoIn(drawn), null, "a thread that replied can't be taken back")
    assert.doesNotMatch(text(), /Moved to/)
  })
})

test("a message moved into an older thread keeps its marker, and that thread's card its place", async () => {
  await seed([joined])
  host([joined])
  await mount(chatScreen(MAIN), async () => {
    await settles("Older thread")
    assert.match(text(), /Moved to .*Older thread/, "the marker names the thread it joined")
    assert.equal(find('a[href="/c/t-old"]') !== null, true, "and links to it")
    assert.ok(undoIn(marker()), "the marker keeps its Undo")
    const drawn = card("Older thread")
    assert.ok(drawn, "the older thread's own card is where it always was")
    assert.ok(drawn.textContent?.includes("An older plan"), "it keeps the opener it always had")
    assert.ok(
      !drawn.textContent?.includes(joined.text),
      "not the message triage moved into it: only a thread triage opened is its message's card",
    )
    assert.equal(undoIn(drawn), null, "the card carries no Undo: the move is marked, not carded")
  })
})

test("undoing from the card asks the host, and the card stops offering it", async () => {
  await seed([opened])
  host([opened])
  await mount(chatScreen(MAIN), async () => {
    await settles("New thread")
    await click(undoIn(card("New thread")))
    assert.deepEqual(undos, [`${MAIN_SESSION}/moves/move-new/undo`])
    await settle()
    assert.equal(undoIn(card("New thread")), null, "the undone move leaves no Undo behind")
  })
})

const inMain = (said: string) =>
  findAll('[data-slot="message-scroller-item"]').some((item) => item.textContent?.includes(said))

test("undoing returns the message to Main and takes away the thread that existed only for it", async () => {
  await seed([opened], { copy: false })
  host([opened])
  await mount(chatScreen(MAIN), async () => {
    await settles("New thread")
    assert.ok(card("New thread"), "the message left as a card, not a message")
    assert.equal(inMain(MOVED), false)
    await click(undoIn(card("New thread")))
    await until(async () => inMain(MOVED), "the message back in Main")
    await act(async () => void (await syncChatsOf([bot.id])))
    await settle()
    assert.equal(await db.conversations.get("n1"), undefined, "the thread is gone from this device")
    assert.equal(card("New thread"), null, "and so is its card")
    assert.equal(marker(), null, "with no marker left in its place")
  })
})

test("Undo on the card refuses once the thread has replied, and the card keeps no button", async () => {
  await seed([opened])
  host([opened], { refuse: true })
  await mount(chatScreen(MAIN), async () => {
    await settles("New thread")
    await click(undoIn(card("New thread")))
    assert.deepEqual(undos, [`${MAIN_SESSION}/moves/move-new/undo`])
    await settle()
    assert.equal(undoIn(card("New thread")), null, "a refused undo still drops the button")
  })
})

const PICK = { provider: "anthropic", model: "claude-sonnet-4.5" }

/** The host's answer to the merge, with one chat's record newer and naming no model at all. */
function answerWithoutPick(id: string) {
  const answer = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/plugins/memento/chats") && init?.body) {
      const posted = JSON.parse(String(init.body)).chats ?? {}
      const record = posted[id]
      if (record)
        return json({
          object: "memento.chats",
          chats: {
            ...posted,
            [id]: { at: record.at + 1, value: { ...record.value, modelChoice: undefined } },
          },
        })
    }
    return answer(input, init)
  }) as typeof fetch
}

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
