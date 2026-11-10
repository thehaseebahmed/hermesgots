/**
 * Canvas on the screen: one page drawn in a frame that can run its own script and reach nothing else,
 * a canvas's chat that is in no list and opens its canvas at its own address (ADR 0113, 0114), and the
 * page redrawn at the version its bot last wrote, with Undo walking back one.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { Link, MemoryRouter, Route, Routes } from "react-router"

import { BRIDGE_MESSAGE, type CanvasDoc } from "@/lib/canvas-bridge"
import { SCROLL_MESSAGE } from "@/lib/canvas-document"
import { refreshCanvas } from "@/lib/canvases"
import { db } from "@/lib/db"
import { pressBack } from "@/lib/native"
import { listsAsChat } from "@/lib/lists-as-chat"
import { connectionKey, noteChange } from "@/lib/live"
import { CanvasEdit, CanvasView } from "@/routes/canvas"
import { ChatPage } from "@/routes/chat"

import {
  Nav,
  atDepth,
  atWidth,
  botProfile,
  click,
  composerField,
  find,
  findText,
  json,
  missing,
  mount,
  nav,
  seedSettings,
  settle,
  text,
  until,
} from "./component-kit.tsx"

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Tip</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
  </head>
  <body><h1>Tip</h1></body>
</html>`

const CANVAS = {
  id: "c1",
  title: "A tip calculator",
  session_id: "gots-chat-1",
  chat_id: "chat-1",
  version: 3,
  pinned: false,
  hidden: false,
  at: 5,
  created_at: 1,
  html: PAGE,
  tools: [],
}

/** A version's page, saying which version it is, so a frame's text names what was drawn. */
const versionPage = (text: string) => PAGE.replace("<h1>Tip</h1>", `<h1>${text}</h1>`)

/** The versions a canvas's screen can be drawn at; the third is the page the first test reads. */
const VERSIONS = new Map<number, string>([
  [1, versionPage("Tip, first")],
  [2, versionPage("Tip, second")],
  [3, PAGE],
  [4, versionPage("Tip, newest")],
])

/** The canvas as its host answers it at one version: that version's document, and whether a version
 * sits under it to undo to. A second canvas is its own record, its own session, its own chat and its
 * own page, so a frame's text names which canvas was drawn. */
const canvasAt = (version: number, id = CANVAS.id, data?: CanvasDoc[]) => ({
  ...CANVAS,
  id,
  title: id === CANVAS.id ? CANVAS.title : `Canvas ${id}`,
  session_id: `gots-chat-${id.slice(1)}`,
  chat_id: `chat-${id.slice(1)}`,
  version,
  // A canvas with no version has nothing to preview: its host answers no document at all.
  html:
    version === 0
      ? ""
      : id === CANVAS.id
        ? (VERSIONS.get(version) ?? PAGE)
        : versionPage(`Canvas ${id}`),
  can_undo: version > 1,
  ...(data ? { data } : {}),
})

interface Host {
  version: number
  undos: number
  /** The documents the host keeps, which its one-canvas read answers. */
  docs?: CanvasDoc[]
  /** Every call a page made, in the order they landed. */
  calls?: { shape: string; args: Record<string, unknown> }[]
  /** Holds the next one-canvas read until it is released, so a slow read can be raced. */
  hold?: () => Promise<void>
  /** Answers a one-canvas read the way a host that never landed does: the request fails. */
  fail?: boolean
  /** The canvases the bot's list names; a canvas of its own is one this file makes for one test. */
  listed?: string[]
}

/**
 * The bot's plugin, as far as a canvas's screen asks it: its features, the list, one canvas, the
 * undo and a page's own data. `host` is the mutable state the answers move with, so a case writes a
 * version by moving it and reads back what a page wrote.
 */
