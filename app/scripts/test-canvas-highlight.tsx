/**
 * What the sidebar marks inside Canvas (issue #1051): the canvas this tab opened from Canvas's own
 * screens — the list's tile, or a start — and no other. A row's mark says *this is the one drawn
 * here* (ADR 0146), and for a canvas that is one this tab opened, so landing on one by a pinned row,
 * an address, a reload, back or forward, or another tab leaves the sidebar at rest. The mark is
 * `aria-current="page"` as well as the fill, so a screen reader hears which row is the page.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router"

import { AppShell } from "@/components/app-shell"
import { canvasAt, closeCanvas } from "@/lib/canvas-open"
import { db } from "@/lib/db"
import { CanvasEdit, CanvasPage, CanvasView } from "@/routes/canvas"

import {
  SwitchTo,
  atWidth,
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  type,
  until,
} from "./component-kit.tsx"

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Timetable</title>
  </head>
  <body><h1>Timetable</h1></body>
</html>`

/** The canvas the reader keeps in the sidebar, which every case opens on. */
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
  html: PAGE,
  tools: [],
}

/** The canvas a start makes: the host answers its record, pinned, so its row is one to mark. */
const STARTED = { ...PINNED, id: "c9", title: "A tip calculator", at: 30 }

/**
 * The bot's plugin, as far as a canvas's screens ask it: its features, the list the sidebar draws,
 * one canvas's record and page, and the create a start posts to.
 */
