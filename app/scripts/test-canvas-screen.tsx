/**
 * Canvas on the screen: one page drawn in a frame that can run its own script and reach nothing else,
 * a canvas's chat that is in no list and opens its canvas at its own address (ADR 0113, 0114), and the
 * page redrawn at the version its bot last wrote, with Undo walking back one. The edit screen is the
 * chat alone: it draws no page, so it reads the canvas's record and never its document.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { StrictMode, act } from "react"
import { Link, MemoryRouter, Route, Routes } from "react-router"

import { BRIDGE_MESSAGE, POINT_MESSAGE, type CanvasDoc } from "@/lib/canvas-bridge"
import { SCROLL_MESSAGE } from "@/lib/canvas-document"
import { takePoint, keepPoint } from "@/lib/canvas-point-pick"
import { refreshCanvas, refreshCanvases, startCanvas } from "@/lib/canvases"
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
  wordsOf,
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
const canvasAt = (version: number, id = CANVAS.id, data?: CanvasDoc[], at = CANVAS.at) => ({
  ...CANVAS,
  id,
  title: id === CANVAS.id ? CANVAS.title : `Canvas ${id}`,
  session_id: `gots-chat-${id.slice(1)}`,
  chat_id: `chat-${id.slice(1)}`,
  version,
  at,
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
  /** Holds the next list read until it is released, so a screen can be drawn before it lands. */
  holdList?: () => Promise<void>
  /** Answers the list the way a bot that isn't answering does: the request fails. */
  failList?: boolean
  /** Every path the host was asked for, in the order they landed, so a test can read what a screen
   * does and does not ask for. */
  reads?: string[]
  /** The canvases the bot's list names; a canvas of its own is one this file makes for one test. */
  listed?: string[]
  /** The record's change clock the list names, which a version the bot writes moves. */
  at?: number
  /** The canvas a start answers, which is the record alone: a bot writes no page with it. */
  created?: string
  /** The page the one-canvas read answers with, where a case needs one this file's own is not. */
  page?: string
}

/**
 * The bot's plugin, as far as a canvas's screen asks it: its features, the list, one canvas, the
 * undo and a page's own data. `host` is the mutable state the answers move with, so a case writes a
 * version by moving it and reads back what a page wrote.
 */
function serveCanvases(host: Host) {
  host.docs ??= []
  host.calls ??= []
  host.reads ??= []
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
      host.reads!.push(url.pathname)
      // A case may hand the screen a page of its own — one that asks for a library this file's page
      // does not — and the version it draws is that page: the host answers the record it holds.
      const answer = (docs: CanvasDoc[] | undefined) => {
        const canvas = canvasAt(host.version, one[1], docs)
        if (host.page) canvas.html = host.page
        return json({ object: "gots.canvas", canvas })
      }
      if (host.hold) {
        const held = host.hold
        host.hold = undefined
        // A held read answers the documents the host had when it was asked, as a slow read would.
        const asked = host.docs
        await held()
        return answer(asked)
      }
      return answer(host.docs)
    }
    if (/\/canvases$/.test(url.pathname) && init?.method === "POST") {
      // A start: the record alone, which is a canvas the bot has written no version of yet — its
      // answer carries no page at all, as the plugin's carries none.
      const body = JSON.parse(String(init?.body)) as { prompt?: string; chat_id?: string }
      host.reads!.push("POST /canvases")
      const made = canvasAt(0, host.created ?? "c9")
      return json(
        {
          object: "gots.canvas",
          canvas: {
            ...made,
            title: body.prompt ?? made.title,
            chat_id: body.chat_id ?? made.chat_id,
            session_id: `gots-${String(body.chat_id ?? made.chat_id)}`,
          },
        },
        202,
      )
    }
    if (/\/canvases$/.test(url.pathname)) {
      host.reads!.push(url.pathname)
      // A bot that isn't answering: the list is the one read a record-only screen makes, so this is
      // what leaves the edit screen saying its bot is away.
      if (host.failList) throw new TypeError("Failed to fetch")
      const hold = host.holdList
      if (hold) {
        host.holdList = undefined
        await hold()
      }
      return json({
        object: "gots.canvases",
        canvases: (host.listed ?? ["c1", "c2"]).map((id) =>
          canvasAt(host.version, id, undefined, host.at),
        ),
      })
    }
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

