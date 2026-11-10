/**
 * Starting a canvas from a prompt and the files staged with it (ADR 0131): the app mints the chat the
 * canvas is built in, saves each file under the session that chat names — the pair the host itself
 * uses — and hands the host that chat id, those saved records and a run body whose content carries
 * the markers. The prompt stays the reader's own words, because the host titles the canvas and its
 * chat from them, and the screen leaves for the new canvas's Edit address once the host has answered
 * its own record.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes, useParams } from "react-router"

import { db } from "@/lib/db"
import { MAX_ATTACHMENTS } from "@/lib/attachment-caps"
import { CanvasPage } from "@/routes/canvas"

import {
  botProfile,
  click,
  find,
  json,
  mount,
  seedSettings,
  settle,
  type,
  until,
} from "./component-kit.tsx"

const PROMPT = "A tip calculator for a restaurant bill"

/** The record the host answers a start with, on the chat the app named. */
const RECORD = (chatId: unknown) => ({
  id: "c9",
  title: PROMPT,
  version: 0,
  chat_id: chatId,
  session_id: `gots-${String(chatId)}`,
  at: 5,
  created_at: 5,
})

/**
 * The bot's plugin as far as a start asks it: its features, the list the screen opens on, the upload
 * route that saves one file and answers where it put it, and the create that answers a record. What
 * each request carried is kept, so the test reads the session, the prompt, the files and the body
 * back off the wire.
 */
