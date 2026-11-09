/**
 * A room's message and a member's reply carry media (F5).
 *
 * The Host's room store is the only place a room's bytes live, so a row's attachment is drawn from an
 * address the plugin signs and nothing here fetches the file into the app: the screen builds the
 * chat's own MediaItems over the row, and a tap opens the app's Previewer. A room whose Host never
 * advertises `room_media` draws no gallery and offers no file to attach.
 *
 * The cap is the Host's, not the chat's: a room's message takes eight files, and the bytes of one
 * already stored are not sent again by a retry — both are the wire this file watches.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"
import { toast } from "sonner"

import { PreviewerProvider } from "@/components/chat/previewer"
import { RoomChat } from "@/components/room/room-chat"
import { db, type Profile } from "@/lib/db"
import {
  atWidth,
  botProfile,
  click,
  find,
  json,
  missing,
  mount,
  seedSettings,
  settle,
  spyOpen,
  until,
  wordsOf,
} from "./component-kit.tsx"

const ROOM = "room-1"
const BOT = "bot-1"
const AT = Date.now()

const members = [
  { memberId: "m1", profile: "default", handle: "hermes", displayName: "Hermes" },
  { memberId: "m2", profile: "coder", handle: "coder", displayName: "Coder" },
]

const chart = {
  attachmentId: "at1",
  kind: "image",
  name: "chart.png",
  size: 2048,
  mime: "image/png",
}
const brief = {
  attachmentId: "at2",
  kind: "pdf",
  name: "brief.pdf",
  size: 4096,
  mime: "application/pdf",
}

interface Call {
  path: string
  body: Record<string, unknown> | null
}

/** What one mint is answered with: an address and the seconds it is worth, or a status refusing it. */
type Minted = { url?: string; life?: number; status?: number }

let log: Record<string, unknown>[] = []
const calls: Call[] = []
/** Every file the room's store was handed, in the order it was put there. */
const uploads: { uploadId: string; name: string }[] = []
/** Every upload the composer attempted, the ones the Host refused included. */
const attempts: { uploadId: string; name: string }[] = []
/** The address every mint answers with, so a test can say what a tap hands over. */
const SIGNED = "http://room-media.test/signed/chart.png?token=t"

function read() {
  return {
    object: "gots.room",
    room: { id: ROOM, name: "Planning", members },
    events: log,
    cursor: log.at(-1)?.seq ?? 0,
    latestSeq: log.at(-1)?.seq ?? 0,
    hasMore: false,
    working: false,
    activity: [],
    waiting: [],
    canStop: true,
    canSend: true,
  }
}

function host(
  features: string[],
  name: string,
  {
    mint,
    send,
    upload,
  }: {
    /** What the n-th mint answers, where a test asks for a spent address or a missing file. */
    mint?: (count: number) => Minted
    /** What the n-th send answers: an event, or the status the Host refuses it with. */
    send?: (count: number) => number | Record<string, unknown> | undefined
    /** What the n-th upload answers where the Host refuses a file, in its own words. */
    upload?: (count: number) => { status: number; message: string } | undefined
  } = {},
) {
  const base = `http://${name}.test/v1`
  let mints = 0
  let sends = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    // A file's own bytes are the upload's body, so only the JSON routes are read here.
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null
    if (url.pathname.endsWith("/plugins/gots/info")) return json({ name: "gots", features })
    if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}`) && method === "GET")
      return json(read())
    if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}/attachment/url`)) {
      calls.push({ path: url.pathname, body })
      mints += 1
      const answer = mint?.(mints)
      if (answer?.status) return json({ error: { message: "No such file." } }, answer.status)
      return json({
        object: "gots.room.attachment_url",
        path: `room/${ROOM}/${String(body?.event_id)}/${String(body?.attachment_id)}`,
        url: answer?.url ?? SIGNED,
        expires: Math.floor(Date.now() / 1000) + (answer?.life ?? 600),
      })
    }
    if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}/attachment`) && method === "POST") {
      const uploadId = url.searchParams.get("upload_id") ?? ""
      const file = url.searchParams.get("name") ?? ""
      attempts.push({ uploadId, name: file })
      const refused = upload?.(attempts.length)
      if (refused) return json({ error: { message: refused.message } }, refused.status)
      uploads.push({ uploadId, name: file })
      return json({
        object: "gots.room.attachment",
        attachment: { ...chart, attachmentId: `up${uploads.length}`, name: file },
      })
    }
    if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}/send`)) {
      calls.push({ path: url.pathname, body })
      sends += 1
      const answer = send?.(sends)
      if (typeof answer === "number")
        return json({ error: { message: "The room is busy." } }, answer)
      return json({
        object: "gots.room.sent",
        event: answer ?? {
          seq: 9,
          eventId: "e9",
          kind: "message.user",
          text: "",
          attachments: [chart],
        },
      })
    }
    return json({}, 404)
  }) as typeof fetch
  return base
}