/** What a page's own script says when its half of the bridge has run, as a frame hands it over. */
const saysReady = (inside: Window) =>
  act(async () => {
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: POINT_MESSAGE, ready: true },
        source: inside,
      }),
    )
  })

/** A tap on the page: the element the frame answered, from the frame's own window and no other. */
const taps = (inside: Window, label: string, selector: string) =>
  act(async () => {
    window.dispatchEvent(
      new window.MessageEvent("message", {
        data: { type: POINT_MESSAGE, point: { label, selector } },
        source: inside,
      }),
    )
  })

test(
  "a cold edit address says it is reading the canvas",
  atWidth(390, async () => {
    // Nothing of the record has landed yet: the screen draws the preview's own reading line and the
    // way back to the list, rather than a bare header over nothing (ADR 0130). It is the file's
    // first test because that is the only moment the store has read nothing at all.
    const host: Host = { version: 3, undos: 0 }
    serveCanvases(host)
    await seedCanvasChat(CANVAS.id)
    let release: () => void = () => {}
    host.holdList = () => new Promise<void>((done) => (release = done))
    try {
      await drawCanvas([`/canvas/${CANVAS.id}/edit`], async () => {
        await until(() => /Reading the canvas…/.test(text()), "the reading line")
        const back = find('[aria-label="All canvases"]')
        assert.ok(back, "the way back to the list leads the header")
        assert.ok(
          back.compareDocumentPosition(find("h1")!) & Node.DOCUMENT_POSITION_FOLLOWING,
          "and it is drawn before the title",
        )
        assert.ok(missing("[data-canvas-flip]"), "with no flip before there is a record")
        await act(async () => release())
        await settle()
      })
    } finally {
      host.holdList = undefined
      // The held sweep is let go whichever way the assertions went: a read joined to it would
      // otherwise never land, and the test would hang rather than fail.
      await act(async () => release())
      serveCanvases({ version: 3, undos: 0 })
      await refreshCanvas(CANVAS.id)
    }
  }),
)

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
  "the canvas's top bar is Project's top bar",
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
          () => find('[data-slot="header-title"]')?.textContent === CANVAS.title,
          "the canvas's title in the shared header",
        )
        // The canvas's title is the screen's heading, not a span like a conversation's title.
        assert.equal(
          find('[data-slot="header-title"]')?.tagName,
          "H1",
          "the canvas's title is the screen's heading",
        )
        const row = find('[data-slot="header-row"]')
        assert.ok(row, "the header's one row")
        assert.ok(
          row.contains(find('[aria-label="All canvases"]')),
          "the back control sits in the row",
        )
        await until(() => Boolean(find('button[aria-label="Undo"]')), "the Undo the version offers")
        const actions = find('[data-slot="header-actions"]')
        assert.ok(actions, "the row's actions")
        for (const label of ["Undo", "Canvas options"]) {
          const button = actions.querySelector(`button[aria-label="${label}"]`)
          assert.ok(button, `${label} is one of the row's actions`)
          for (const look of [
            "border-border",
            "bg-background/80",
            "backdrop-blur",
            "rounded-full",
          ]) {
            assert.ok(button.className.includes(look), `${label} wears the Project's ${look}`)
          }
        }
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

        // Back is the edit screen's own: it draws the canvas's own address, the screen its Preview
        // names, rather than stepping back to whatever happens to sit behind this one.
        const history = atDepth(1)
        try {
          let pressed = ""
          await act(async () => {
            pressed = pressBack()
          })
          assert.equal(pressed, "screen", "the edit screen takes the press")
          assert.equal(
            nav(),
            `REPLACE:/canvas/${CANVAS.id}`,
            "and draws the canvas's own screen",
          )
          assert.deepEqual(history.backs, [], "without stepping back to the list behind it")
        } finally {
          history.restore()
        }

        await until(() => Boolean(find("iframe[data-canvas-frame]")), "the page drawn by the press")
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
        assert.equal(nav(), `REPLACE:/canvas/${CANVAS.id}`, "Preview replaces this screen")
        assert.deepEqual(history.backs, [], "Preview navigates rather than stepping back")
        assert.ok(missing("[data-canvas-list]"), "Preview does not fall back to the list")
      } finally {
        history.restore()
      }
    })
  }),
)

