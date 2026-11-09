/**
 * Where a canvas is drawn (issue #933): a pinned one is a row of its own in the sidebar under Canvas,
 * so the page the reader keeps at hand is one tap away on every device, and a hidden one is out of
 * the Canvas screen's way — folded under a group of its own rather than gone, so it can be found
 * again. A canvas that is both is hidden first: a pinned page the reader hid stays out of the nav.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { db } from "@/lib/db"
import { CanvasPage } from "@/routes/canvas"

import { botProfile, click, find, json, mount, seedSettings, until } from "./component-kit.tsx"

const PINNED = {
  id: "p1",
  title: "A pinned timetable",
  session_id: "gots-chat-p1",
  chat_id: "chat-p1",
  version: 2,
  pinned: true,
  hidden: false,
  at: 20,
  created_at: 1,
}

const HIDDEN = {
  id: "h1",
  title: "A hidden scratchpad",
  session_id: "gots-chat-h1",
  chat_id: "chat-h1",
  version: 1,
  pinned: false,
  hidden: true,
  at: 10,
  created_at: 2,
}

function serveCanvases() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.113.0", features: ["canvas"] })
    if (url.pathname.endsWith("/canvases"))
      return json({ object: "gots.canvases", canvases: [PINNED, HIDDEN] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

async function seed() {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas-placement"))
}

test("a pinned canvas has a sidebar row and a hidden one is folded", async () => {
  serveCanvases()
  await seed()

  const pinnedRow = () => find('a[data-canvas-pinned][href="/canvas/p1"]')
  const drawn = (title: string) => (document.body.textContent ?? "").includes(title)

  await mount(
    <MemoryRouter initialEntries={["/canvas"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(pinnedRow()), "the pinned canvas's row")
      assert.match(pinnedRow()!.textContent ?? "", /A pinned timetable/)
      assert.equal(drawn("A hidden scratchpad"), false, "a hidden canvas has no sidebar row")
    },
  )

  await mount(
    <MemoryRouter initialEntries={["/canvas"]}>
      <CanvasPage />
    </MemoryRouter>,
    async () => {
      const hiddenGroup = () => find('section[aria-label="Hidden"]')
      await until(async () => Boolean(hiddenGroup()), "the folded Hidden group")
      assert.equal(drawn("A pinned timetable"), true, "a canvas in the list is drawn from the start")
      assert.equal(drawn("A hidden scratchpad"), false, "a folded canvas's title is not drawn yet")
      await click(hiddenGroup()!.querySelector("[data-slot=collapsible-trigger]"))
      await until(async () => drawn("A hidden scratchpad"), "the folded canvas to be drawn")
      assert.equal(drawn("A pinned timetable"), true, "the folded group leaves its neighbours alone")
    },
  )
})