function host() {
  const uploads: { name: string; session: string; type: string; size: number }[] = []
  const creates: Record<string, unknown>[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/info"))
      return json({ version: "0.114.0", features: ["canvas", "attachments"] })
    if (url.pathname.endsWith("/attachments") && init?.method === "POST") {
      const name = url.searchParams.get("name") ?? ""
      const blob = init.body as Blob
      uploads.push({
        name,
        session: /\/sessions\/([^/]+)\//.exec(url.pathname)?.[1] ?? "",
        type: blob.type,
        size: blob.size,
      })
      return json({ name, path: `/host/${name}`, size: blob.size })
    }
    if (url.pathname.endsWith("/canvases") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      creates.push(body)
      return json({ object: "gots.canvas", canvas: RECORD(body.chat_id) }, 202)
    }
    if (url.pathname.endsWith("/canvases")) return json({ object: "gots.canvases", canvases: [] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
  return { uploads, creates }
}

async function seed() {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas-create"))
}

/** The new canvas's own address, drawn as a marker naming what it was opened for. */
function ScreenMarker() {
  const { id } = useParams()
  return <p data-canvas-screen>{`canvas ${id}`}</p>
}

/** A pick from the `+` menu's own file input, the way the browser hands one over. */
async function pick(source: "photos" | "files", files: File[]) {
  const input = document.querySelector(`input[name="${source}"]`)
  assert.ok(input, "the composer's picker is on screen")
  Object.defineProperty(input, "files", { value: files, configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}

const tileNames = () =>
  [...document.querySelectorAll("[aria-label^='Remove ']")].map((button) =>
    button.getAttribute("aria-label")!.replace("Remove ", ""),
  )

async function remove(name: string) {
  const button = [...document.querySelectorAll("button")].find(
    (one) => one.getAttribute("aria-label") === `Remove ${name}`,
  )
  assert.ok(button, `the ${name} tile's remove button`)
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
  })
  await settle()
}

test("a canvas start saves its files under its own session and hands them to the host", async () => {
  const { uploads, creates } = host()
  await seed()

  await mount(
    <MemoryRouter initialEntries={["/canvas"]}>
      <Routes>
        <Route path="/canvas" element={<CanvasPage />} />
        <Route path="/canvas/:id" element={<ScreenMarker />} />
        <Route path="/canvas/:id/edit" element={<ScreenMarker />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await until(() => Promise.resolve(Boolean(find('input[name="photos"]'))), "the + menu")

      await pick("photos", [new File(["png"], "cat.png", { type: "image/png" })])
      await pick("files", [new File(["notes"], "brief.txt", { type: "text/plain" })])
      assert.deepEqual(tileNames(), ["cat.png", "brief.txt"], "two tiles are staged")

      await remove("brief.txt")
      assert.deepEqual(tileNames(), ["cat.png"], "the one taken off is gone")

      await type(find('textarea[aria-label="What the canvas should be"]'), PROMPT)
      await click(find('button[aria-label="Make it"]'))
      await until(() => Promise.resolve(creates.length > 0), "the start to reach the host")

      assert.equal(uploads.length, 1, "only the file still staged goes up")
      assert.equal(uploads[0].name, "cat.png")
      assert.match(uploads[0].session, /^gots-[0-9a-f-]{36}$/, "saved under the chat it minted")

      const create = creates[0]
      assert.equal(create.prompt, PROMPT, "the prompt is the reader's own words")
      assert.equal(`gots-${String(create.chat_id)}`, uploads[0].session, "the chat that session names")
      assert.deepEqual(create.files, [
        {
          name: uploads[0].name,
          type: "image/png",
          size: uploads[0].size,
          path: "/host/cat.png",
        },
      ])

      const run = create.body as { input: { content: unknown }[] }
      assert.ok(
        JSON.stringify(run.input[0].content).includes("<attachment"),
        "the run body carries the marker naming the file",
      )

      // The canvas's own address: the preview is what decides which screen a canvas opens on, so
      // the list hands the new one over rather than picking the chat for it (ADR 0130).
      await until(() => Promise.resolve(Boolean(find("[data-canvas-screen]"))), "the new canvas's address")
      assert.match(find("[data-canvas-screen]")!.textContent ?? "", /canvas c9/)
    },
  )
})

/**
 * A pick whose files are still being read when the next one lands: the change is dispatched without
 * waiting for the screen to settle, which is two picks in flight at once.
 */
function startPick(source: "photos" | "files", files: File[]) {
  const input = document.querySelector(`input[name="${source}"]`)
  assert.ok(input, "the composer's picker is on screen")
  Object.defineProperty(input, "files", { value: files, configurable: true })
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

/** Files of a name and a count, as a pick of that many hands them over. */
const someFiles = (prefix: string, count: number) =>
  Array.from(
    { length: count },
    (_, n) => new File([prefix], `${prefix}-${n}.txt`, { type: "text/plain" }),
  )

test("two picks at once stage no more than the composer's ten", async () => {
  // The create screen shares the composer's count cap, and a pick still being read holds its place
  // in it: two picks of six can no more stage twelve here than in a chat (ADR 0131).
  host()
  await seed()

  await mount(
    <MemoryRouter initialEntries={["/canvas"]}>
      <Routes>
        <Route path="/canvas" element={<CanvasPage />} />
        <Route path="/canvas/:id" element={<ScreenMarker />} />
        <Route path="/canvas/:id/edit" element={<ScreenMarker />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await until(() => Promise.resolve(Boolean(find('input[name="files"]'))), "the + menu")
      // Both dispatched in one turn: the first pick's files are still being read when the second
      // asks how much room is left.
      await act(async () => {
        startPick("files", someFiles("a", 6))
        startPick("files", someFiles("b", 6))
      })
      await settle()
      assert.equal(
        tileNames().length,
        MAX_ATTACHMENTS,
        "the screen holds the composer's ten, not the two picks' twelve",
      )
    },
  )
})

test("the create screen stages the composer's ten, and its own Remove takes one off", async () => {
  // A plain surface takes files as a chat does: the tiles, their Remove and the count are the
  // composer's own, so a canvas start refuses none of them and holds the same ten (ADR 0131).
  host()
  await seed()

  await mount(
    <MemoryRouter initialEntries={["/canvas"]}>
      <Routes>
        <Route path="/canvas" element={<CanvasPage />} />
        <Route path="/canvas/:id" element={<ScreenMarker />} />
        <Route path="/canvas/:id/edit" element={<ScreenMarker />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await until(() => Promise.resolve(Boolean(find('input[name="files"]'))), "the + menu")

      await pick("files", someFiles("a", 2))
      assert.deepEqual(tileNames(), ["a-0.txt", "a-1.txt"], "two files are staged")

      await remove("a-0.txt")
      assert.deepEqual(tileNames(), ["a-1.txt"], "the composer's own Remove takes one off")

      await pick("files", someFiles("b", MAX_ATTACHMENTS + 1))
      assert.equal(
        tileNames().length,
        MAX_ATTACHMENTS,
        "eleven picked onto one hold the composer's ten",
      )
    },
  )
})
