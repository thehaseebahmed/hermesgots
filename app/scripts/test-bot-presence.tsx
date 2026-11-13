/**
 * A bot's presence is the pass that just ran: a host this device's chat-list pass heard answer reads
 * online, one it didn't reads away at the last time it did, and a bot neither has an answer for reads
 * nothing at all — a bot that was only ever quiet is never called offline.
 *
 * Three screens say it and they have to agree: the sidebar's row for the bot, Settings' row for it,
 * and the Enabled row on the bot's own page. Each is read here off the screen that draws it, with the
 * host faked and the answer driven through the sync itself.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { db, type Profile } from "@/lib/db"
import { syncChatsOf } from "@/lib/sync"
import { SettingsPage } from "@/routes/settings"
import { botProfile, findAll, json, mount, seedSettings, until, wordsOf } from "./component-kit.tsx"

const HOUR = 3_600_000

/** Whether the bot's host answers this pass: its plugin's info and its chat list, or away. */
const host = { answers: true }

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  if (url.pathname.endsWith("/plugins/gots/info"))
    return host.answers
      ? json({ name: "gots", features: [] })
      : json({ error: { message: "The host is away." } }, 503)
  if (url.pathname.endsWith("/plugins/gots/chats")) {
    if (!host.answers) return json({ error: { message: "The host is away." } }, 503)
    const sent = JSON.parse(String(init?.body ?? "{}")) as { chats?: unknown }
    return json({ object: "gots.chats", chats: sent.chats ?? {} })
  }
  return json({})
}) as typeof fetch

/**
 * A bot this device holds, with the last time it heard its host — and no `seenAt` at all for a bot it
 * never has. Each test names its own host, since what a connection's plugin answered is remembered
 * for the page, and its own id, so no answer another test got stands in for this one.
 */
function held(name: string, id: string, seenAt?: number): Profile {
  return botProfile(name, {
    id,
    name: "A bot",
    hostId: `host-${id}`,
    // Off the seed's clock, so the pass treats it as a bot this device linked.
    updatedAt: 2,
    ...(seenAt === undefined ? {} : { seenAt }),
  })
}

/** Puts that one bot on this device, and nothing of another test's. */
async function device(profile: Profile) {
  await seedSettings({ developer: true, activeProfileId: profile.id })
  await db.profiles.clear()
  await db.profiles.put(profile)
  await db.conversations.clear()
}

const settings = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?/:sub?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

const sidebar = () => (
  <MemoryRouter initialEntries={["/"]}>
    <ConversationList />
  </MemoryRouter>
)

/** The sidebar's row for a bot, by the screen it opens. */
const sidebarRow = (id: string) =>
  findAll("a").find((one) => one.getAttribute("href") === `/b/${id}`) ?? null

/** Settings' own row for a bot, by the page it opens. */
const menuRow = (id: string) =>
  findAll("a").find((one) => one.getAttribute("href") === `/settings/bots/${id}`) ?? null

/** A bot's Enabled row on its own page: its switch, its title and the line under it. */
const enabledRow = () => wordsOf(document.querySelector('label[for="enabled"]'))

test("a bot whose host answered this pass reads online, however old its last answer was", async () => {
  await device(held("presence-answer", "bot-1", Date.now() - 2 * HOUR))
  host.answers = true
  await syncChatsOf(["bot-1"])

  await mount(sidebar(), async () => {
    await until(async () => Boolean(sidebarRow("bot-1")), "the sidebar's row for the bot")
    assert.match(
      wordsOf(sidebarRow("bot-1")),
      /Online/,
      "the sidebar says what the pass answered, not what this device kept from before",
    )
  })

  await mount(settings("/settings"), async () => {
    await until(async () => Boolean(menuRow("bot-1")), "Settings' row for the bot")
    const row = wordsOf(menuRow("bot-1"))
    assert.match(row, /Online/, "Settings' dot and its line say the same")
    assert.doesNotMatch(row, /Last seen/, "and the stale timestamp it kept is not what it reads")
  })
})

test("a host that didn't answer this pass reads away, though it answered a minute ago", async () => {
  await device(held("presence-away", "bot-1", Date.now() - 60_000))
  host.answers = false
  await syncChatsOf(["bot-1"])

  await mount(settings("/settings"), async () => {
    await until(async () => Boolean(menuRow("bot-1")), "Settings' row for the bot")
    const row = wordsOf(menuRow("bot-1"))
    assert.match(row, /Offline/, "the dot is grey: the pass didn't hear it")
    assert.match(row, /Last seen/, "and means: when this device last heard the host")
  })

  await mount(settings("/settings/bots/bot-1"), async () => {
    await until(
      async () => Boolean(document.querySelector('label[for="enabled"]')),
      "the bot's Enabled row",
    )
    assert.match(enabledRow(), /Last seen/, "and a bot's own page says the same sentence")
  })
})

test("a bot nothing has answered for reads nothing at all, rather than offline", async () => {
  await device(held("presence-never", "bot-2"))
  host.answers = false

  await mount(sidebar(), async () => {
    await until(async () => Boolean(sidebarRow("bot-2")), "the sidebar's row for the bot")
    assert.doesNotMatch(
      wordsOf(sidebarRow("bot-2")),
      /Online|Offline/,
      "a bot never heard from says nothing about being away",
    )
  })

  await mount(settings("/settings"), async () => {
    await until(async () => Boolean(menuRow("bot-2")), "Settings' row for the bot")
    assert.doesNotMatch(
      wordsOf(menuRow("bot-2")),
      /Online|Offline|Last seen/,
      "no dot at all, and no sentence to go with one",
    )
  })

  await mount(settings("/settings/bots/bot-2"), async () => {
    await until(
      async () => Boolean(document.querySelector('label[for="enabled"]')),
      "the bot's Enabled row",
    )
    assert.match(
      enabledRow(),
      /Not seen yet/,
      "a bot's own page says the words this one has none of",
    )
  })
})
