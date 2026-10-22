import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router"

import { Home } from "@/App"
import { ConversationList } from "@/components/conversation-list"
import { BotThreadsPage } from "@/routes/bot-threads"
import { ChatPage } from "@/routes/chat"
import { db, ensureMainThread, mainThreadId } from "@/lib/db"
import { SUGGESTIONS } from "@/lib/suggestions"
import { BOTS, DEFAULT_BOT_ID } from "@/components/bots"
import {
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  mount,
  seedSettings,
  text,
  until,
} from "./component-kit.tsx"

const bot = botProfile("bot-main", { id: "bot-1", name: "Mainly" })
const MAIN = mainThreadId(bot.id)
const defaultBot = BOTS.find((one) => one.id === DEFAULT_BOT_ID)!

async function seed(patch: { developer?: boolean; botThreads?: boolean } = {}) {
  await seedSettings({
    developer: true,
    botThreads: true,
    activeProfileId: bot.id,
    ...patch,
  })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
}

function host(name: string) {
  const seen: { path: string; body: any }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    seen.push({ path: url.pathname, body })
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/memento/info"))
      return json({ features: ["queue", "triage", "moves"] })
    if (url.pathname.endsWith("/triage")) return json({ decision: "main" })
    if (url.pathname.endsWith("/v1/runs") && init?.method === "POST")
      return json({ error: { message: "stopped here" } }, 500)
    return json({})
  }) as typeof fetch
  return seen
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
        path="c/:id"
        element={
          <>
            <ChatPage />
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
      <Route path="b/:profileId" element={<BotThreadsPage />} />
      <Route
        path="c/:id"
        element={
          <>
            <ChatPage />
            <Where />
          </>
        }
      />
    </Routes>
  </MemoryRouter>
)

const Nav = () => <p data-nav>{`${useNavigationType()}:${useLocation().pathname}`}</p>
const nav = () => find("[data-nav]")?.textContent ?? ""

const paneScreen = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <ChatPage key={bot.id} chatId={MAIN} />
    <Routes>
      <Route path="/c/:id" element={<ChatPage />} />
    </Routes>
    <Nav />
  </MemoryRouter>
)

const cardLink = (threadId: string) => find(`a[href="/c/${threadId}"]`)
const openCards = () => findAll('[data-slot="thread-card"] [aria-current="page"]')

test("with room, a card beside Main swaps the thread in place and reads as open", async () => {
  await paneSeed()
  await ensureMainThread(bot.id)
  globalThis.fetch = async () => json({})
  await mount(paneScreen("/c/t-a"), async () => {
    await until(async () => Boolean(cardLink("t-b")), "Main's cards beside the open thread")
    assert.equal(openCards().length, 1, "exactly the thread on screen is marked open")
    assert.equal(
      openCards()[0].getAttribute("href"),
      "/c/t-a",
      "and it is the one the address names",
    )

    await click(cardLink("t-b"))
    await until(() => nav().startsWith("REPLACE:"), "a replace, not another history entry")
    assert.equal(nav(), "REPLACE:/c/t-b", "the thread swapped in where the last one was")
    assert.equal(openCards()[0].getAttribute("href"), "/c/t-b", "and the open mark moved with it")
  })
})

test("with no room, a tapped card pushes its thread so back returns to Main", async () => {
  await paneSeed()
  await ensureMainThread(bot.id)
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={[`/c/${MAIN}`]}>
      <Routes>
        <Route path="/c/:id" element={<ChatPage />} />
      </Routes>
      <Nav />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(cardLink("t-b")), "Main's cards")
      assert.equal(openCards().length, 0, "Main on its own has no open thread to mark")
      await click(cardLink("t-b"))
      await until(() => nav().startsWith("PUSH:"), "a push, so back has somewhere to return to")
      assert.equal(nav(), "PUSH:/c/t-b")
    },
  )
})

async function paneSeed() {
  await seed()
  await db.profiles.update(bot.id, { baseUrl: "http://bot-pane.test/v1" })
  await seedThreads()
}

async function seedThreads() {
  await db.conversations.bulkPut(
    ["t-a", "t-b"].map((id) => ({
      id,
      profileId: bot.id,
      title: `Thread ${id}`,
      hermesSessionId: `memento-${id}`,
      createdAt: 10,
      updatedAt: 10,
      changedAt: 0,
    })),
  )
  await db.messages.bulkPut(
    ["t-a", "t-b"].map((id) => ({
      id: `${id}-open`,
      conversationId: id,
      role: "user" as const,
      content: `Opened ${id}`,
      status: "done" as const,
      createdAt: 11,
    })),
  )
}

test("home opens the bot's Main thread", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(homeScreen, async () => {
    await until(async () => where() === `/c/${MAIN}`, "Main's address")
    assert.ok(await db.conversations.get(MAIN), "Main is made so the address lands somewhere")
  })
})

test("a stale link to the old bot screen lands on Main", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(staleScreen, async () => {
    await until(async () => where() === `/c/${MAIN}`, "Main's address")
    assert.equal(await db.conversations.count(), 1, "only Main, never a card screen's thread")
  })
})

test("the Chats list's bot row opens the bot's Main thread", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(
        async () => findAll("a").some((row) => row.getAttribute("href") === `/c/${MAIN}`),
        "the bot row",
      )
      assert.ok(
        !findAll("a").some((row) => row.getAttribute("href") === "/b/bot-1"),
        "no row points at the old screen",
      )
    },
  )
})

test("Main's empty state sends a suggestion into Main, triaged, without a thread", async () => {
  await seed()
  const seen = host("bot-main")
  await mount(
    <MemoryRouter initialEntries={[`/c/${MAIN}`]}>
      <Routes>
        <Route path="c/:id" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await until(
        async () => defaultBot.lines.some((line) => text().includes(line)),
        "the bot's own line",
      )
      assert.equal(text().includes("Hey, I'm"), false, "no introduction")
      assert.equal(
        text().includes("Ask me anything"),
        false,
        "and no explanatory copy about how the app works",
      )
      const chip = findText("button", SUGGESTIONS[0])
      assert.ok(chip, "a suggestion chip")
      await click(chip)
      await until(
        async () => (await db.messages.where("conversationId").equals(MAIN).count()) > 0,
        "the message in Main",
      )
      assert.ok(
        seen.some((request) => request.path.endsWith("/triage")),
        "the chip's message is triaged",
      )
      assert.equal(await db.conversations.count(), 1, "nothing minted a thread")
    },
  )
})

test("with the Developer switch off no Main is made and the app is as it was", async () => {
  await seed({ botThreads: false })
  globalThis.fetch = async () => json({})
  await mount(homeScreen, async () => {
    assert.equal(where(), "/", "home is still the new-chat screen")
    assert.equal(await db.conversations.count(), 0, "no Main")
  })
  await mount(staleScreen, async () => {
    assert.equal(where(), "/", "the old address falls back home")
    assert.equal(await db.conversations.count(), 0, "no Main")
  })
})
