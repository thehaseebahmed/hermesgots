/**
 * The Cheatsheet's way in: `/cheatsheet` in the composer's slash menu, picked the way a keyboard
 * picks it, over a seeded device database and the real chat route. The branch it drives is the one
 * whose fall-through opens Settings, so a missed branch fails here rather than in a demo.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatPage } from "@/routes/chat"
import { db } from "@/lib/db"
import {
  botProfile,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  type,
  until,
} from "./component-kit.tsx"

const CHAT = "cheat-1"
const bot = botProfile("cheatsheet", { id: "bot-1", name: "Cheatsy" })

async function seed() {
  await seedSettings({ activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put({
    id: CHAT,
    profileId: bot.id,
    title: "A chat",
    hermesSessionId: `${CHAT}-hermes`,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
}

/** The HTTP boundary, faked: every request and body kept, so a message can't slip past unseen. */
function host() {
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith("cheatsheet")) return json({})
    seen.push(
      `${init?.method ?? "GET"} ${url.pathname}${url.search}${
        typeof init?.body === "string" ? ` ${init.body}` : ""
      }`,
    )
    if (url.pathname.endsWith("/skills")) return json({ object: "list", data: [] })
    return json({})
  }) as typeof fetch
  return seen
}

const screen = (
  <MemoryRouter initialEntries={[`/c/${CHAT}`]}>
    <Routes>
      <Route path="c/:id" element={<ChatPage />} />
    </Routes>
  </MemoryRouter>
)

const field = () => find('textarea[aria-label="Message"]') as HTMLTextAreaElement | null
const options = () => findAll('[role="option"]').map((row) => row.textContent ?? "")
const offered = (name: string) => options().some((row) => row.startsWith(name))

async function enter() {
  await act(async () => {
    field()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    )
  })
  await settle()
}

/** The open sheet: a pop-up's last dialog, which is the one on top. */
const sheet = () => findAll('[role="dialog"]').at(-1) ?? null
const groups = () => findAll("[data-group]").map((one) => one.getAttribute("data-group"))

test("the menu offers /cheatsheet as a command, beside the others", async () => {
  await seed()
  host()
  await mount(screen, async () => {
    await until(async () => Boolean(field()), "the composer")
    await type(field(), "/")
    await until(async () => options().length > 0, "the command menu")
    assert.ok(offered("/cheatsheet"), "the command is on offer")
    const row = findAll('[role="option"]').find((one) =>
      (one.textContent ?? "").startsWith("/cheatsheet"),
    )
    assert.ok(
      row?.querySelector("svg"),
      "the row carries an icon, as every command's does",
    )
  })
})

test("picking /cheatsheet opens the sheet with its groups and rows, and sends nothing", async () => {
  await seed()
  const seen = host()
  await mount(screen, async () => {
    await until(async () => Boolean(field()), "the composer")
    await type(field(), "/cheatsheet")
    await until(async () => offered("/cheatsheet"), "the command in the menu")
    await enter()
    await until(async () => Boolean(sheet()), "the sheet")
    assert.match(sheet()?.textContent ?? "", /Cheatsheet/, "titled")
    assert.deepEqual(groups(), ["Composer", "Slash menu", "Chat"], "its three groups, in order")
    const rows = sheet()?.textContent ?? ""
    for (const row of [
      "Send the message",
      "Start a new line",
      "Clear the message, keeping attachments",
      "Move through the menu",
      "Pick the highlighted row",
      "Close the menu",
      "Stop a running reply",
    ])
      assert.ok(rows.includes(row), `the sheet says ${row}`)
    for (const key of ["Enter", "Shift+Enter", "Escape", "ArrowUp", "ArrowDown", "Tab", "Ctrl+C"])
      assert.ok(rows.includes(key), `the sheet names ${key}`)
    assert.equal(field()?.value, "", "the pick cleared the composer")
    assert.ok(field(), "the chat is still on screen: the branch didn't fall through to Settings")
    assert.deepEqual(
      seen.filter((request) => /cheatsheet/i.test(request)),
      [],
      "the command never reached the host",
    )
  })
})