/** Every mint the screen asked for, and what it named. */
const mints = () => calls.filter((call) => call.path.endsWith("/attachment/url"))
/** Every message the room was sent, and what it carried. */
const sends = () => calls.filter((call) => call.path.endsWith("/send"))

async function fresh(events: Record<string, unknown>[], base: string) {
  log = events
  calls.length = 0
  uploads.length = 0
  attempts.length = 0
  await seedSettings({ onboarded: true })
  await db.profiles.clear()
  const bot: Profile = botProfile("room-media", {
    id: BOT,
    name: "Hermes",
    baseUrl: base,
    apiKey: "test-key",
    hermesProfile: "default",
  })
  await db.profiles.put(bot)
  await db.conversations.clear()
  await db.roomLog.clear()
  await db.conversations.put({
    id: ROOM,
    profileId: BOT,
    title: "Planning",
    room: { id: ROOM, members },
    createdAt: AT - 60_000,
    updatedAt: AT,
    changedAt: AT,
  })
  await settle()
}

const screen = () => (
  <MemoryRouter initialEntries={[`/c/${ROOM}`]}>
    <PreviewerProvider>
      <Routes>
        <Route path="/c/:id" element={<RoomChat id={ROOM} slot="route" />} />
      </Routes>
    </PreviewerProvider>
  </MemoryRouter>
)

const cell = (name: string) =>
  document.querySelector(`button[aria-label="Open ${name}"]`) as HTMLButtonElement | null
const row = (name: string) =>
  document.querySelector(`button[aria-label="Download ${name}"]`) as HTMLButtonElement | null
const attachButton = () =>
  document.querySelector('button[aria-label^="Add context"]') as HTMLButtonElement | null
const tileNames = () =>
  [...document.querySelectorAll("[aria-label^='Remove ']")].map((button) =>
    button.getAttribute("aria-label")!.replace("Remove ", ""),
  )

/** A file dropped onto the composer, the way the browser hands one over. */
async function drop(files: File[]) {
  const form = document.querySelector("form")
  assert.ok(form, "the composer is on screen")
  const event = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } })
  await act(async () => {
    form.dispatchEvent(event)
  })
  await settle()
}

const note = (name: string) =>
  new File(["bytes"], name, { type: "text/plain", lastModified: 1_700_000_000_000 })

const sendButton = () =>
  [...document.querySelectorAll("button")].find(
    (one) => one.getAttribute("aria-label") === "Send",
  ) as HTMLButtonElement | undefined

test(
  "a member's reply draws its file as a Gallery cell, and a tap opens the Previewer",
  atWidth(1024, async () => {
    const base = host(["rooms", "room_media"], "room-media")
    await fresh(
      [
        {
          seq: 1,
          eventId: "e1",
          kind: "message.member",
          text: "the chart",
          memberId: "m1",
          name: "Hermes",
          attachments: [chart],
        },
      ],
      base,
    )
    await mount(screen(), async () => {
      await until(async () => cell("chart.png") !== null, "the reply's gallery cell")
      assert.deepEqual(
        calls[0],
        {
          path: `/api/plugins/gots/rooms/${ROOM}/attachment/url`,
          body: { event_id: "e1", attachment_id: "at1" },
        },
        "the address is minted for the room, the event and the file",
      )
      await click(cell("chart.png"))
      await until(async () => find('[data-slot="previewer-photo"]') !== null, "the Previewer")
      const picture = find('[data-slot="previewer-photo"]')!.querySelector("img")
      assert.equal(picture?.getAttribute("src"), SIGNED, "drawn from the address the plugin signed")
    })
  }),
)

test(
  "the user's own message draws the file the Host stored, above their words",
  atWidth(1024, async () => {
    const base = host(["rooms", "room_media"], "room-media-user")
    await fresh(
      [
        { seq: 1, eventId: "e1", kind: "message.user", text: "here it is", attachments: [chart] },
        {
          seq: 2,
          eventId: "e2",
          kind: "message.member",
          text: "seen",
          memberId: "m1",
          name: "Hermes",
        },
      ],
      base,
    )
    await mount(screen(), async () => {
      await until(async () => cell("chart.png") !== null, "the user's gallery cell")
      const sent = document.querySelector('[data-slot="room-row"][data-kind="user"]')!
      assert.ok(sent.contains(cell("chart.png")), "the cell belongs to the user's own row")
      const words = [...sent.querySelectorAll("p")].find((one) => wordsOf(one) === "here it is")
      assert.ok(words, "the user's words are drawn")
      assert.ok(
        cell("chart.png")!.compareDocumentPosition(words!) & Node.DOCUMENT_POSITION_FOLLOWING,
        "a sent file sits above the words",
      )
    })
  }),
)

