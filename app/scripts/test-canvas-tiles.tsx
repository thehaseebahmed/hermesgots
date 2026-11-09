/**
 * The Canvas list is tiles, not rows (issue #934): what a reader picks from is a page, so the thing
 * that tells two canvases apart at a glance is the picture on the tile — the one the bot wrote with
 * the canvas, or the canvas's own mark when it never named one. The columns follow the display: two
 * on a phone, more as the window grows.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { db } from "@/lib/db"
import { CanvasPage } from "@/routes/canvas"

import { atWidth, botProfile, find, json, mount, seedSettings, until } from "./component-kit.tsx"

const PICTURE = "data:image/svg+xml;base64,PHN2Zy8+"

const PICTURED = {
  id: "x1",
  title: "A pictured checklist",
  session_id: "gots-chat-x1",
  chat_id: "chat-x1",
  version: 3,
  pinned: false,
  archived: false,
  image: PICTURE,
  at: 20,
  created_at: 1,
}

const PLAIN = {
  id: "x2",
  title: "A canvas with no picture",
  session_id: "gots-chat-x2",
  chat_id: "chat-x2",
  version: 1,
  pinned: false,
  archived: false,
  at: 10,
  created_at: 2,
}

function serveCanvases() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.114.0", features: ["canvas"] })
    if (url.pathname.endsWith("/canvases"))
      return json({ object: "gots.canvases", canvases: [PICTURED, PLAIN] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

async function seed() {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas-tiles"))
}

const tile = (id: string) => find(`a[data-canvas-tile][href="/canvas/${id}"]`)
const picture = (id: string) =>
  tile(id)?.querySelector("[data-canvas-tile-image]") as HTMLElement | null

test("a canvas is a tile, with its picture or its own mark", async () => {
  serveCanvases()
  await seed()

  await mount(
    <MemoryRouter initialEntries={["/canvas"]}>
      <CanvasPage />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(tile("x1") && tile("x2")), "both canvases as tiles")

      const grid = find('ul[aria-label="Canvases"]')!
      assert.match(grid.className, /grid-cols-2\b/, "a phone holds two columns")
      assert.equal(
        grid.querySelectorAll(":scope > li a[data-canvas-tile]").length,
        2,
        "each canvas is a tile of the grid",
      )

      // The picture the bot wrote rides the tile as the image itself, and nothing is fetched.
      const pictured = picture("x1")!
      assert.equal(pictured.dataset.canvasTileImage, "picture")
      assert.equal(pictured.querySelector("img")?.getAttribute("src"), PICTURE)
      assert.equal(pictured.querySelector("iframe"), null, "a tile never draws the page itself")

      // A canvas that never named one keeps its own mark, so the tile is still a tile.
      const plain = picture("x2")!
      assert.equal(plain.dataset.canvasTileImage, "mark")
      assert.equal(plain.querySelector("img"), null)
      assert.ok(plain.querySelector("svg"), "the mark is drawn")

      // The line under the name says where the canvas stands.
      assert.match(tile("x1")!.textContent ?? "", /Version 3/)
    },
  )

  // A wider display holds more of them across, and the app doesn't change which canvases they are.
  await atWidth(1440, async () => {
    await mount(
      <MemoryRouter initialEntries={["/canvas"]}>
        <CanvasPage />
      </MemoryRouter>,
      async () => {
        await until(async () => Boolean(tile("x1")), "the tiles at a desktop's width")
        const grid = find('ul[aria-label="Canvases"]')!
        assert.match(grid.className, /xl:grid-cols-4\b/, "a desktop holds four columns across")
        assert.match(grid.className, /sm:grid-cols-3\b/, "a tablet holds three")
      },
    )
  })
})
