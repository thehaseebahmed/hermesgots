/**
 * A session with a past this device holds no rows of: its transcript is read from the host when it
 * opens, and a read that comes back empty is what draws the thread as one nobody started. That was
 * the report — a session opened on a phone with its header and composer standing and nothing between
 * them, saying nothing about why. The pane now says the read failed and offers Try again, and the
 * retry reads the thread again. A session nothing was sent in is still drawn as the new one it is.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { db } from "@/lib/db"
import {
  botProfile,
  chatScreen,
  click,
  findText,
  json,
  mount,
  seedChat,
  seedSettings,
  settle,
  transcriptRows,
  until,
} from "./component-kit.tsx"

const NOTICE = "The thread didn't load."
const body = () => document.body.textContent ?? ""
/** The big bot the new-session empty state draws — nowhere else in a session's pane. */
const face = () => document.querySelector('[role="img"]')

/** A session that has something in it, with none of what it holds on this device. */
async function seedPastSession() {
  const profile = botProfile("history")
  await seedChat({ id: "s-past", projectId: "p-1", profile })
  // `updatedAt` past `createdAt` is the app's one record that something was sent in the session.
  await db.conversations.update("s-past", { updatedAt: 2 })
  return profile
}

test("a session whose thread cannot be read says so instead of drawing a new one", async () => {
  await seedPastSession()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (/\/messages$/.test(url.pathname)) throw new TypeError("Failed to fetch")
    return json({})
  }) as unknown as typeof fetch
  await mount(chatScreen("s-past"), async () => {
    await settle()
    assert.ok(body().includes(NOTICE), "the pane says the thread didn't load")
    assert.ok(body().includes("Try again"), "and offers a retry")
    assert.equal(face(), null, "the session is not drawn as one nobody started")
  })
})

test("Try again reads the thread again and the notice goes", async () => {
  await seedPastSession()
  let failing = true
  const rows = transcriptRows(0)
  const served = [rows.row("user", "Work the issue"), rows.row("assistant", "On it.")]
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (!/\/messages$/.test(url.pathname)) return json({})
    if (failing) throw new TypeError("Failed to fetch")
    const limit = Number(url.searchParams.get("limit"))
    const offset = Number(url.searchParams.get("offset"))
    return json({
      data: [...served]
        .sort((a, b) => b.id - a.id)
        .slice(offset, offset + limit)
        .reverse(),
    })
  }) as unknown as typeof fetch
  await mount(chatScreen("s-past"), async () => {
    await settle()
    assert.ok(body().includes(NOTICE), "the first read failed")
    failing = false
    await click(findText("button", "Try again"))
    await until(async () => body().includes("On it."), "the thread to land")
    assert.ok(!body().includes(NOTICE), "the notice is gone once the read lands")
  })
})

test("a session nothing was sent in still draws as a new one", async () => {
  const profile = botProfile("history")
  await seedSettings({ activeProfileId: profile.id })
  await db.profiles.clear()
  await db.profiles.put(profile)
  await db.conversations.put({
    id: "s-draft",
    profileId: profile.id,
    title: "Draft session",
    hermesSessionId: "s-draft-hermes",
    projectId: "p-1",
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
  globalThis.fetch = async () => json({})
  await mount(chatScreen("s-draft"), async () => {
    await settle()
    assert.ok(face(), "the new session draws its bot")
    assert.ok(!body().includes(NOTICE), "and no read is claimed to have failed")
    assert.ok(!body().includes("Try again"), "with nothing to retry")
  })
})