test(
  "a file the Previewer can't draw is a row the platform opens at the Host's address",
  atWidth(1024, async () => {
    const base = host(["rooms", "room_media"], "room-media-file")
    await fresh(
      [
        {
          seq: 1,
          eventId: "e1",
          kind: "message.member",
          text: "the brief",
          memberId: "m1",
          name: "Hermes",
          attachments: [brief],
        },
      ],
      base,
    )
    const tabs = spyOpen()
    try {
      await mount(screen(), async () => {
        await until(async () => row("brief.pdf") !== null, "the file's row")
        await click(row("brief.pdf"))
        await until(async () => tabs.opened.length > 0, "the platform to be handed the file")
        assert.deepEqual(
          tabs.opened,
          [SIGNED],
          "a room's file has no host path: its read is what is opened",
        )
      })
    } finally {
      tabs.restore()
    }
  }),
)

test(
  "a tap asks for an address of its own, however spent the one the row was drawn from",
  atWidth(1024, async () => {
    const SPENT = "http://room-media.test/signed/brief.pdf?token=spent"
    const FRESH = "http://room-media.test/signed/brief.pdf?token=fresh"
    // The room's first mint answers an address that has already run out — a row drawn when the room
    // opened, tapped ten minutes later — and every mint after it a live one.
    const base = host(["rooms", "room_media"], "room-media-tap", {
      mint: (count) => (count === 1 ? { url: SPENT, life: -60 } : { url: FRESH }),
    })
    await fresh(
      [
        {
          seq: 1,
          eventId: "e1",
          kind: "message.member",
          text: "the brief",
          memberId: "m1",
          name: "Hermes",
          attachments: [brief],
        },
      ],
      base,
    )
    const tabs = spyOpen()
    try {
      await mount(screen(), async () => {
        await until(async () => row("brief.pdf") !== null, "the file's row")
        assert.equal(mints().length, 1, "one address, minted while the row drew")
        await click(row("brief.pdf"))
        await until(async () => tabs.opened.length > 0, "the platform to be handed the file")
        assert.deepEqual(
          tabs.opened,
          [FRESH],
          "the address minted at the tap, not the spent one the row was drawn from",
        )
        assert.equal(mints().length, 2, "a second address, asked for where the tap is")
        assert.deepEqual(
          mints()[1].body,
          { event_id: "e1", attachment_id: "at2" },
          "for the same room, event and file",
        )
      })
    } finally {
      tabs.restore()
    }
  }),
)

test(
  "a file the Host has no copy of draws no row, rather than a row that can never fill",
  atWidth(1024, async () => {
    const base = host(["rooms", "room_media"], "room-media-gone", {
      mint: () => ({ status: 404 }),
    })
    await fresh(
      [
        {
          seq: 1,
          eventId: "e1",
          kind: "message.member",
          text: "the brief",
          memberId: "m1",
          name: "Hermes",
          attachments: [brief],
        },
      ],
      base,
    )
    await mount(screen(), async () => {
      await until(
        async () => document.querySelector('[data-slot="room-row"]') !== null,
        "the reply's row",
      )
      await until(async () => mints().length > 0, "the ask the row made")
      await settle()
      assert.equal(
        mints().length,
        1,
        "a route that answered 404 is settled: the file is asked for once, and no more",
      )
      assert.ok(
        missing('button[aria-label="Download brief.pdf"]'),
        "the Host settled the file with a 404, so there is nothing to download",
      )
      assert.match(document.body.textContent ?? "", /the brief/, "the reply's words still draw")
    })
  }),
)

test(
  "a room's message takes eight files: the ninth is refused here, in the Host's own number",
  atWidth(1024, async () => {
    const base = host(["rooms", "room_media"], "room-media-cap")
    await fresh([{ seq: 1, eventId: "e1", kind: "message.user", text: "go" }], base)
    const said: string[] = []
    const original = toast.error
    toast.error = ((message: unknown) => {
      said.push(String(message))
    }) as typeof toast.error
    try {
      await mount(screen(), async () => {
        await until(async () => attachButton() !== null, "the composer's `+`")
        await drop(Array.from({ length: 9 }, (_, index) => note(`note-${index}.txt`)))
        await until(async () => tileNames().length > 0, "the tiles")
        assert.equal(tileNames().length, 8, "the Host's cap, not a chat's ten")
        assert.deepEqual(
          said,
          ["A message can carry 8 attachments, so 1 was left out."],
          "the refusal names the number a room's message may carry",
        )
      })
    } finally {
      toast.error = original
    }
  }),
)

