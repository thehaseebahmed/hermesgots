/**
 * The share sheet's rows: the chats and code sessions of the picked bot that were touched this week,
 * each in the mark of what it is, ten of them and Show more for the rest of the window. The read is
 * this device's own (Dexie), and nothing here asks a host anything.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { clearShare, receiveShare, toShare } from "@/lib/share"
import { SharePage } from "@/routes/share"

import {
  botProfile,
  click,
  findText,
  mount,
  Path,
  seedChats,
  until,
  wordsOf,
} from "./component-kit.tsx"

const HOUR = 3_600_000
const DAY = 86_400_000

const screen = () => (
  <MemoryRouter initialEntries={["/share"]}>
    <Path />
    <Routes>
      <Route path="/share" element={<SharePage />} />
      <Route path="/c/:id" element={<p>the chat</p>} />
    </Routes>
  </MemoryRouter>
)

/**
 * The sheet's rows: every option of the chat list but New chat, which starts one, and Show more,
 * which is a control rather than a place to send.
 */
const rows = () =>
  [...document.querySelectorAll('[aria-label="Chat"] button')].filter((one) => {
    const words = wordsOf(one)
    return words !== "New chat" && !words.startsWith("Show more")
  })

/** The one row a title is drawn on, or none. */
const row = (title: string) => rows().find((one) => wordsOf(one).includes(title)) ?? null

/** A share of a link, which is what a reader sends into a row. */
const shares = () => receiveShare(toShare({ text: "Read this later" }))

test("the sheet offers a chat and a code session of the last week, each in its own mark", async () => {
  const now = Date.now()
  await seedChats(
    [
      { id: "c-chat", title: "Trip to Lisbon", at: now - HOUR },
      { id: "c-session", title: "Fix the flaky test", at: now - 2 * HOUR },
      { id: "c-old", title: "Last month's plans", at: now - 30 * DAY },
    ],
    { bots: [botProfile("share-targets")] },
  )
  // A code session is a chat of a project's: the same record, one field apart (AGENTS.md, Code).
  await db.conversations.update("c-session", { projectId: "project-1" })
  try {
    shares()
    await mount(screen(), async () => {
      await until(async () => rows().length > 0, "the sheet's rows")
      const chat = row("Trip to Lisbon")
      const session = row("Fix the flaky test")
      assert.ok(chat, "a chat of the bot's is a row")
      assert.ok(session, "and so is a code session of it")
      assert.ok(chat.querySelector("svg.lucide-message-circle"), "a chat wears its bubble")
      assert.ok(session.querySelector("svg.lucide-code-xml"), "a session wears Code's mark")
      assert.equal(row("Last month's plans"), null, "a chat from last month is not on the sheet")
    })
  } finally {
    clearShare()
  }
})

test("the sheet draws ten rows, and Show more reveals the rest of the week", async () => {
  const now = Date.now()
  // Thirty chats touched this week: ten are drawn, and the window's own twenty-five is behind Show
  // more.
  await seedChats(
    Array.from({ length: 30 }, (_, index) => ({
      id: `c-${index}`,
      title: `Row ${index}`,
      at: now - index * 60_000,
    })),
    { bots: [botProfile("share-showmore")] },
  )
  try {
    shares()
    await mount(screen(), async () => {
      await until(async () => rows().length >= 10, "the sheet's ten rows")
      assert.equal(rows().length, 10, "ten rows, no more")
      const more = findText('[aria-label="Chat"] button', "Show more")
      assert.ok(more, "Show more is offered while the week holds more than ten")
      await click(more)
      await until(async () => rows().length > 10, "the rest of the week")
      assert.equal(rows().length, 25, "the rest of the window, and never past its twenty-five")
      assert.equal(
        findText('[aria-label="Chat"] button', "Show more"),
        null,
        "and nothing more to show",
      )
    })
  } finally {
    clearShare()
  }
})

test("a week of ten rows draws no Show more", async () => {
  const now = Date.now()
  await seedChats(
    Array.from({ length: 10 }, (_, index) => ({
      id: `c-${index}`,
      title: `Row ${index}`,
      at: now - index * 60_000,
    })),
    { bots: [botProfile("share-exactly-ten")] },
  )
  try {
    shares()
    await mount(screen(), async () => {
      await until(async () => rows().length >= 10, "the sheet's ten rows")
      assert.equal(rows().length, 10, "every row of the week is drawn")
      assert.equal(
        findText('[aria-label="Chat"] button', "Show more"),
        null,
        "and there is nothing behind a control to show",
      )
    })
  } finally {
    clearShare()
  }
})