function serveCanvases(host: Host) {
  host.docs ??= []
  host.calls ??= []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.113.0", features: ["canvas"] })
    const call = /\/canvases\/([^/]+)\/call$/.exec(url.pathname)
    if (call) {
      assert.equal(init?.method, "POST", "a page's call is asked for with a POST")
      const body = JSON.parse(String(init?.body)) as {
        shape: string
        args: Record<string, unknown>
      }
      host.calls!.push(body)
      if (body.shape === "data.put") {
        const { collection, id, doc } = body.args as { collection: string; id: string; doc: unknown }
        const result = { collection, id, doc, at: 100 }
        host.docs = [
          ...host.docs.filter((row) => row.collection !== collection || row.id !== id),
          result,
        ]
        return json({ object: "gots.canvas.call", result })
      }
      if (body.shape === "data.remove") {
        const { collection, id } = body.args as { collection: string; id: string }
        const removed = host.docs.some((row) => row.collection === collection && row.id === id)
        host.docs = host.docs.filter((row) => row.collection !== collection || row.id !== id)
        return json({ object: "gots.canvas.call", result: { collection, id, removed } })
      }
      return json({ error: { message: `This host cannot call ${body.shape}.` } }, 501)
    }
    const undo = /\/canvases\/([^/]+)\/undo$/.exec(url.pathname)
    if (undo) {
      assert.equal(init?.method, "POST", "an undo is asked for with a POST")
      host.undos += 1
      host.version -= 1
      return json({ object: "gots.canvas", canvas: canvasAt(host.version, undo[1], host.docs) })
    }
    const one = /\/canvases\/([^/]+)$/.exec(url.pathname)
    if (one) {
      // A host that never landed: the read fails with no answer at all, which is what leaves the
      // canvas read-only and its header saying so (ADR 0071).
      if (host.fail) throw new TypeError("Failed to fetch")
      // A held read answers the documents the host had when it was asked, as a slow read would.
      const asked = host.docs
      if (host.hold) {
        const held = host.hold
        host.hold = undefined
        await held()
        return json({ object: "gots.canvas", canvas: canvasAt(host.version, one[1], asked) })
      }
      return json({ object: "gots.canvas", canvas: canvasAt(host.version, one[1], host.docs) })
    }
    if (/\/canvases$/.test(url.pathname))
      return json({
        object: "gots.canvases",
        canvases: (host.listed ?? ["c1", "c2"]).map((id) => canvasAt(host.version, id)),
      })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

/** The chat records the canvas sessions made: no list draws them, and each names its canvas. */
async function seedCanvasChat(...canvasIds: string[]) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas"))
  await db.messages.clear()
  await db.conversations.clear()
  for (const canvasId of canvasIds) {
    const n = canvasId.slice(1)
    await db.conversations.put({
      id: `chat-${n}`,
      profileId: "bot-1",
      title: canvasId === CANVAS.id ? CANVAS.title : `Canvas ${canvasId}`,
      titleEdited: true,
      hermesSessionId: `gots-chat-${n}`,
      createdAt: 1,
      updatedAt: 2,
      changedAt: 2,
      canvasId,
    })
  }
}

/**
 * Both of a canvas's screens, at their own addresses, with the list behind them and the app's nav
 * beside: the shape every mount in this file walks. `draw` is what the reader does on the screen the
 * entries land on.
 */
async function drawCanvas(
  entries: string[],
  draw: () => Promise<void>,
  index = entries.length - 1,
) {
  await mount(
    <MemoryRouter initialEntries={entries} initialIndex={index}>
      <Routes>
        <Route path="/canvas" element={<div data-canvas-list />} />
        <Route path="/canvas/:id" element={<CanvasView />} />
        <Route path="/canvas/:id/edit" element={<CanvasEdit />} />
      </Routes>
      <Nav />
    </MemoryRouter>,
    draw,
  )
}

