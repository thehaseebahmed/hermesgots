/**
 * Where a canvas is drawn (issue #933): a pinned one is a row of the sidebar's own list, after
 * Routines and in the same styling as the screens above it, so the page the reader keeps at hand is
 * one tap away on every device; an archived one is out of the Canvas screen's way — folded under a
 * group of its own rather than gone, so it can be found again. A canvas that is both is archived
 * first: a pinned page the reader archived stays out of the nav.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { db } from "@/lib/db"
import { CanvasPage } from "@/routes/canvas"

import { botProfile, click, find, json, missing, mount, seedSettings, until } from "./component-kit.tsx"

const PINNED = {
  id: "p1",
  title: "A pinned timetable",
  session_id: "gots-chat-p1",
  chat_id: "chat-p1",
  version: 2,
  pinned: true,
  archived: false,
  at: 20,
  created_at: 1,
}

const ARCHIVED = {
  id: "h1",
  title: "An archived scratchpad",
  session_id: "gots-chat-h1",
  chat_id: "chat-h1",
  version: 1,
  pinned: false,
  archived: true,
  at: 10,
  created_at: 2,
}

const BOTH = {
  id: "b1",
  title: "An archived favourite",
  session_id: "gots-chat-b1",
  chat_id: "chat-b1",
  version: 1,
  pinned: true,
  archived: true,
  at: 5,
  created_at: 3,
}

function serveCanvases() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.114.0", features: ["canvas"] })
    if (url.pathname.endsWith("/canvases"))
      return json({ object: "gots.canvases", canvases: [PINNED, ARCHIVED, BOTH] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

async function seed() {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas-placement"))
}

test("a pinned canvas has a sidebar row and an archived one is folded", async () => {
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
      assert.equal(drawn("An archived scratchpad"), false, "an archived canvas has no sidebar row")
      assert.ok(missing('a[data-canvas-pinned][href="/canvas/b1"]'), "a pinned page the reader archived keeps out of the nav")
      assert.equal(drawn("An archived favourite"), false, "and draws no row of its own")

      const nav = find('nav[aria-label="Main"]')!
      const rows = [...nav.querySelectorAll("a")]
      assert.ok(
        rows.indexOf(pinnedRow()!) > rows.indexOf(find('a[href="/routines"]')!),
        "the row sits after Routines",
      )
      assert.equal(
        pinnedRow()!.className.includes("pl-8"),
        false,
        "drawn as one of the nav's rows, not indented under Canvas",
      )
    },
  )

  await mount(
    <MemoryRouter initialEntries={["/canvas"]}>
      <CanvasPage />
    </MemoryRouter>,
    async () => {
      const archivedGroup = () => find('section[aria-label="Archived"]')
      await until(async () => Boolean(archivedGroup()), "the folded Archived group")
      assert.equal(drawn("A pinned timetable"), true, "a canvas in the list is drawn from the start")
      assert.equal(drawn("An archived scratchpad"), false, "a folded canvas's title is not drawn yet")
      assert.equal(drawn("An archived favourite"), false, "an archived pin is folded away too")
      await click(archivedGroup()!.querySelector("[data-slot=collapsible-trigger]"))
      await until(async () => drawn("An archived scratchpad"), "the folded canvas to be drawn")
      assert.equal(drawn("An archived favourite"), true, "an archived pin folds with the rest")
      assert.equal(drawn("A pinned timetable"), true, "the folded group leaves its neighbours alone")
    },
  )
})
