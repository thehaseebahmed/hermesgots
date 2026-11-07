/**
 * A synced chat on a bot this device cannot call: its record is here and its transcript is not, so
 * the current screen says the thread didn't load rather than drawing a chat nobody started. The
 * notice is the only screen left that reads a transcript for a bot with no key, and it keeps the
 * retry and the support dump that go with a failed read.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { THREAD_MISSING } from "@/components/chat/empty-states"
import { db } from "@/lib/db"
import { ChatPage } from "@/routes/chat"
import { botProfile, json, mount, seedChats } from "./component-kit.tsx"

const BOT = botProfile("thread-missing")

async function seed() {
  await seedChats([{ id: "s-past", title: "A session" }], {
    bots: [{ ...BOT, apiKey: "" }],
  })
  // A record something was sent in: its transcript is on a host this device cannot call.
  await db.conversations.update("s-past", { createdAt: 1, updatedAt: 2 })
  globalThis.fetch = async () => json({})
}

const screen = (
  <MemoryRouter initialEntries={["/c/s-past"]}>
    <Routes>
      <Route path="/c/:id" element={<ChatPage slot="route" />} />
    </Routes>
  </MemoryRouter>
)

test("a synced chat on an uncallable bot says the thread didn't load", async () => {
  await seed()
  await mount(screen, async () => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    const body = document.body.textContent ?? ""
    assert.ok(body.includes(THREAD_MISSING), "the pane says the thread didn't load")
    assert.ok(body.includes("Try again"), "and offers the read again")
    assert.ok(body.includes("Copy details"), "and the failed read for support")
    assert.equal(document.querySelector("[data-blank]"), null, "not chat-next's blank surface")
  })
})