test(
  "the frame is sandboxed with allow-scripts only",
  // A phone's screen: from 1024px the canvas draws its chat beside the frame, which neither of these
  // two tests is about — they read the frame and the redirect, so they keep the surface a phone gets.
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(
          () => Boolean(document.querySelector("iframe[data-canvas-frame]")),
          "the frame to draw",
        )
        const frame = document.querySelector("iframe[data-canvas-frame]")!
        // No `allow-same-origin`: the page has an opaque origin and reaches nothing of the app's.
        assert.equal(frame.getAttribute("sandbox"), "allow-scripts")
        const srcdoc = frame.getAttribute("srcdoc") ?? ""
        const head = srcdoc.slice(srcdoc.indexOf("<head"), srcdoc.indexOf("</head>"))
        assert.match(
          head.slice(head.indexOf(">") + 1).trimStart(),
          /^<meta http-equiv="Content-Security-Policy"/,
        )
        assert.match(srcdoc, /connect-src 'none'/)
        assert.match(srcdoc, /frame-src 'none'/)
        // The bot's own page is what is drawn, not a copy of it.
        assert.match(srcdoc, /<h1>Tip<\/h1>/)
        assert.match(srcdoc, /RTCPeerConnection/)
        assert.equal(document.querySelectorAll("iframe").length, 1)
      },
    )
  }),
)

test(
  "a canvas's chat is in no list and its address opens the canvas",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    // The rule every list asks: a chat carrying a canvas is no chat.
    assert.equal(listsAsChat({ canvasId: "c1" }), false)
    assert.equal(listsAsChat({}), true)
    // And its address opens the canvas, not a thread.
    await mount(
      <MemoryRouter initialEntries={["/c/chat-1"]}>
        <Routes>
          <Route path="/c/:id" element={<ChatPage slot="route" />} />
          <Route path="/canvas/:id" element={<div data-canvas-screen />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await settle()
        await until(
          () => Boolean(document.querySelector("[data-canvas-screen]")),
          "the canvas to open",
        )
        assert.ok(missing("[data-thread]"))
      },
    )
  }),
)

test(
  "a canvas event redraws the new version and Undo draws the previous",
  atWidth(390, async () => {
    // The host's answer moves: a version the bot writes, which the plugin notes on the canvas's own
    // session, and then the undo that walks the record's pointer back one.
    const host: Host = { version: 3, undos: 0 }
    serveCanvases(host)
    await seedCanvasChat("c1")
    const bot = (await db.profiles.get("bot-1"))!
    const drawn = () => find("iframe[data-canvas-frame]")?.getAttribute("srcdoc") ?? ""
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => drawn().includes("<h1>Tip</h1>"), "the version on screen")
        assert.ok(find('[data-canvas-flip="edit"]'), "a phone's header offers Edit")
        // The page says where the reader is, as its own frame; the next version opens there.
        const frame = find("iframe[data-canvas-frame]")!
        await act(async () => {
          window.dispatchEvent(
            new window.MessageEvent("message", {
              data: { type: SCROLL_MESSAGE, scroll: 450 },
              source: frame.contentWindow,
            }),
          )
        })
        host.version = 4
        await act(async () => noteChange(connectionKey(bot), "canvas"))
        await until(() => drawn().includes("<h1>Tip, newest</h1>"), "the change to redraw the canvas")
        assert.match(drawn(), /var at=450/, "the redrawn page opens where the reader was")
        await click(find('button[aria-label="Undo"]'))
        await until(() => host.undos === 1, "the host to be asked for the undo")
        await until(() => drawn().includes("<h1>Tip</h1>"), "the version before it to be drawn")
      },
    )
  }),
)

