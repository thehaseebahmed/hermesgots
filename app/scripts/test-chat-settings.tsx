/**
 * A bot's own chat: its bar carries neither a way to its bot's list nor a `…`, and the press its
 * title answers opens the chat's settings — its name, its mute and its delete, which the menu that
 * stood there held (ADR 0153).
 *
 * A project session is not a chat's settings: it keeps the menu, whose resolve, discard and delete
 * are its own. That is what the last case holds.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatPage } from "@/routes/chat"
import { db, type Conversation } from "@/lib/db"
import {
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  missing,
  mount,
  Path,
  path,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"

const bot = botProfile("chat-settings", { id: "bot-settings", name: "Settler" })
const CHAT = "c-settings"
const SESSION = "c-session"

const chatRow = (patch: Partial<Conversation> = {}): Conversation =>
  ({
    id: CHAT,
    profileId: bot.id,
    title: "A chat of the bot's",
    hermesSessionId: SESSION,
    createdAt: 10,
    updatedAt: 10,
    changedAt: 10,
    ...patch,
  }) as Conversation

async function seed(patch: Partial<Conversation> = {}) {
  localStorage.clear()
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put(chatRow(patch))
}

const screen = (id = CHAT) => (
  <MemoryRouter initialEntries={[`/c/${id}`]}>
    <Routes>
      <Route
        path="/c/:id"
        element={
          <>
            <ChatPage slot="route" />
            <Path />
          </>
        }
      />
      <Route path="/code" element={<Path />} />
      <Route path="/" element={<Path />} />
    </Routes>
  </MemoryRouter>
)

/** The bar's title, as the one press a chat's header answers with. */
const titlePress = () => find("[data-chat-settings-open]")
/** The sheet the press opens, by the name it wears. */
const sheet = () => findText("[role=dialog]", "Edit chat")

test("a bot's chat draws no way to its list and no menu in its bar", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    assert.equal(findAll('[aria-label^="Chats with"]').length, 0, "no list control")
    assert.equal(findAll('[aria-label="Chat options"]').length, 0, "and no menu beside it")
  })
})

test("the bar's title opens the chat's settings, holding its name, its mute and its delete", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    assert.equal(findAll("[role=dialog]").length, 0, "nothing is open until the title is pressed")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    assert.ok(find("[data-chat-name]"), "its name, to edit")
    assert.equal(
      findAll('[role="switch"]').length,
      1,
      "its notifications, as a switch rather than a menu item",
    )
    assert.ok(findText("button", "Delete chat"), "and the one control that ends it")
  })
})

test("the sheet's switch mutes the chat, and unmutes it again", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    const toggle = () => find('[role="switch"]')
    assert.equal(toggle()?.getAttribute("aria-checked"), "false", "a chat starts unmuted")
    await click(toggle())
    await until(async () => (await db.conversations.get(CHAT))?.muted === true, "the chat muted")
    await settle()
    await click(find('[role="switch"]'))
    await until(async () => (await db.conversations.get(CHAT))?.muted === undefined, "unmuted again")
  })
})

test("Delete asks first, and takes the chat away only when answered", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    await click(findText("button", "Delete chat"))
    await until(async () => Boolean(findText("[role=alertdialog]", "Delete this chat?")), "the ask")
    assert.ok(await db.conversations.get(CHAT), "a confirmation asked is not a chat deleted")
    await click(findText("[role=alertdialog] button", "Delete"))
    await until(async () => path() === "/", "the way out once it is gone")
    assert.equal(await db.conversations.get(CHAT), undefined, "and the chat with it")
  })
})

test("a project session keeps its menu: its settings are not a chat's", async () => {
  await seed({ projectId: "p-1", title: "A session" })
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(find('[aria-label="Chat options"]')), "the session's menu")
    assert.ok(missing("[data-chat-settings-open]"), "and no title that opens a chat's settings")
  })
})
