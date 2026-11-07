/**
 * Delete and Discard end a session at the tap: the row moves while the host is still closing it, and
 * the close's report is told when it ends (ADR 0080).
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
  findText,
  json,
  mount,
  Path,
  path,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"

const bot = botProfile("session-close", { id: "bot-close", name: "Closer", apiKey: undefined })
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
      branch: "gots/close",
      repos: [{ name: "acme/app", branch: "gots/close" }],
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
  await seedSettings({ developer: true, activeProfileId: bot.id })
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
      return json({ name: "gots", version: "0.103.0", features: ["closes"] })
    if (url.endsWith(`/sessions/${SESSION}/closes`) && init?.method === "POST") {
      asked.push("asked")
      return held
    }
    return json({})
  }) as typeof fetch
  return { release, asked }
}

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