test(
  "a phone's canvas opens on Preview and Edit is an address with a way back",
  async () => {
    // The phone holds one screen at a time: the page, with Edit in the header, or the chat at its own
    // address with Preview. A wide screen has room for both, so the edit address folds into the
    // canvas's own and no flip is drawn there (ADR 0130).
    const phone = async () => {
      serveCanvases({ version: 3, undos: 0 })
      await seedCanvasChat(CANVAS.id)
      const drawn = () => find("iframe[data-canvas-frame]")?.getAttribute("srcdoc") ?? ""
      await drawCanvas([`/canvas/${CANVAS.id}`], async () => {
        await until(() => drawn().includes("<h1>Tip</h1>"), "the canvas's page")
        // The page says where the reader is. Edit unmounts it, and the address that comes back
        // draws the page where they left it.
        const frame = find("iframe[data-canvas-frame]")!
        await act(async () => {
          window.dispatchEvent(
            new window.MessageEvent("message", {
              data: { type: SCROLL_MESSAGE, scroll: 450 },
              source: frame.contentWindow,
            }),
          )
        })
        const edit = find('[data-canvas-flip="edit"]')
        assert.ok(edit, "a canvas with a version opens on the page, with Edit in the header")
        assert.equal(
          edit.getAttribute("aria-label"),
          "Edit",
          "the control names the screen it goes to",
        )
        assert.ok(missing("[data-canvas-edit-pill]"), "the pill is gone")

        await click(edit)
        assert.equal(nav(), `PUSH:/canvas/${CANVAS.id}/edit`, "Edit is a step, pushed")
        await until(() => Boolean(composerField()), "the chat to draw")
        assert.ok(missing("iframe[data-canvas-frame]"), "the edit screen draws no page")
        assert.ok(find('[data-canvas-flip="preview"]'), "its header offers Preview")
        assert.ok(missing('[data-canvas-flip="edit"]'), "and no Edit, which is the screen it is")

        // Back is the edit screen's own: it steps to the canvas's address, not the list.
        const history = atDepth(1)
        try {
          assert.equal(pressBack(), "screen", "the edit screen takes the press")
          assert.deepEqual(history.backs, [1], "and steps back to the canvas's own address")
        } finally {
          history.restore()
        }

        await click(find('[data-canvas-flip="preview"]'))
        await until(() => nav().endsWith(`/canvas/${CANVAS.id}`), "the preview's address again")
        await until(() => Boolean(find("iframe[data-canvas-frame]")), "the page drawn again")
        assert.match(drawn(), /var at=450/, "the page comes back where the reader left it")
      })
    }
    const wide = async () => {
      serveCanvases({ version: 3, undos: 0 })
      await seedCanvasChat(CANVAS.id)
      await drawCanvas([`/canvas/${CANVAS.id}/edit`], async () => {
        await until(
          () => nav() === `REPLACE:/canvas/${CANVAS.id}`,
          "the edit address to fold into the canvas's own",
        )
        await until(() => Boolean(find("iframe[data-canvas-frame]")), "the page to draw")
        assert.ok(composerField(), "the lane draws the chat beside it")
        assert.ok(missing("[data-canvas-flip]"), "a wide screen draws no flip")
      })
    }
    await atWidth(390, phone)()
    await atWidth(1440, wide)()
  },
)

test(
  "the flip draws the page even when the list is the screen behind it",
  atWidth(390, async () => {
    // A canvas the list made opens on its edit screen with the list behind it, and so does one whose
    // address the preview replaced: Preview must draw the page it names rather than step back to the
    // list, which is where a step back lands when no page was ever pushed (`navigate`, ADR 0130).
    serveCanvases({ version: 2, undos: 0 })
    await seedCanvasChat(CANVAS.id)
    await drawCanvas(["/canvas", `/canvas/${CANVAS.id}/edit`], async () => {
      await until(() => Boolean(composerField()), "the edit screen to draw")
      // The list is behind this screen, which is the shape a step back cannot leave: the press has
      // to navigate, and a press that goes back lands on the list with no page ever drawn.
      const history = atDepth(1)
      try {
        await click(find('[data-canvas-flip="preview"]'))
        await until(() => Boolean(find("iframe[data-canvas-frame]")), "the page to be drawn")
        assert.deepEqual(history.backs, [], "Preview navigates rather than stepping back")
        assert.ok(missing("[data-canvas-list]"), "Preview does not fall back to the list")
      } finally {
        history.restore()
      }
    })
  }),
)

