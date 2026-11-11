import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"

import { Home } from "@/App"
import { ConversationList } from "@/components/conversation-list"
import { BotChatsPage } from "@/routes/bot-chats"
import { ChatPage } from "@/routes/chat"
import { db } from "@/lib/db"
import { rememberLastChat } from "@/lib/last-chat"

import {
  botProfile,
  findAll,
  findText,
  json,
  mount,
  seedSettings,
  until,
} from "./component-kit.tsx"

const bot = botProfile("bot-main", { id: "bot-1", name: "Mainly", apiKey: undefined })
const MAIN = "main-bot-1"

/** The bot's Main, as the record a device already holds it carries it (G1: a chat like any other). */
const mainRow = () => ({
  id: MAIN,
  profileId: bot.id,
  title: "Main",
  titleEdited: true,
  main: true,
  hermesSessionId: `gots-${MAIN}`,
  createdAt: 10,
  updatedAt: 10,
  changedAt: 0,
})
async function seed(patch: { developer?: boolean; legacyChat?: boolean } = {}) {
  await seedSettings({
    activeProfileId: bot.id,
    ...patch,
  })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
}

const Where = () => <p data-path>{useLocation().pathname}</p>
const where = () => document.querySelector("[data-path]")?.textContent ?? ""

const homeScreen = (
  <MemoryRouter initialEntries={["/"]}>
    <Routes>
      <Route
        index
        element={
          <>
            <Home />
            <Where />
          </>
        }
      />
      <Route
        path="b/:profileId"
        element={
          <>
            <BotChatsPage />
            <Where />
          </>
        }
      />
      <Route
        path="c/:id"
        element={
          <>
            <ChatPage slot="route" />
            <Where />
          </>
        }
      />
    </Routes>
  </MemoryRouter>
)

const staleScreen = (
  <MemoryRouter initialEntries={["/b/bot-1"]}>
    <Routes>
      <Route index element={<Where />} />
      <Route
        path="b/:profileId"
        element={
          <>
            <BotChatsPage />
            <Where />
          </>
        }
      />
      <Route
        path="c/:id"
        element={
          <>
            <ChatPage slot="route" />
            <Where />
          </>
        }
      />
    </Routes>
  </MemoryRouter>
)


test("with nothing stored the app is the bot-first layout", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(homeScreen, async () => {
    await until(async () => where() === `/b/${bot.id}`, "the bot's own address")
    assert.equal(
      await db.conversations.count(),
      0,
      "a bot with nothing to open draws its list rather than making a chat for it",
    )
  })
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(
        async () => findAll("a").some((row) => row.getAttribute("href") === `/b/${bot.id}`),
        "the bot row",
      )
      assert.ok(!findText("button", "New chat"), "no New chat button beside the bots")
    },
  )
})

test("home opens the chat this device last had open in the bot", async () => {
  await seed()
  await db.conversations.put(mainRow())
  rememberLastChat(bot.id, MAIN)
  globalThis.fetch = async () => json({})
  await mount(homeScreen, async () => {
    await until(async () => where() === `/c/${MAIN}`, "the chat the bot was left in")
  })
})

test("a link to a bot's screen draws the bot's list, and makes no Main", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(staleScreen, async () => {
    await until(async () => where() === `/b/${bot.id}`, "the bot's own address")
    assert.equal(
      await db.conversations.count(),
      0,
      "the list reads the chats it has rather than making one",
    )
  })
})

test("the Chats list's bot row opens the bot's screen", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(
        async () => findAll("a").some((row) => row.getAttribute("href") === `/b/${bot.id}`),
        "the bot row",
      )
      assert.ok(
        !findAll("a").some((row) => row.getAttribute("href") === `/c/${MAIN}`),
        "and no row opens Main over the list's head",
      )
    },
  )
})

test("the legacy switch brings the Recents list and the New chat button back", async () => {
  await seed({ legacyChat: true })
  globalThis.fetch = async () => json({})
  await mount(homeScreen, async () => {
    assert.equal(where(), "/", "home is the new-chat screen again")
    assert.equal(await db.conversations.count(), 0, "no Main")
  })
  await mount(staleScreen, async () => {
    assert.equal(where(), "/", "the old address falls back home")
    assert.equal(await db.conversations.count(), 0, "no Main")
  })
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(findText("button", "New chat")), "the New chat button")
      assert.equal(
        findAll("a").some((row) => row.getAttribute("href") === `/c/${MAIN}`),
        false,
        "nothing opens a bot's Main: the list is Recents",
      )
    },
  )
})
