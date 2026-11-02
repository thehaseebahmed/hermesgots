/**
 * A session with a past this device holds no rows of reads its transcript from the host when it
 * opens; a read that came back empty used to be drawn as a session nobody started, saying nothing.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { THREAD_MISSING } from "@/components/chat/empty-states"
import { db } from "@/lib/db"
import {
  botProfile,
  chatScreen,
  click,
  find,
  findText,
  json,
  mount,
  seedChat,
  serveTranscript,
  settle,
  transcriptRows,
  until,
} from "./component-kit.tsx"

const body = () => document.body.textContent ?? ""
/** The big bot the new-session empty state draws — nowhere else in a session's pane. */
const botFace = () => find('[role="img"]')
const headerTitle = () => find('[data-slot="header-title"]')?.textContent?.trim()

/** A session that has something in it, with none of what it holds on this device. */
async function seedPastSession() {
  const profile = botProfile("history")
  await seedChat({ id: "s-past", projectId: "p-1", profile })
  // `updatedAt` past `createdAt` is the app's one record that something was sent in the session.
  await db.conversations.update("s-past", { updatedAt: 2 })
  return profile
}

/** The host's transcript as the kit pages it, unanswered while `down` says it is. */
function transcriptHost(rows: Parameters<typeof serveTranscript>[0], down: () => boolean) {
  serveTranscript(rows)
  const paged = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (!/\/messages$/.test(new URL(String(input)).pathname)) return json({})
    if (down()) throw new TypeError("Failed to fetch")
    return paged(input as RequestInfo)
  }) as unknown as typeof fetch
}

test("a session whose thread cannot be read says so instead of drawing a new one", async () => {
  await seedPastSession()
  transcriptHost([], () => true)
  await mount(chatScreen("s-past"), async () => {
    await settle()
    assert.ok(body().includes(THREAD_MISSING), "the pane says the thread didn't load")
    assert.equal(headerTitle(), "A session", "and the header keeps the session's own title")
    assert.ok(body().includes("Try again"), "and offers a retry")
    assert.equal(botFace(), null, "the session is not drawn as one nobody started")
  })
})

test("Try again reads the thread again and the notice goes", async () => {
  await seedPastSession()
  let failing = true
  const rows = transcriptRows(0)
  transcriptHost(
    [rows.row("user", "Work the issue"), rows.row("assistant", "On it.")],
    () => failing,
  )
  await mount(chatScreen("s-past"), async () => {
    await settle()
    assert.ok(body().includes(THREAD_MISSING), "the first read failed")
    failing = false
    await click(findText("button", "Try again"))
    await until(async () => body().includes("On it."), "the thread to land")
    assert.ok(!body().includes(THREAD_MISSING), "the notice is gone once the read lands")
  })
})

test("a session nothing was sent in still draws as a new one", async () => {
  await seedChat({ id: "s-draft", projectId: "p-1", profile: botProfile("history") })
  globalThis.fetch = async () => json({})
  await mount(chatScreen("s-draft"), async () => {
    await settle()
    assert.ok(botFace(), "the new session draws its bot")
    assert.ok(!body().includes(THREAD_MISSING), "and no read is claimed to have failed")
    assert.ok(!body().includes("Try again"), "with nothing to retry")
  })
})

test("Copy details hands support the failed read, without the bot's address", async () => {
  await seedPastSession()
  transcriptHost([], () => true)
  const copied: string[] = []
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  })
  await mount(chatScreen("s-past"), async () => {
    await settle()
    await click(findText("button", "Copy details"))
    assert.equal(copied.length, 1, "the details went to the clipboard")
    const block = copied[0]
    assert.ok(block.includes('"id": "s-past"'), "it names the chat")
    assert.ok(block.includes('"ended": "network"'), "and how the read ended")
    assert.ok(block.includes('"name": "HermesError"'), "and what threw")
    assert.ok(block.includes('"stack"'), "with the stack that walked to it")
    assert.ok(block.includes('"stored": 0'), "and that this device holds nothing")
    assert.ok(!block.includes("history.test"), "never the bot's address")
  })
})