test(
  "a canvas with no version opens on Edit and gains Preview when the first version lands",
  async () => {
    // Nothing to preview is said honestly (ADR 0130): a phone replaces the canvas's own address with
    // the edit one — a replace, never a push — and the header's Preview is drawn only once a version
    // is, from the same live record the frame is drawn from.
    const phone = async () => {
      const host: Host = { version: 0, undos: 0 }
      serveCanvases(host)
      await seedCanvasChat(CANVAS.id)
      const bot = (await db.profiles.get("bot-1"))!
      await drawCanvas([`/canvas/${CANVAS.id}`], async () => {
        await until(
          () => nav() === `REPLACE:/canvas/${CANVAS.id}/edit`,
          "the canvas to open on its edit address",
        )
        assert.ok(composerField(), "the chat is what that address draws")
        assert.match(text(), /Your bot is building it…/, "and it says the bot is building it")
        assert.ok(missing("[data-canvas-flip]"), "with nothing to flip to")
        const back = find('[aria-label="All canvases"]')
        assert.ok(back, "the way back to the list is drawn")
        assert.ok(
          back.compareDocumentPosition(find("h1")!) & Node.DOCUMENT_POSITION_FOLLOWING,
          "and it leads the header",
        )

        // The first version lands through the live record: Preview appears where it was absent and
        // the words go, with nothing reloaded.
        host.version = 1
        await act(async () => noteChange(connectionKey(bot), "canvas"))
        await until(() => Boolean(find('[data-canvas-flip="preview"]')), "Preview to appear")
        assert.doesNotMatch(text(), /Your bot is building it…/)
      })
    }
    const wide = async () => {
      // A wide screen already has the chat beside the page, so the lane is where a canvas is built:
      // no address is replaced, and no flip is drawn.
      serveCanvases({ version: 0, undos: 0 })
      await seedCanvasChat(CANVAS.id)
      await drawCanvas([`/canvas/${CANVAS.id}`], async () => {
        await until(() => Boolean(composerField()), "the lane's chat")
        assert.equal(nav(), `POP:/canvas/${CANVAS.id}`, "a wide screen keeps the canvas's address")
        assert.ok(missing("[data-canvas-flip]"), "and the lane draws no flip")
      })
    }
    try {
      await atWidth(390, phone)()
      await atWidth(1440, wide)()
    } finally {
      // The canvas store outlives a test, and the rest of this file opens c1 on a versioned page:
      // leave the version the host really holds behind.
      serveCanvases({ version: 3, undos: 0 })
      await refreshCanvas(CANVAS.id)
    }
  },
)

test(
  "a page that leaves twice is told so, not drawn again for ever",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    const load = async () => {
      const frame = find("iframe[data-canvas-frame]") as HTMLIFrameElement | null
      if (!frame) return
      await act(async () => {
        frame.dispatchEvent(new Event("load"))
      })
    }
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => Boolean(find("iframe[data-canvas-frame]")), "the frame to draw")
        // Each press is the page leaving. It is drawn again once — a new frame — and the escape after
        // that is spent, so the loop ends with the words rather than another frame.
        let drawnAgain = 0
        let previous = find("iframe[data-canvas-frame]")
        for (let press = 0; press < 6 && find("iframe[data-canvas-frame]"); press += 1) {
          await load()
          const now = find("iframe[data-canvas-frame]")
          if (now && now !== previous) drawnAgain += 1
          previous = now
        }
        assert.equal(drawnAgain, 1, "the page that left is drawn again, once")
        await until(
          () => Boolean(document.body.textContent?.includes("keeps trying to leave")),
          "the page that keeps leaving to be said so",
        )
        assert.ok(missing("iframe[data-canvas-frame]"), "the frame is not drawn again")
      },
    )
  }),
)

test(
  "a second canvas opens at its own top",
  atWidth(390, async () => {
    // One screen draws every canvas's address — it is not keyed on the id — so where the first page
    // was scrolled to must not be where the second one is built.
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1", "c2")
    const frame = () => find("iframe[data-canvas-frame]") as HTMLIFrameElement | null
    const drawn = () => frame()?.getAttribute("srcdoc") ?? ""
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Link to="/canvas/c2" data-open-c2>
          Second canvas
        </Link>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => drawn().includes("<h1>Tip</h1>"), "the first canvas to draw")
        // The page says where it has been scrolled to, from its own window: a message from any other
        // window is not the canvas talking.
        const page = frame()?.contentWindow
        assert.ok(page, "the frame has a window of its own")
        await act(async () => {
          window.dispatchEvent(
            new window.MessageEvent("message", {
              data: { type: SCROLL_MESSAGE, scroll: 300 },
              source: page,
            }),
          )
        })
        await click(find("[data-open-c2]"))
        await until(() => drawn().includes("<h1>Canvas c2</h1>"), "the second canvas to open")
        assert.match(drawn(), /var at=0/, "the second canvas is built at its own top")
        assert.doesNotMatch(drawn(), /var at=300/)
      },
    )
  }),
)

