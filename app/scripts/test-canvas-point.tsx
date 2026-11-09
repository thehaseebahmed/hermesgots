/**
 * Point (flow F6): the canvas's chat arms a point on the page, the page answers the element under the
 * finger, the composer holds a chip for it, and the message the host runs carries the marker line the
 * fold reads back as that chip on the user's bubble (ADR 0116). The point belongs to the canvas's
 * chat alone: a plain thread's composer offers none.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatBody } from "@/chat-next/chat-body"
import { POINT_MESSAGE } from "@/lib/canvas-bridge"
import { refreshCanvas } from "@/lib/canvases"
import { db } from "@/lib/db"
import { pointLine } from "@/lib/point-marker"
import { CanvasView } from "@/routes/canvas"

import { fakeHost } from "./chat-next-host.ts"
import {
  atWidth,
  botProfile,
  click,
  composerField,
  find,
  json,
  missing,
  mount,
  seedSettings,
  settle,
  type,
} from "./component-kit.tsx"

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Tip</title>
  </head>
  <body><h1>Tip</h1><p id="total">Total: 12</p></body>
</html>`

const CANVAS = {
  id: "c1",
  title: "A tip calculator",
  session_id: "gots-chat-1",
  chat_id: "chat-1",
  version: 1,
  pinned: false,
  hidden: false,
  at: 5,
  created_at: 1,
  html: PAGE,
  tools: [],
}

/** What the host answers of a canvas, and the version its page is drawn at. */
interface CanvasHost {
  version: number
}

/** The host's canvas routes, on top of whatever else the faked host answers. */
function serveCanvasOn(chat: string, host: CanvasHost = { version: 1 }) {
  const inner = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info"))
      return json({ version: "0.113.0", features: ["canvas"], chat_next: true })
    const one = /\/canvases\/([^/]+)$/.exec(url.pathname)
    if (one) {
      const page = host.version === 1 ? PAGE : PAGE.replace("<h1>Tip</h1>", "<h1>Tip, again</h1>")
      return json({
        object: "gots.canvas",
        canvas: { ...CANVAS, id: one[1], chat_id: chat, version: host.version, html: page },
      })
    }
    if (/\/canvases$/.test(url.pathname)) return json({ object: "gots.canvases", canvases: [CANVAS] })
    return inner(input, init)
  }) as unknown as typeof fetch
  return host
}

/** The canvas's own chat, as the plugin records it: an ordinary chat that names its canvas. */
async function seedCanvasChat(id: string) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas"))
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put({
    id,
    profileId: "bot-1",
    title: CANVAS.title,
    titleEdited: true,
    hermesSessionId: "gots-chat-1",
    createdAt: 1,
    updatedAt: 2,
    changedAt: 2,
    canvasId: "c1",
  })
}

/** A screen's reads land on their own turns; a case waits on what it asked for being drawn. */
async function until(check: () => boolean, what: string) {
  const by = Date.now() + 8_000
  while (!check() && Date.now() < by) {
    await settle()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
  }
  assert.ok(check(), what)
}

const frame = () => find("iframe[data-canvas-frame]") as HTMLIFrameElement | null
const page = () => frame()?.contentWindow as (Window & { postMessage: unknown }) | null

test(
  "test_point_tags_a_tapped_element_on_the_message",
  atWidth(1440, async () => {
    const host = fakeHost("gots-chat-1")
    serveCanvasOn("chat-1")
    await seedCanvasChat("chat-1")
    // What the screen tells the page, in the order it said it: a point is armed and then let go.
    const told: { type?: string; watch?: boolean }[] = []
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => Boolean(frame() && composerField()), "the page and its chat to draw")
        const inside = page()!
        inside.postMessage = (data: { type?: string; watch?: boolean }) => told.push(data)

        // The composer offers Point, and pressing it asks the page to highlight under the finger.
        await click(find('button[aria-label="Point"]'))
        await until(
          () => told.some((one) => one.type === POINT_MESSAGE && one.watch === true),
          "the page to be told a point is armed",
        )

        // The page answers the element the reader tapped; the composer holds it as a chip.
        await act(async () => {
          window.dispatchEvent(
            new window.MessageEvent("message", {
              data: {
                type: POINT_MESSAGE,
                point: { label: "The total", selector: "#total" },
              },
              source: inside,
            }),
          )
        })
        await until(
          () => find("[data-draft-point]")?.textContent?.includes("The total") ?? false,
          "the tapped element to be held in the composer",
        )
        await until(
          () => told.some((one) => one.type === POINT_MESSAGE && one.watch === false),
          "the page to be let go once it answered",
        )

        // The message the host runs carries the words and a marker line per point.
        await type(composerField(), "Make this bolder")
        await click(find('button[aria-label="Send"]'))
        await until(() => host.asked.runs === 1, "the host to be asked to run the message")
        const sent = JSON.stringify(host.latest.body)
        assert.ok(
          sent.includes(pointLine({ label: "The total", selector: "#total" })),
          "the marker line carries the label and the selector",
        )
        assert.ok(sent.includes("Make this bolder"), "and the words the reader typed")
        assert.ok(missing("[data-draft-point]"), "the chip goes with the message it was taken for")


        // The reply lands, so the thread draws the host's own row: the chip on the bubble, read off
        // the marker line, over the words alone.
        await until(
          () => Boolean(find('button[aria-label="Stop"]')),
          "the thread to be following the run",
        )
        host.latest.run!.finish("Bolder it is.")
        await until(
          () =>
            [...document.querySelectorAll("[data-slot=markdown]")].some((one) =>
              (one.textContent ?? "").includes("Bolder it is."),
            ),
          "the reply to land",
        )
        const bubble = find('[data-slot="message"][data-align="end"]')
        assert.ok(bubble, "the user's message is drawn")
        const chip = bubble.querySelector("[data-point-chip]")
        assert.equal(chip?.textContent?.trim(), "The total", "the bubble's chip names the element")
        assert.equal(chip?.getAttribute("title"), "#total", "and keeps its selector")
        assert.equal(
          bubble.textContent?.includes("[POINT"),
          false,
          "the marker line is no words on the bubble",
        )
        assert.match(bubble.textContent ?? "", /Make this bolder/)
      },
    )
  }),
)

