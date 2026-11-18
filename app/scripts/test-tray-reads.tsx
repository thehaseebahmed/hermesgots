/**
 * Mark as read, pressed in the Android tray, as the app's own unread dot answers it: the bot's chat
 * list row and the sidebar's bot row both lose their dot once the press is taken, even where the
 * reply it covered synced after the press with clocks newer than it, and a reply the host wrote after
 * the notice keeps its dot.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { db, type Message } from "@/lib/db"
import { forgetRead, markRead, releaseHeld } from "@/lib/read-marks"
import { followHeldReads, takeTrayReads } from "@/lib/tray-marks"
import { BotChatsPage } from "@/routes/bot-chats"
import { botProfile, find, json, mount, seedSettings, until } from "./component-kit.tsx"

const bot = botProfile("tray-reads", { id: "bot-1", name: "Tray" })
const CHAT = "trip"
/** The notice reported the turn that ended here, on the host's clock. */
const NOTICE = 1_000_000
/** And the reader pressed Mark as read a little after, on this device's. */
const PRESS = NOTICE + 5_000

function reply(at: number, hermesAt: number, words = "Booked."): Message {
  return {
    id: `${CHAT}-${at}`,
    conversationId: CHAT,
    role: "assistant",
    content: words,
    status: "done",
    createdAt: at,
    hermesAt,
  }
}

/** One bot with one chat it has spoken in, read on this device before its newest turn. */
async function seed(legacy: boolean) {
  // Marks and holds live in the page's memory as well as its storage: each case starts from neither.
  forgetRead(CHAT)
  releaseHeld(CHAT)
  await seedSettings({ developer: true, legacyChat: legacy, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.conversations.clear()
  await db.messages.clear()
  await db.conversations.put({
    id: CHAT,
    profileId: bot.id,
    title: "Trip",
    hermesSessionId: `gots-${CHAT}`,
    createdAt: 10,
    updatedAt: 500,
    changedAt: 10,
  })
  await db.messages.put(reply(500, 400, "Earlier."))
  markRead(CHAT, 100)
  globalThis.fetch = async () => json({})
}

/** What a sync landing later writes: the reply, floored forward on this device, and the record's clock. */
async function sync(hermesAt: number) {
  const at = PRESS + 10_000
  await db.messages.put(reply(at, hermesAt))
  await db.conversations.update(CHAT, { updatedAt: at + 500 })
}

const listRow = () => find(`ul a[href="/c/${CHAT}"]`)
const botRow = () => find(`a[href="/b/${bot.id}"]`)
const dotted = (row: Element | null) => Boolean(row?.querySelector("[data-unread]"))

const list = (
  <MemoryRouter initialEntries={[`/b/${bot.id}`]}>
    <Routes>
      <Route path="b/:profileId" element={<BotChatsPage />} />
      <Route path="c/:id" element={<p data-chat />} />
    </Routes>
  </MemoryRouter>
)
const sidebar = (
  <MemoryRouter initialEntries={["/"]}>
    <ConversationList />
  </MemoryRouter>
)

const press = (through: number) => takeTrayReads(async () => [{ chat: CHAT, at: PRESS, through }])

let stop: (() => void) | undefined
test.afterEach(() => {
  stop?.()
  stop = undefined
})

test("a mark pressed in the tray clears the list row's dot on the next launch", async () => {
  await seed(true)
  await mount(list, async () => {
    await until(async () => dotted(listRow()), "the chat to read as news first")
    await press(NOTICE)
    await until(async () => !dotted(listRow()), "the press to take the dot off")
  })
})

test("a mark pressed before the reply synced clears the list row's and the sidebar's dot once the sync lands", async () => {
  await seed(true)
  stop = followHeldReads()
  await press(NOTICE)
  await mount(list, async () => {
    await until(async () => Boolean(listRow()), "the chat's row")
    // The reply the notice was about, written by the host before the notice, synced after the press.
    await sync(NOTICE - 1_000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    await until(async () => !dotted(listRow()), "the synced reply to stay read")
  })
  await seedSidebar()
  await mount(sidebar, async () => {
    await until(async () => Boolean(botRow()), "the bot's row")
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(dotted(botRow()), false, "and the sidebar's row reads it the same way")
  })
})

test("a reply newer than the notice keeps its dot", async () => {
  await seed(true)
  stop = followHeldReads()
  await press(NOTICE)
  await mount(list, async () => {
    await until(async () => Boolean(listRow()), "the chat's row")
    await sync(NOTICE + 2_000)
    await until(async () => dotted(listRow()), "a reply the host wrote after the notice to be news")
  })
  await seedSidebar()
  await mount(sidebar, async () => {
    await until(async () => dotted(botRow()), "and the sidebar to say so")
  })
})

/** The sidebar's bot rows are the sides layout's: the same device, with the flat list switched off. */
async function seedSidebar() {
  await seedSettings({ developer: true, legacyChat: false, activeProfileId: bot.id })
}