test(
  "a canvas's page keeps its own data through the app",
  atWidth(390, async () => {
    // The served canvas carries a document of its own; a write from its frame goes to the host's
    // one route and the host's answer is what the page reads back, while another window's message
    // reaches no route at all.
    const host: Host = {
      version: 3,
      undos: 0,
      docs: [
        { collection: "items", id: "one", doc: { n: 1 }, at: 3 },
        { collection: "notes", id: "a", doc: "hi", at: 4 },
      ],
    }
    serveCanvases(host)
    await seedCanvasChat("c1")
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => Boolean(find("iframe[data-canvas-frame]")), "the frame to draw")
        const page = (find("iframe[data-canvas-frame]") as HTMLIFrameElement).contentWindow
        assert.ok(page, "the frame has a window of its own")
        // What the app posts into the page, read the way the page's own listener reads it. A DOM
        // without a live srcdoc is no page to run the bridge in, so the answer is observed here.
        const posted: { reply: number; ok: boolean; value?: unknown }[] = []
        Object.defineProperty(page, "postMessage", {
          configurable: true,
          value: (data: { reply: number; ok: boolean; value?: unknown }) => posted.push(data),
        })
        const say = (data: unknown, source: MessageEventSource | null = page) =>
          act(async () => {
            window.dispatchEvent(new window.MessageEvent("message", { data, source }))
          })
        const put = (call: number, n: number) => ({
          type: BRIDGE_MESSAGE,
          call,
          method: "put",
          collection: "items",
          id: "one",
          doc: { n },
        })

        // A read from the frame is answered from the copy the served canvas carried.
        await say({ type: BRIDGE_MESSAGE, call: 1, method: "get", collection: "notes", id: "a" })
        await until(() => posted.length > 0, "the read answered from the copy")
        assert.deepEqual(posted[0], {
          type: BRIDGE_MESSAGE,
          reply: 1,
          ok: true,
          value: { collection: "notes", id: "a", doc: "hi", at: 4 },
        })

        // A message from another window is not the canvas talking.
        await say(put(2, 9), window)
        await settle()
        assert.deepEqual(host.calls, [], "no route is asked for another window's message")

        await say(put(3, 7))
        await until(() => (host.calls ?? []).length === 1, "the write to reach the host")
        assert.deepEqual(host.calls?.[0], {
          shape: "data.put",
          args: { collection: "items", id: "one", doc: { n: 7 } },
        })
        await until(() => posted.length > 1, "the host's answer to be posted back")
        assert.deepEqual(posted[1], {
          type: BRIDGE_MESSAGE,
          reply: 3,
          ok: true,
          value: { collection: "items", id: "one", doc: { n: 7 }, at: 100 },
        })

        // The host's answer is the copy the page reads: a read from the frame is answered with it.
        await say({ type: BRIDGE_MESSAGE, call: 4, method: "get", collection: "items", id: "one" })
        await until(() => posted.length > 2, "the read answered from the copy")
        assert.deepEqual(posted[2].value, {
          collection: "items",
          id: "one",
          doc: { n: 7 },
          at: 100,
        })
        assert.equal(host.calls?.length, 1, "a read never goes to the host")
      },
    )
  }),
)