test(
  "back from the edit screen draws the canvas's own screen, whatever is behind it",
  atWidth(390, async () => {
    // The edit address can sit on the list (a start opens it) or be the only entry (a cold link), so
    // the press is answered by the screen's own rule rather than by the history behind it: a canvas
    // with a version is drawn at its own address, and the press is consumed (ADR 0130).
    serveCanvases({ version: 2, undos: 0 })
    await seedCanvasChat(CANVAS.id)
    const drawn = () => find("iframe[data-canvas-frame]")?.getAttribute("srcdoc") ?? ""
    const press = async () => {
      let pressed = ""
      await act(async () => {
        pressed = pressBack()
      })
      return pressed
    }

    // The list behind it: a step back would land there, and the page would never be drawn.
    await drawCanvas(["/canvas", `/canvas/${CANVAS.id}/edit`], async () => {
      await until(() => Boolean(composerField()), "the edit screen to draw")
      const history = atDepth(1)
      try {
        assert.equal(await press(), "screen", "the edit screen takes the press")
        assert.equal(nav(), `REPLACE:/canvas/${CANVAS.id}`, "and draws the canvas's own address")
        assert.deepEqual(history.backs, [], "never stepping back to the list")
      } finally {
        history.restore()
      }
      await until(() => drawn().includes("<h1>Tip, second</h1>"), "the page to be drawn")
      assert.ok(missing("[data-canvas-list]"), "and the list is not what it fell back to")
    })

    // And the only entry: the press is the screen's, not the app's to leave on.
    await drawCanvas([`/canvas/${CANVAS.id}/edit`], async () => {
      await until(() => Boolean(composerField()), "the edit address to draw")
      const history = atDepth(0)
      try {
        assert.equal(await press(), "screen", "the edit screen answers the press, not the app")
        assert.equal(nav(), `REPLACE:/canvas/${CANVAS.id}`, "and draws the canvas's own address")
      } finally {
        history.restore()
      }
      await until(() => drawn().includes("<h1>Tip, second</h1>"), "the page to be drawn")
    })
  }),
)

test(
  "a canvas no bot holds offers no Edit",
  atWidth(390, async () => {
    // There is no chat to flip to: the canvas the address names is one no bot has (ADR 0130), so the
    // header says so and offers nothing that would open a screen of it.
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat(CANVAS.id)
    await drawCanvas(["/canvas/c8"], async () => {
      await until(() => /This canvas is gone/.test(text()), "the gone sentence")
      assert.ok(missing("[data-canvas-flip]"), "and no Edit for a canvas that isn't there")
    })
  }),
)

test(
  "a canvas with no version whose bot is away is not said to be building",
  atWidth(390, async () => {
    // A host that isn't answering is not a bot that is building: the edit screen says the preview's
    // own sentence for a canvas whose record isn't here and whose bot can't be asked for it, which is
    // the one true thing it knows (ADR 0130). The edit screen reads the record, so a bot that is away
    // is a list that didn't answer — and a canvas this device never read has no chat to draw either.
    serveCanvases({ version: 0, undos: 0, failList: true, listed: ["c1", "c6"] })
    await seedCanvasChat("c1", "c6")
    await drawCanvas(["/canvas/c6/edit"], async () => {
      await until(
        () => /isn't on this device, and its bot isn't answering/.test(text()),
        "the away sentence",
      )
      assert.doesNotMatch(text(), /Your bot is building it…/, "and not the building one")
    })
    // Leave the store with a host that answers again, for the rest of the file.
    serveCanvases({ version: 3, undos: 0 })
    await refreshCanvas("c1")
  }),
)