test(
  "a point still armed when the page redraws is told to the new page",
  atWidth(1440, async () => {
    const host = fakeHost("gots-chat-1")
    // The canvas moves to a version the bot wrote, and the frame is redrawn as a new document: a page
    // that was never told it is listening answers no tap, whatever the button says.
    const canvas = serveCanvasOn("chat-1")
    await seedCanvasChat("chat-1")
    const told: { type?: string; watch?: boolean }[] = []
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => Boolean(frame() && composerField()), "the page and its chat to draw")
        page()!.postMessage = (data: { type?: string; watch?: boolean }) => told.push(data)
        await click(find('button[aria-label="Point"]'))
        await until(
          () => told.filter((one) => one.watch === true).length === 1,
          "the page to be told a point is armed",
        )

        canvas.version = 2
        const before = told.filter((one) => one.watch === true).length
        await act(async () => refreshCanvas("c1"))
        await until(
          () => (frame()?.getAttribute("srcdoc") ?? "").includes("Tip, again"),
          "the redrawn page to be drawn",
        )
        // A DOM without a browser runs no page script; the word the page's own half sends when it
        // has started is handed over, to the window the redraw made.
        const redrawn = page()!
        redrawn.postMessage = (data: { type?: string; watch?: boolean }) => told.push(data)
        await act(async () => {
          window.dispatchEvent(
            new window.MessageEvent("message", {
              data: { type: POINT_MESSAGE, ready: true },
              source: redrawn,
            }),
          )
        })
        await until(
          () => told.filter((one) => one.watch === true).length > before,
          "the new page to be told the point is still armed",
        )

        // And the tap on the redrawn page is the chip, as it was before the redraw.
        const inside = redrawn
        await act(async () => {
          window.dispatchEvent(
            new window.MessageEvent("message", {
              data: { type: POINT_MESSAGE, point: { label: "Tip, again", selector: "#total" } },
              source: inside,
            }),
          )
        })
        await until(
          () => find("[data-draft-point]")?.textContent?.includes("Tip, again") ?? false,
          "the redrawn page's answer to be held",
        )
        assert.equal(host.asked.runs, 0, "no turn was sent for this")
      },
    )
  }),
)

test(
  "sending a message ends a press that took no point",
  atWidth(1440, async () => {
    const host = fakeHost("gots-chat-1")
    serveCanvasOn("chat-1")
    await seedCanvasChat("chat-1")
    const told: { type?: string; watch?: boolean }[] = []
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Routes>
          <Route path="/canvas/:id" element={<CanvasView />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await until(() => Boolean(frame() && composerField()), "the page and its chat to draw")
        page()!.postMessage = (data: { type?: string; watch?: boolean }) => told.push(data)
        await click(find('button[aria-label="Point"]'))
        await until(
          () => told.some((one) => one.watch === true),
          "the page to be told a point is armed",
        )
        // A message sent while the page is listening ends the press: the page's own clicks are its
        // own again, and nothing is left armed with no chip to show for it.
        await type(composerField(), "Never mind the element")
        await click(find('button[aria-label="Send"]'))
        await until(() => host.asked.runs === 1, "the host to be asked to run the message")
        await until(
          () => told.some((one) => one.watch === false),
          "the page to be let go by the send",
        )
        assert.equal(
          find('button[aria-label="Point"]')?.getAttribute("aria-pressed"),
          "false",
          "and the button stops saying it is armed",
        )
      },
    )
  }),
)

test(
  "a chat that is not a canvas offers no Point",
  atWidth(1440, async () => {
    const host = fakeHost("gots-chat-1")
    serveCanvasOn("chat-1")
    await seedCanvasChat("chat-1")
    const chat = { ...(await db.conversations.get("chat-1"))!, canvasId: undefined }
    const bot = (await db.profiles.get("bot-1"))!
    assert.equal(host.asked.runs, 0)
    await mount(
      <MemoryRouter>
        <ChatBody
          chat={chat}
          bot={bot}
          summaries={new Set()}
          start={undefined}
          limit={{
            usage: { notice: null, provider: undefined, noticeDismissed: false },
            onView: () => {},
          }}
        />
      </MemoryRouter>,
      async () => {
        await until(() => Boolean(composerField()), "the composer to draw")
        assert.ok(missing('button[aria-label="Point"]'), "a plain chat offers no Point")
      },
    )
  }),
)