test(
  "an open call from a canvas's page opens a link in the app, once, with no opener",
  atWidth(390, async () => {
    // A canvas's page has no way out of its frame but the app: the one call it makes without being
    // asked is a link the reader tapped, and the app opens it in a tab of its own.
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    // jsdom has no tabs, so the tab a screen asks for is what this test reads.
    const opened: { url: string; target?: string; features?: string }[] = []
    const real = window.open
    window.open = ((url: string | URL, target?: string, features?: string) => {
      opened.push({ url: String(url), target, features })
      return null
    }) as typeof window.open
    try {
      await mount(
        <MemoryRouter initialEntries={["/canvas/c1"]}>
          <Routes>
            <Route path="/canvas/:id" element={<CanvasView />} />
          </Routes>
        </MemoryRouter>,
        async () => {
          await until(() => Boolean(find("iframe[data-canvas-frame]")), "the frame to draw")
          const page = (find("iframe[data-canvas-frame]") as HTMLIFrameElement).contentWindow
          assert.ok(page, "the frame has a window of its own")
          const say = (data: unknown, source: MessageEventSource | null = page) =>
            act(async () => {
              window.dispatchEvent(new window.MessageEvent("message", { data, source }))
            })

          await say({
            type: BRIDGE_MESSAGE,
            call: 1,
            method: "open",
            url: "https://example.com/a",
          })
          await until(() => opened.length > 0, "the link to be opened")
          assert.deepEqual(opened, [
            { url: "https://example.com/a", target: "_blank", features: "noopener,noreferrer" },
          ])

          // Another window's open call is not the canvas talking, and a scheme the app refuses is
          // no link at all: neither opens anything.
          await say(
            { type: BRIDGE_MESSAGE, call: 2, method: "open", url: "https://example.com/elsewhere" },
            window,
          )
          await say({
            type: BRIDGE_MESSAGE,
            call: 3,
            method: "open",
            url: "javascript:alert(1)",
          })
          await settle()
          assert.equal(opened.length, 1, "only the frame's own http(s) link opened")
        },
      )
    } finally {
      window.open = real
    }
  }),
)

test(
  "a read that began before a write cannot put the old copy back",
  atWidth(390, async () => {
    // The page writes while a read is still out: that read carries the copy from before the tap, so
    // it is older than the one the write left and must not reinstate it.
    const host: Host = {
      version: 3,
      undos: 0,
      docs: [{ collection: "items", id: "one", doc: { n: 1 }, at: 3 }],
    }
    serveCanvases(host)
    await seedCanvasChat("c1")
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => Boolean(find("iframe[data-canvas-frame]")), "the frame to draw")
        const page = (find("iframe[data-canvas-frame]") as HTMLIFrameElement).contentWindow
        assert.ok(page, "the frame has a window of its own")
        const posted: { reply: number; ok: boolean; value?: unknown }[] = []
        Object.defineProperty(page, "postMessage", {
          configurable: true,
          value: (data: { reply: number; ok: boolean; value?: unknown }) => posted.push(data),
        })
        const say = (data: unknown) =>
          act(async () => {
            window.dispatchEvent(new window.MessageEvent("message", { data, source: page }))
          })

        // A read the host is slow to answer, holding the copy the canvas opened with. The write waits
        // until the host has been asked, so the read really did begin first.
        let release: () => void = () => {}
        let asked = false
        host.hold = () => {
          asked = true
          return new Promise<void>((done) => (release = done))
        }
        const slow = refreshCanvas("c1")
        await until(() => asked, "the read to reach the host")

        await say({
          type: BRIDGE_MESSAGE,
          call: 1,
          method: "put",
          collection: "items",
          id: "one",
          doc: { n: 7 },
        })
        await until(() => (host.calls ?? []).length === 1, "the write to reach the host")
        await act(async () => release())
        await slow
        await settle()

        // The page reads its document back: what the write stored, not what the slow read carried.
        await say({ type: BRIDGE_MESSAGE, call: 2, method: "get", collection: "items", id: "one" })
        await until(() => posted.some((reply) => reply.reply === 2), "the read answered")
        assert.deepEqual(
          posted.find((reply) => reply.reply === 2)?.value,
          { collection: "items", id: "one", doc: { n: 7 }, at: 100 },
        )
      },
    )
  }),
)

test(
  "the canvas's header control steps back to the list rather than pushing it again",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
        <Nav />
      </MemoryRouter>,
      async () => {
        await until(
          () => Boolean(document.querySelector("iframe[data-canvas-frame]")),
          "the canvas to draw",
        )
        const back = document.querySelector('[aria-label="All canvases"]')
        assert.ok(back, "the header leads back to the list")
        await click(back as HTMLElement)
        await until(() => nav().startsWith("REPLACE:"), "a step back, not another entry")
        assert.equal(nav(), "REPLACE:/canvas")
      },
    )
  }),
)