test(
  "a canvas with no version opens on Edit and gains Preview when the first version lands",
  async () => {
    // Nothing to preview is said honestly (ADR 0130): a phone replaces the canvas's own address with
    // the edit one — a replace, never a push — and the header's Preview is drawn only once a version
    // is, from the same live record the frame is drawn from. A canvas of its own, which this device
    // has drawn no copy of: the one earlier cases read at a version is not a canvas with none.
    const BUILT = "c4"
    const phone = async () => {
      const host: Host = { version: 0, undos: 0, listed: [BUILT] }
      serveCanvases(host)
      await seedCanvasChat(BUILT)
      const bot = (await db.profiles.get("bot-1"))!
      await drawCanvas([`/canvas/${BUILT}`], async () => {
        await until(
          () => nav() === `REPLACE:/canvas/${BUILT}/edit`,
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
      serveCanvases({ version: 0, undos: 0, listed: [BUILT] })
      await seedCanvasChat(BUILT)
      await drawCanvas([`/canvas/${BUILT}`], async () => {
        await until(() => Boolean(composerField()), "the lane's chat")
        assert.equal(nav(), `POP:/canvas/${BUILT}`, "a wide screen keeps the canvas's address")
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
  "deleting a canvas from its edit screen lands on the list",
  atWidth(390, async () => {
    // The canvas the reader is on is the one that just went, so the screen behind it is no screen:
    // deleting draws the list in this entry's place, from either screen (ADR 0130).
    serveCanvases({ version: 2, undos: 0, listed: ["c1", "c7"] })
    await seedCanvasChat("c1", "c7")
    const history = atDepth(1)
    try {
      await drawCanvas(["/canvas/c7", "/canvas/c7/edit"], async () => {
        await until(() => Boolean(composerField()), "the edit screen to draw")
        await click(find('[aria-label="Canvas options"]'))
        await until(() => Boolean(findText("button", "Delete canvas")), "the options to open")
        await click(findText("button", "Delete canvas"))
        await until(() => Boolean(document.querySelector('[role="alertdialog"]')), "the question")
        const yes = [...document.querySelectorAll('[role="alertdialog"] button')].find(
          (one) => one.textContent === "Delete",
        )
        assert.ok(yes, "the question asks the canvas's own word")
        await click(yes)
        await until(() => nav() === "REPLACE:/canvas", "deleting to leave for the list")
        assert.deepEqual(history.backs, [], "and never stepping back to the canvas it deleted")
        assert.ok(find("[data-canvas-list]"), "the list is what is drawn")
      })
    } finally {
      history.restore()
    }
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
    // A record-only screen never asks for the page, so the away bot is a list that didn't answer.
    serveCanvases({ version: 3, undos: 0, failList: true })
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

/** A version's line in the header, which is the one thing a screen drawing no page still says. */
const headerLine = () => wordsOf(find('[data-slot="header-line"]'))

/** Every one-canvas read the host was asked for: the page, which no record-only screen may ask for. */
const pageReads = (host: Host) =>
  (host.reads ?? []).filter((path) => /\/canvases\/[^/]+$/.test(path))

test(
  "the edit screen shows a version the bot writes, with nothing reloaded",
  atWidth(390, async () => {
    // The edit screen draws no page, so the record is what it reads: a version the bot writes is a
    // `canvas` change, and the sweep the change starts is what moves the header's line.
    const host: Host = { version: 3, undos: 0 }
    serveCanvases(host)
    await seedCanvasChat(CANVAS.id)
    const bot = (await db.profiles.get("bot-1"))!
    try {
      await drawCanvas([`/canvas/${CANVAS.id}/edit`], async () => {
        await until(() => Boolean(composerField()), "the edit screen to draw")
        await until(() => /v3/.test(headerLine()), "the version the record points at")
        host.version = 4
        await act(async () => noteChange(connectionKey(bot), "canvas"))
        await until(() => /v4/.test(headerLine()), "the new version, with no reload")
        assert.doesNotMatch(headerLine(), /v3/, "and not the one it drew first")
      })
    } finally {
      // The store outlives a test: leave the version the host really holds behind.
      serveCanvases({ version: 3, undos: 0 })
      await refreshCanvas(CANVAS.id)
    }
  }),
)

test(
  "the edit screen says a canvas no bot holds is gone",
  atWidth(390, async () => {
    // A canvas the bot's list doesn't name is one no bot holds, and the edit screen is the only
    // screen a phone can draw of that state — so it says so rather than drawing an empty chat.
    const host: Host = { version: 3, undos: 0, listed: [CANVAS.id] }
    serveCanvases(host)
    await seedCanvasChat(CANVAS.id)
    await drawCanvas(["/canvas/c5/edit"], async () => {
      await until(() => /This canvas is gone/.test(text()), "the gone sentence")
      assert.ok(missing('[data-canvas-flip="preview"]'), "with nothing to flip to")
      assert.ok(
        missing('[aria-label="Canvas options"]'),
        "and no options for a canvas that isn't there",
      )
    })
    assert.deepEqual(pageReads(host), [], "said from the list alone")
  }),
)

test(
  "the edit screen reads the record and never the page",
  atWidth(390, async () => {
    // The edit screen draws no page: a read of it is the list's sweep, never the document, which can
    // be 256 KB and is no fact the header or the chat reads. The version only this host's list names
    // is what proves the sweep answered, on the screen's own first read.
    const host: Host = { version: 6, undos: 0 }
    // Whatever the screen before this one left in flight lands first, so the read counted here is
    // this screen's.
    await settle()
    serveCanvases(host)
    await seedCanvasChat(CANVAS.id)
    try {
      await drawCanvas([`/canvas/${CANVAS.id}/edit`], async () => {
        await until(() => Boolean(composerField()), "the edit screen to draw")
        await until(() => /v6/.test(headerLine()), "the list's record to be drawn")
        assert.ok(
          (host.reads ?? []).some((path) => /\/canvases$/.test(path)),
          "the list is what the screen reads",
        )
        assert.deepEqual(pageReads(host), [], "and the page is never asked for")
      })
    } finally {
      serveCanvases({ version: 3, undos: 0 })
      await refreshCanvas(CANVAS.id)
    }
  }),
)

test(
  "a created canvas's page draws once the list reports its first version",
  atWidth(390, async () => {
    // A start answers the record alone: the bot has written no version, so the answer carries no
    // page, and the phone lands on that canvas's chat. The bot writes version 1 next, and the list
    // is what reports it — a copy of the start's answer held as this canvas's page would shadow that
    // record, so the preview would read version 0, replace its own address with the edit one, and
    // the page would never be drawn. A record with no document is no page to hold, and a copy older
    // than the list's record is no copy to serve.
    const host: Host = { version: 0, undos: 0, listed: ["c9"], created: "c9" }
    serveCanvases(host)
    await seedCanvasChat("c9")
    const bot = (await db.profiles.get("bot-1"))!
    const started = await startCanvas(bot, "A checklist for the deck")
    assert.equal(started.id, "c9", "the start's own canvas is the one that is read")
    assert.equal(started.version, 0, "a start answers a canvas with no version")
    assert.equal(started.html, "", "and no page to draw")

    // The first version lands on the host, and its record's clock with it: the list is the read that
    // says so, as the edit screen's own (a record-only screen) never asks for a page.
    host.version = 1
    host.at = 6
    await refreshCanvases()

    const drawn = () => find("iframe[data-canvas-frame]")?.getAttribute("srcdoc") ?? ""
    try {
      await drawCanvas([`/canvas/${started.id}`], async () => {
        await act(async () => noteChange(connectionKey(bot), "canvas"))
        assert.equal(nav(), "POP:/canvas/c9", "the canvas's own address is never replaced by Edit")
        await until(
          () => drawn().includes("<h1>Canvas c9</h1>"),
          "the first version's page to draw",
        )
        assert.ok(
          find('[data-canvas-flip="edit"]'),
          "and the header offers Edit, a version being drawn",
        )
      })
    } finally {
      // The store outlives a test: the rest of the file reads c1 at the version the host holds.
      serveCanvases({ version: 3, undos: 0 })
      await refreshCanvas(CANVAS.id)
    }
  }),
)

/**
 * Pointing from the edit screen (flow F6, the phone's half): the edit screen draws no page, so its
 * Point row sends the reader to the page with pointing armed; the page answers the element under the
 * finger, and the chat that asked comes back holding it as a chip it can send or take off.
 */
test(
  "the edit screen's + sheet sends the reader to the page to point",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat(CANVAS.id)
    await drawCanvas([`/canvas/${CANVAS.id}/edit`], async () => {
      await until(() => Boolean(composerField()), "the edit screen to draw")
      assert.ok(find('[data-canvas-flip="preview"]'), "its corner is the way to the page")
      await click(find('button[aria-label="Add context"]'))
      await until(
        () => Boolean(find('button[aria-label="Point at the page"]')),
        "the + sheet to offer Point",
      )
      await click(find('button[aria-label="Point at the page"]'))
      // The row is not a flip: the address is replaced by the page's pointing one, so the reader
      // lands on the page with pointing armed and no step of this screen's left behind.
      assert.equal(
        nav(),
        `REPLACE:/canvas/${CANVAS.id}?point=1`,
        "the press replaces this screen with the page's pointing address",
      )
      await until(() => Boolean(find("[data-point-banner]")), "the page, waiting for a tap")
      assert.ok(find("iframe[data-canvas-frame]"), "the page itself is drawn")
      assert.ok(
        missing('[data-canvas-flip="preview"]'),
        "and the edit screen's corner went with the screen it belonged to",
      )
    })
  }),
)

test(
  "the page opened to point says so, and answers with the chat's address",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat(CANVAS.id)
    // Cancel is the reader changing their mind: the chat they came from, and nothing kept.
    await drawCanvas([`/canvas/${CANVAS.id}?point=1`], async () => {
      await until(() => Boolean(find("[data-point-banner]")), "the line the address asks for")
      assert.match(wordsOf(find("[data-point-banner]")), /Tap an element on the page/)
      const inside = find("iframe[data-canvas-frame]")!.contentWindow!
      // The page is armed through the chat's own listener, and an arm that went out before its
      // script ran is said again when the page says it is ready.
      const told: { type?: string; watch?: boolean }[] = []
      ;(inside as unknown as { postMessage: unknown }).postMessage = (data: {
        type?: string
        watch?: boolean
      }) => told.push(data)
      await saysReady(inside)
      await until(
        () => told.some((one) => one.type === POINT_MESSAGE && one.watch === true),
        "the page to be told a point is armed",
      )
      await click(find("[data-point-banner] button")!)
      await until(() => nav() === `REPLACE:/canvas/${CANVAS.id}/edit`, "Cancel to leave for the chat")
      assert.equal(takePoint(CANVAS.id), undefined, "and to keep nothing")
      assert.ok(missing("[data-point-banner]"), "with no banner left on the chat")
    })
    // A tap on the page is the answer: the chat it was picked for is drawn again, in its place.
    await drawCanvas([`/canvas/${CANVAS.id}?point=1`], async () => {
      await until(() => Boolean(find("iframe[data-canvas-frame]")), "the page to draw")
      await taps(find("iframe[data-canvas-frame]")!.contentWindow!, "The total", "#total")
      await until(
        () => nav() === `REPLACE:/canvas/${CANVAS.id}/edit`,
        "the answered element to leave for the chat",
      )
    })
    // A wide screen has the chat beside the page, so the ask names no screen to go to: the address is
    // put back to the canvas's own, and an old link leaves no banner over the lane's page.
    await atWidth(1440, async () => {
      await drawCanvas([`/canvas/${CANVAS.id}?point=1`], async () => {
        await until(() => nav() === `REPLACE:/canvas/${CANVAS.id}`, "the ask dropped where it is moot")
        assert.ok(missing("[data-point-banner]"), "with no banner over the page")
        assert.ok(composerField(), "and the chat beside it still the place to point from")
      })
    })()
  }),
)

test(
  "an element picked on the page is the edit screen's chip, which can be taken off",
  atWidth(390, async () => {
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat(CANVAS.id)
    await drawCanvas([`/canvas/${CANVAS.id}/edit`], async () => {
      await until(() => Boolean(composerField()), "the edit screen to draw")
      await click(find('button[aria-label="Add context"]'))
      await until(
        () => Boolean(find('button[aria-label="Point at the page"]')),
        "the + sheet to offer Point",
      )
      await click(find('button[aria-label="Point at the page"]'))
      await until(() => Boolean(find("[data-point-banner]")), "the page opened to point")
      await taps(find("iframe[data-canvas-frame]")!.contentWindow!, "The total", "#total")
      // Back on the edit screen the element is already the field's chip — the reader keeps typing
      // around it, and the send takes it, which is what the chip on the field is for.
      await until(() => Boolean(composerField()), "the edit screen, drawn again")
      await until(
        () => find("[data-draft-point]")?.textContent?.includes("The total") ?? false,
        "the picked element to be the field's chip",
      )
      assert.equal(
        find("[data-draft-point]")!.getAttribute("title"),
        "#total",
        "with the selector that finds it again",
      )
      assert.ok(
        find('button[aria-label="Send"]')?.hasAttribute("disabled") === false,
        "a message carrying only a point can be sent",
      )
      await click(find('button[aria-label="Remove the point on The total"]'))
      await settle()
      assert.ok(missing("[data-draft-point]"), "the chip's cross takes it off the field")
      assert.ok(
        find('button[aria-label="Send"]')?.hasAttribute("disabled"),
        "and an empty field with no point has nothing to send",
      )
    })
  }),
)

test(
  "a canvas with no page offers no Point at all",
  atWidth(390, async () => {
    // There is nothing to point at until a version is drawn, so the edit screen — the only screen a
    // phone draws of a canvas with no version — offers no row that could only lead to an empty page.
    serveCanvases({ version: 0, undos: 0, listed: [CANVAS.id] })
    await seedCanvasChat(CANVAS.id)
    try {
      await drawCanvas([`/canvas/${CANVAS.id}/edit`], async () => {
        await until(() => Boolean(composerField()), "the edit screen to draw")
        await click(find('button[aria-label="Add context"]'))
        await until(() => Boolean(findText("button", "Camera")), "the + sheet to draw")
        assert.ok(
          missing('button[aria-label="Point at the page"]'),
          "a canvas with no page offers no Point",
        )
      })
    } finally {
      // The store outlives a test: the rest of the file draws c1 at the version the host holds.
      serveCanvases({ version: 3, undos: 0 })
      await refreshCanvas(CANVAS.id)
    }
  }),
)

test(
  "a chip taken on arrival survives the dev double render",
  atWidth(390, async () => {
    // The app draws under StrictMode in development, where a state initialiser is called twice: React
    // keeps the first answer, and the hand-over is one trip — the second call finds nothing and is
    // thrown away. A composer that drew its field from the second call would arrive empty in
    // development and full in a build, which is exactly the kind of difference no test in this tier
    // would otherwise see.
    serveCanvases({ version: 3, undos: 0 })
    await seedCanvasChat(CANVAS.id)
    keepPoint(CANVAS.id, { label: "The total", selector: "#total" })
    await mount(
      <StrictMode>
        <MemoryRouter initialEntries={[`/canvas/${CANVAS.id}/edit`]}>
          <Routes>
            <Route path="/canvas/:id/edit" element={<CanvasEdit />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
      async () => {
        await until(() => Boolean(composerField()), "the edit screen to draw")
        await until(
          () => Boolean(find("[data-draft-point]")),
          "the chip the chat arrived with, drawn once",
        )
        assert.match(find("[data-draft-point]")!.textContent ?? "", /The total/)
        assert.equal(takePoint(CANVAS.id), undefined, "and the hand-over is spent, not re-readable")
      },
    )
  }),
)

test(
  "a page asking for leaflet draws its script, its stylesheet and its markers",
  atWidth(390, async () => {
    // Leaflet is the one library a page is handed more than a source: its stylesheet names its
    // images relative to itself, which a srcdoc page resolves nowhere, and its default marker's
    // images are named by its JavaScript rather than by its CSS. So the page draws leaflet's
    // stylesheet in its head, the setup right after the source, and every marker image as a `data:`
    // URI — which is what `img-src data:` already allows.
    const page = PAGE.replace(
      "<title>Tip</title>",
      '<title>Tip</title>\n    <script data-canvas-lib="leaflet"></script>',
    ).replace("<h1>Tip</h1>", '<h1>Tip</h1>\n    <div id="map" style="height: 240px"></div>')
    serveCanvases({ version: 3, undos: 0, page })
    await seedCanvasChat(CANVAS.id)
    try {
      await mount(
        <MemoryRouter initialEntries={[`/canvas/${CANVAS.id}`]}>
          <Routes>
            <Route path="/canvas/:id" element={<CanvasView />} />
          </Routes>
        </MemoryRouter>,
        async () => {
          await until(
            () => Boolean(document.querySelector("iframe[data-canvas-frame]")),
            "the frame to draw",
          )
          const srcdoc =
            document.querySelector("iframe[data-canvas-frame]")!.getAttribute("srcdoc") ?? ""
          // The ask is answered where the page put it, with leaflet's own source…
          assert.match(srcdoc, /window\.L=/, "leaflet's source takes the ask's place")
          assert.equal(srcdoc.includes("data-canvas-lib"), false, "and no ask is left behind")
          // …its stylesheet hoisted into the head, with every image a data: URI…
          const head = srcdoc.slice(srcdoc.indexOf("<head"), srcdoc.indexOf("</head>"))
          assert.match(head, /\.leaflet-container\b/, "leaflet's stylesheet is in the head")
          assert.equal(
            (head.match(/url\("data:image\/png;base64,/g) ?? []).length,
            3,
            "the stylesheet's three images are data: URIs",
          )
          assert.equal(/url\(images\//.test(srcdoc), false, "no relative image URL survives")
          assert.ok(
            head.indexOf(".leaflet-container") > head.indexOf("color-scheme"),
            "after the theme and the compiled classes",
          )
          assert.ok(
            head.indexOf(".leaflet-container") < head.indexOf("<title>Tip</title>"),
            "and before anything the page wrote, so the page's own style still wins",
          )
          // …and the default marker pointed at data: URIs of the same kind, right after the source.
          const setup = srcdoc.indexOf("L.Icon.Default.mergeOptions")
          assert.ok(setup > 0, "the setup prelude is in the document")
          assert.match(
            srcdoc.slice(setup),
            /^L\.Icon\.Default\.mergeOptions\(\{iconUrl:"data:image\/png;base64,[^"]+",iconRetinaUrl:"data:image\/png;base64,[^"]+",shadowUrl:"data:image\/png;base64,[^"]+"\}\)/,
            "the default marker's icon, retina image and shadow are data: URIs",
          )
          const opens = srcdoc.lastIndexOf("</script><script>", setup)
          assert.ok(
            opens > srcdoc.indexOf("window.L="),
            "the setup's script opens where the source's ends",
          )
          assert.match(
            srcdoc.slice(opens + "</script><script>".length, setup),
            /^\/\*[^<]*$/,
            "and nothing but the setup's own words sits between the source and the call",
          )
        },
      )
    } finally {
      // The store outlives a test: the rest of the file draws c1 at the version the host holds.
      serveCanvases({ version: 3, undos: 0 })
      await refreshCanvas(CANVAS.id)
    }
  }),
)