test(
  "a retry after a failed send names the file it already stored instead of uploading it again",
  atWidth(1024, async () => {
    const base = host(["rooms", "room_media"], "room-media-retry", {
      // The first send is refused; the message goes back into the field, and the second is taken.
      send: (count) => (count === 1 ? 500 : undefined),
    })
    await fresh([{ seq: 1, eventId: "e1", kind: "message.user", text: "go" }], base)
    await mount(screen(), async () => {
      await until(async () => attachButton() !== null, "the composer's `+`")
      await drop([new File(["png"], "chart.png", { type: "image/png", lastModified: 5 })])
      await until(async () => tileNames().length === 1, "the file's tile")
      const field = document.querySelector("textarea") as HTMLTextAreaElement
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
        setter?.call(field, "here it is")
        field.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await settle()
      await click(sendButton() ?? null)
      await until(async () => sends().length === 1, "the send the Host refused")
      // The refused message comes back into the field with the file it carried, ready to send again.
      await until(async () => tileNames().length === 1, "the message handed back")
      await click(sendButton() ?? null)
      await until(async () => sends().length === 2, "the retry")

      assert.equal(uploads.length, 1, "the file went up once, and the retry re-sent neither byte")
      assert.deepEqual(
        sends()[1].body?.attachments,
        sends()[0].body?.attachments,
        "the retry names the manifest the Host answered the first time",
      )
      assert.deepEqual(
        sends()[1].body?.event_id,
        sends()[0].body?.event_id,
        "and it is the same message, not a second one",
      )
    })
  }),
)

test(
  "a room whose Host takes media offers a file to attach",
  atWidth(1024, async () => {
    const base = host(["rooms", "room_media"], "room-media-attach")
    await fresh([{ seq: 1, eventId: "e1", kind: "message.user", text: "who is free?" }], base)
    await mount(screen(), async () => {
      await until(async () => attachButton() !== null, "the composer's `+`")
    })
  }),
)

test(
  "a Host that never advertises room_media offers no file, and draws no gallery",
  atWidth(1024, async () => {
    const base = host(["rooms"], "room-media-off")
    await fresh(
      [
        {
          seq: 1,
          eventId: "e1",
          kind: "message.member",
          text: "the chart",
          memberId: "m1",
          name: "Hermes",
          attachments: [chart],
        },
      ],
      base,
    )
    await mount(screen(), async () => {
      await until(
        async () => document.querySelector('[data-slot="room-row"]') !== null,
        "the room's row",
      )
      assert.ok(
        missing('button[aria-label^="Add context"]'),
        "no file to attach where the Host has no store for it",
      )
      assert.ok(missing('button[aria-label="Open chart.png"]'), "and nothing draws a cell")
    })
  }),
)

test(
  "a file the Host refuses turns its tile red and says why, and sending again says it again",
  atWidth(1024, async () => {
    const REFUSED = "deck.zip is larger than the 2 MB limit for a room attachment."
    const base = host(["rooms", "room_media"], "room-media-refused", {
      upload: () => ({ status: 413, message: REFUSED }),
    })
    await fresh([{ seq: 1, eventId: "e1", kind: "message.user", text: "go" }], base)
    const said: string[] = []
    const original = toast.error
    toast.error = ((message: unknown) => {
      said.push(String(message))
    }) as typeof toast.error
    try {
      await mount(screen(), async () => {
        await until(async () => attachButton() !== null, "the composer's `+`")
        await drop([new File(["zip"], "deck.zip", { type: "application/zip", lastModified: 5 })])
        await until(async () => tileNames().length === 1, "the file's tile")
        const field = document.querySelector("textarea") as HTMLTextAreaElement
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value",
          )?.set
          setter?.call(field, "and the deck")
          field.dispatchEvent(new Event("input", { bubbles: true }))
        })
        await settle()
        await click(sendButton() ?? null)
        await until(async () => attempts.length === 1, "the upload the Host refused")
        // The file stays staged, marked with the Host's own sentence, and can still be taken off.
        await until(
          async () => document.querySelector("[data-refused]") !== null,
          "the refused tile",
        )
        const tile = document.querySelector("[data-refused]") as HTMLElement
        assert.equal(tile.getAttribute("aria-invalid"), "true", "the tile is marked invalid")
        assert.equal(tile.getAttribute("title"), REFUSED, "and carries the Host's sentence")
        assert.deepEqual(said, [REFUSED], "the refusal is a toast, in the Host's own words")
        assert.ok(
          missing('[role="alert"]'),
          "a refused file is a toast and its own tile, not a banner over the composer",
        )
        assert.ok(
          document.querySelector('[aria-label="Remove deck.zip"]'),
          "the file can be taken off the message",
        )
        // Sending again asks the Host again, and says the same words again.
        await click(sendButton() ?? null)
        await until(async () => attempts.length === 2, "the second upload")
        await until(async () => said.length === 2, "the refusal said again")
        assert.deepEqual(said, [REFUSED, REFUSED], "a retry says it again")
      })
    } finally {
      toast.error = original
    }
  }),
)