test(
  "a canvas the list opened steps back to the list",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    const history = atDepth(1)
    try {
      await mount(
        <MemoryRouter initialEntries={["/canvas/c1"]}>
          <Routes>
            <Route path="/canvas/:id" element={<CanvasView />} />
          </Routes>
        </MemoryRouter>,
        async () => {
          await until(
            () => Boolean(document.querySelector("iframe[data-canvas-frame]")),
            "the canvas to draw",
          )
          assert.equal(pressBack(), "screen", "the canvas takes the press")
          assert.deepEqual(history.backs, [1], "and steps back to the list behind it")
        },
      )
    } finally {
      history.restore()
    }
  }),
)

test(
  "a canvas the bot is still building can be managed from its chat",
  atWidth(390, async () => {
    // A canvas with no version opens on the edit screen on a phone, and that is the only screen it
    // has: without the options menu there a reader could never archive it or delete it (ADR 0130).
    serveCanvases({ version: 0, undos: 0, listed: ["c1", "c9"] })
    await seedCanvasChat(CANVAS.id, "c9")
    const history = atDepth(0)
    try {
      await drawCanvas(["/canvas/c9/edit"], async () => {
        await until(() => Boolean(composerField()), "the chat to draw")
        const menu = find('[aria-label="Canvas options"]')
        assert.ok(menu, "the edit screen offers the options menu")
        await click(menu)
        await until(() => Boolean(findText("button", "Delete canvas")), "the options to open")
        await click(findText("button", "Delete canvas"))
        await until(() => Boolean(document.querySelector('[role="alertdialog"]')), "the question")
        const yes = [...document.querySelectorAll('[role="alertdialog"] button')].find(
          (one) => one.textContent === "Delete",
        )
        assert.ok(yes, "the question asks the canvas's own word")
        await click(yes)
        await until(() => nav() === "REPLACE:/canvas", "deleting to leave for the list")
        assert.ok(find("[data-canvas-list]"), "and the list is what is drawn")
      })
    } finally {
      history.restore()
    }
    // The rest of the file draws a versioned canvas again, from a host that answers one.
    serveCanvases({ version: 3, undos: 0 })
  }),
)

test(
  "the edit screen says a canvas is gone, and whose bot is away",
  atWidth(390, async () => {
    // The edit screen is the only screen a phone can draw of these two states, so it says them in
    // the preview's own words rather than drawing an empty chat (ADR 0130).
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat(CANVAS.id)
    await drawCanvas(["/canvas/c8/edit"], async () => {
      await until(() => /This canvas is gone/.test(text()), "the gone sentence")
    })
    // A host that doesn't answer: the preview's header says so, and the edit screen's is that row.
    serveCanvases({ version: 3, undos: 0, fail: true })
    await drawCanvas(["/canvas/c2/edit"], async () => {
      await until(() => Boolean(find("[data-canvas-offline]")), "the header to say its bot is away")
      assert.match(find("[data-canvas-offline]")!.textContent ?? "", /isn't answering/)
    })
    // Leave the host answering for the rest of the file, which opens c2 on its own page.
    serveCanvases({ version: 3, undos: 0 })
    await refreshCanvas("c2")
  }),
)

test(
  "a canvas the menu opened leaves the press to the app",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat("c1")
    const history = atDepth(0)
    try {
      await mount(
        <MemoryRouter initialEntries={["/canvas/c1"]}>
          <Routes>
            <Route path="/canvas/:id" element={<CanvasView />} />
          </Routes>
        </MemoryRouter>,
        async () => {
          await until(
            () => Boolean(document.querySelector("iframe[data-canvas-frame]")),
            "the canvas to draw",
          )
          assert.equal(pressBack(), "app", "the press is the app's, which leaves it")
          assert.deepEqual(history.backs, [], "nothing goes up")
        },
      )
    } finally {
      history.restore()
    }
  }),
)
