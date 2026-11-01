/**
 * Delete and Discard end a session at the tap: the row moves while the host is still closing it, and
 * the close's report is told when it ends (ADR 0075).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"
import { toast } from "sonner"

import { ChatPage } from "@/routes/chat"
import { db, type Conversation } from "@/lib/db"
import {
  botProfile,
  click,
  find,
  findText,
  json,
  mount,
  Path,
  path,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"

const bot = botProfile("session-close", { id: "bot-close", name: "Closer" })
const CHAT = "c-close"
const SESSION = "s-close"

const conversation = (): Conversation =>
  ({
    id: CHAT,
    profileId: bot.id,
    projectId: "p-1",
    title: "A session",
    hermesSessionId: SESSION,
    worktree: {
      branch: "memento/close",
      repos: [{ name: "acme/app", branch: "memento/close" }],
      instructions: "",
    },
    createdAt: 10,
    updatedAt: 10,
    changedAt: 10,
    prs: [],
  }) as Conversation

async function seed() {
  // A case is a device of its own: the marks a report is told against live here, not on the host.
  localStorage.clear()
  await seedSettings({ developer: true, botThreads: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put(conversation())
}

const screen = (
  <MemoryRouter initialEntries={[`/c/${CHAT}`]}>
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
    </Routes>
  </MemoryRouter>
)

/** The host's answer to the ask, held until the test says so: the close outliving the dialog. */
function heldHost() {
  let release!: (response: Response) => void
  const held = new Promise<Response>((resolve) => (release = resolve))
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/info"))
      return json({ name: "memento", version: "0.97.0", features: ["closes"] })
    if (url.endsWith(`/sessions/${SESSION}/closes`) && init?.method === "POST") {
      asked.push("asked")
      return held
    }
    return json({})
  }) as typeof fetch
  return { release, asked }
}

const close = (facts: Record<string, unknown> = {}) => ({
  object: "memento.closing",
  session_id: SESSION,
  state: "done",
  started_at: 5,
  ended_at: 6,
  repos: ["acme/app"],
  removed: false,
  kept: [{ name: "acme/app", reason: "unpushed" }],
  results: [],
  error: null,
  ...facts,
})

test("Delete removes the session while the host is still closing it, and tells the report", async () => {
  await seed()
  const host = heldHost()
  const said: string[] = []
  const real = toast.info
  toast.info = ((message: unknown) => said.push(String(message))) as typeof toast.info
  try {
    await mount(screen, async () => {
      await click(find('[aria-label="Chat options"]'))
      await click(findText('[role="menuitem"]', "Delete"))
      await click(findText('[role="dialog"] button, [role="alertdialog"] button', "Delete"))

      // The row is gone and the screen moved on, with the host's close held open.
      await until(async () => (await db.conversations.get(CHAT)) === undefined, "the session gone")
      assert.equal(path(), "/code", "the app left the session it deleted")
      await until(async () => host.asked.length === 1, "the host asked to close it")
      assert.deepEqual(said, [], "nothing is told before the close ends")

      host.release(json(close()))
      await until(async () => said.length > 0, "the close's report told")
      assert.deepEqual(said, ["Kept acme/app: it has unpushed changes."])
    })
  } finally {
    toast.info = real
  }
})

test("Discard moves the session to Discarded at once, with the close still running", async () => {
  await seed()
  const host = heldHost()
  const said: string[] = []
  const real = toast.info
  toast.info = ((message: unknown) => said.push(String(message))) as typeof toast.info
  try {
    await mount(screen, async () => {
      await click(find('[aria-label="Chat options"]'))
      await click(findText('[role="menuitem"]', "Discard"))
      await click(findText('[role="alertdialog"] button', "Discard"))

      await until(
        async () => Boolean((await db.conversations.get(CHAT))?.discardedAt),
        "the session discarded",
      )
      await until(async () => host.asked.length === 1, "the host asked to close it")
      assert.deepEqual(said, [], "a close still running has nothing to tell")

      // A later close of the same session is news again: its start is past the mark this device
      // already holds for the one before it.
      host.release(json(close({ started_at: 50 })))
      await until(async () => said.length > 0, "the close's report told")
    })
  } finally {
    toast.info = real
  }
})

test("a host that never answers leaves the discarded row where it was", async () => {
  await seed()
  heldHost()
  await mount(screen, async () => {
    await click(find('[aria-label="Chat options"]'))
    await click(findText('[role="menuitem"]', "Discard"))
    await click(findText('[role="alertdialog"] button', "Discard"))
    await until(
      async () => Boolean((await db.conversations.get(CHAT))?.discardedAt),
      "the session discarded",
    )
    await settle()
    assert.equal(path(), `/c/${CHAT}`, "a slow host does not take the row away")
  })
})
