import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { db, type Message } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import {
  botProfile,
  findAll,
  json,
  mount,
  seedSettings,
  text,
  until,
} from "./component-kit.tsx"

const bot = botProfile("bot-chrome", { id: "bot-1", name: "Chrome", apiKey: "test-key" })
const other = botProfile("bot-other", { id: "bot-2", name: "Other" })
const HOUR = 3_600_000

const msg = (
  id: string,
  conversationId: string,
  role: Message["role"],
  content: string,
  createdAt: number,
): Message => ({ id, conversationId, role, content, status: "done", createdAt })

/**
 * Two bots with chats: one whose only chat is older than its newest one, and one never opened on
 * this device. A Main is one of a bot's chats and no row of its own, so nothing here marks one out
 * (G1).
 */
async function seedSidebar() {
  const now = Date.now()
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.bulkPut([bot, other])
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut([
    {
      id: "main-bot-1",
      profileId: bot.id,
      title: "Main",
      main: true,
      titleEdited: true,
      hermesSessionId: "gots-main-bot-1",
      createdAt: now - 6 * HOUR,
      updatedAt: now - 5 * HOUR,
      changedAt: 0,
    },
    {
      id: "t-newer",
      profileId: bot.id,
      title: "A newer chat",
      hermesSessionId: "gots-t-newer",
      createdAt: now - 2 * HOUR,
      updatedAt: now - 60_000,
      changedAt: 0,
    },
    {
      id: "o-1",
      profileId: other.id,
      title: "Its only chat",
      hermesSessionId: "gots-o-1",
      createdAt: now - HOUR,
      updatedAt: now - HOUR,
      changedAt: 0,
    },
  ])
  await db.messages.bulkPut([
    msg("m-1", "main-bot-1", "user", "An old thing said in Main", now - 5 * HOUR),
    msg("t-1", "t-newer", "user", "The newest chat's opener", now - 2 * HOUR),
  ])
  return now
}

/** The sidebar's row for a bot, by the screen it opens. */
const row = (botId: string) =>
  findAll("a").find((one) => one.getAttribute("href") === `/b/${botId}`) ?? null

test("the sidebar's bot row previews what its newest chat last said, not an older chat's", async () => {
  const now = await seedSidebar()
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(row(bot.id)), "the bot row")
      const line = row(bot.id)?.textContent ?? ""
      assert.ok(line.includes("The newest chat's opener"), "what the newest chat last said")
      assert.ok(!line.includes("An old thing said in Main"), "not an older chat's words")
      assert.ok(
        line.includes(formatRelative(now - 60_000, Date.now())),
        "aged by that chat, since that is what it previews",
      )
    },
  )
})

test("a bot never opened still previews its newest chat", async () => {
  await seedSidebar()
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(row(other.id)), "the other bot's row")
      assert.ok((row(other.id)?.textContent ?? "").includes("Its only chat"))
    },
  )
})