function serveCanvases() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.114.0", features: ["canvas"] })
    if (url.pathname.endsWith("/canvases") && init?.method === "POST")
      return json({ object: "gots.canvas", canvas: STARTED }, 202)
    if (/\/canvases\/[^/]+$/.test(url.pathname))
      return json({ object: "gots.canvas", canvas: url.pathname.endsWith("/c9") ? STARTED : PINNED })
    if (url.pathname.endsWith("/canvases"))
      return json({ object: "gots.canvases", canvases: [PINNED] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

async function seed() {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas-highlight"))
}

/**
 * A document that has just loaded. The canvas a tab opened lives in that tab's memory, so a reload, a
 * deep link and a second tab all arrive here with none; the suite runs in one document, so a case
 * that means "the reader has only now opened the app" says so with this.
 */
const freshDocument = () => closeCanvas()

/**
 * The app as a tablet draws it: the shell, the sidebar docked beside it (the one a reader sees from
 * 768px, and what a phone's drawer holds), and Canvas's three addresses. 900px is a width where the
 * sidebar stands and a canvas still draws no chat lane beside its page.
 */
const app = (entries: string[]) => (
  <MemoryRouter initialEntries={entries}>
    <Back />
    <SwitchTo to="/settings" />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="canvas" element={<CanvasPage />} />
        <Route path="canvas/:id" element={<CanvasView />} />
        <Route path="canvas/:id/edit" element={<CanvasEdit />} />
        <Route path="*" element={<p data-elsewhere />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

/** The browser's own back, as a press: the entry behind this one. */
function Back() {
  const navigate = useNavigate()
  return (
    <button type="button" data-back onClick={() => void navigate(-1)}>
      back
    </button>
  )
}

/** The tablet's width, for the whole of one case. */
const tablet = (body: () => Promise<void>) => atWidth(900, body)()

/** The row the sidebar draws a pinned canvas as, or nothing where it draws none. */
const row = (id: string) => find(`a[data-canvas-pinned][href="/canvas/${id}"]`)

/** The rows the sidebar marks as the page on screen. */
const marked = () => findAll('nav[aria-label="Main"] [aria-current="page"]')

/** The page on screen, as the sidebar reads it: the canvas's row and what it says it is. */
const says = (id: string) => ({
  current: row(id)?.getAttribute("aria-current") ?? null,
  // The row's own fill, never the hover it carries at rest (`hover:bg-muted`).
  filled: row(id)?.classList.contains("bg-muted") ?? false,
})

test("a canvas reached by its address marks no row", async () => {
  serveCanvases()
  await seed()
  freshDocument()

  await tablet(async () => {
    await mount(app(["/canvas/p1"]), async () => {
      await until(async () => Boolean(row("p1")), "the pinned canvas's row")
      assert.deepEqual(says("p1"), { current: null, filled: false }, "the row is no page")
      assert.equal(marked().length, 0, "and the sidebar marks nothing at all")
    })
  })
})

test("a pinned row's press marks nothing", async () => {
  serveCanvases()
  await seed()
  freshDocument()

  await tablet(async () => {
    await mount(app(["/canvas"]), async () => {
      await until(async () => Boolean(row("p1")), "the pinned canvas's row")
      await click(row("p1"))
      await until(async () => Boolean(find("[data-canvas-frame]")), "the canvas's own screen")
      assert.deepEqual(says("p1"), { current: null, filled: false }, "the row the reader pressed")
      assert.equal(marked().length, 0, "the sidebar marks nothing at all")
    })
  })
})

test("a reload on a canvas's screen marks nothing", async () => {
  serveCanvases()
  await seed()
  freshDocument()

  await tablet(async () => {
    // Opened through the flow first, so the mark this case loses is one the app really made.
    await mount(app(["/canvas"]), async () => {
      await until(async () => Boolean(find("[data-canvas-tile]")), "the canvas's tile")
      await click(find("[data-canvas-tile]"))
      await until(async () => Boolean(find("[data-canvas-frame]")), "the canvas's own screen")
      assert.equal(says("p1").current, "page", "the flow's open marks the row")
    })
    // The reload: a new document, and the canvas it opened is that document's memory alone.
    freshDocument()
    await mount(app(["/canvas/p1"]), async () => {
      await until(async () => Boolean(row("p1")), "the pinned canvas's row")
      assert.equal(says("p1").current, null, "nothing was opened in this document")
    })
  })
})

test("a canvas open in another tab marks nothing here", async () => {
  serveCanvases()
  await seed()
  freshDocument()

  await tablet(async () => {
    await mount(app(["/canvas/p1"]), async () => {
      await until(async () => Boolean(row("p1")), "the pinned canvas's row")
      assert.equal(says("p1").current, null, "the other tab's open is that tab's")
      assert.equal(marked().length, 0, "and the sidebar marks nothing at all")
    })
  })
})

test("back onto a canvas the flow opened marks nothing", async () => {
  serveCanvases()
  await seed()
  freshDocument()

  await tablet(async () => {
    await mount(app(["/canvas"]), async () => {
      await until(async () => Boolean(find("[data-canvas-tile]")), "the canvas's tile")
      await click(find("[data-canvas-tile]"))
      await until(async () => Boolean(find("[data-canvas-frame]")), "the canvas's own screen")
      assert.equal(says("p1").current, "page", "the flow's open marks the row")

      await click(find("[data-switch]"))
      await until(async () => Boolean(find("[data-elsewhere]")), "a screen that is no canvas")
      assert.equal(marked().length, 0, "off the canvas's screens no row is marked")

      await click(find("[data-back]"))
      await until(async () => Boolean(find("[data-canvas-frame]")), "the canvas its back returns to")
      assert.deepEqual(says("p1"), { current: null, filled: false }, "the reader left it, and came back")
    })
  })
})

test("a canvas the flow opened marks its row", async () => {
  serveCanvases()
  await seed()
  freshDocument()

  await tablet(async () => {
    await mount(app(["/canvas"]), async () => {
      await until(async () => Boolean(find("[data-canvas-tile]")), "the canvas's tile")
      await click(find("[data-canvas-tile]"))
      await until(async () => Boolean(find("[data-canvas-frame]")), "the canvas's own screen")
      await until(async () => Boolean(marked().length), "the row the flow marked")
      assert.deepEqual(says("p1"), { current: "page", filled: true }, "the canvas this tab opened")
      assert.equal(marked().length, 1, "one row is the page, never two")

      // The edit screen is the same canvas (ADR 0130), so the mark goes with it.
      await click(find('[data-canvas-flip="edit"]'))
      await until(async () => Boolean(find('[data-canvas-flip="preview"]')), "the edit screen")
      assert.deepEqual(says("p1"), { current: "page", filled: true }, "the canvas's own chat")
    })
  })
})

test("a start marks the canvas it opened", async () => {
  serveCanvases()
  await seed()
  freshDocument()

  await tablet(async () => {
    await mount(app(["/canvas"]), async () => {
      await until(
        async () => Boolean(find('textarea[aria-label="What the canvas should be"]')),
        "the start's field",
      )
      await type(find('textarea[aria-label="What the canvas should be"]'), "A tip calculator")
      await click(find('button[aria-label="Make it"]'))
      await until(async () => Boolean(row("c9")), "the new canvas's row")
      await until(async () => Boolean(marked().length), "the row the start marked")
      assert.equal(says("c9").current, "page", "the canvas the start opened")
      assert.equal(marked().length, 1, "one row is the page, never two")
    })
  })
})

test("the Canvas row marks its list, and a canvas's screens mark no section", async () => {
  serveCanvases()
  await seed()
  freshDocument()

  await tablet(async () => {
    await mount(app(["/canvas"]), async () => {
      await until(async () => Boolean(find('a[href="/canvas"]')), "the Canvas row")
      const canvasRow = find('a[href="/canvas"]')!
      assert.equal(canvasRow.getAttribute("aria-current"), "page", "the list is what Canvas is")
      assert.equal(says("p1").current, null, "a bare canvas's row is no page on the list")
    })
  })
})

test("a canvas's two screens are one canvas to the mark", async () => {
  assert.equal(canvasAt("/canvas/p1"), "p1", "the preview")
  assert.equal(canvasAt("/canvas/p1/edit"), "p1", "the edit screen beside it (ADR 0130)")
  assert.equal(canvasAt("/canvas/p1/other"), "p1", "anything under the canvas's own address")
  assert.equal(canvasAt("/canvas"), undefined, "the list is no canvas")
  assert.equal(canvasAt("/canvas/"), undefined, "and neither is its address")
  assert.equal(canvasAt("/settings"), undefined, "nor another screen")
})
