/**
 * What the composer does with a message sent while a reply runs, by what it carries: one of files
 * goes to the reply as a steer, and one carrying a photo waits in the queue — which the field's own
 * placeholder says. And how a steer reads back in the thread it joined: what it says, and where it
 * stands when the run read it between two calls.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { Composer } from "@/components/chat/composer"
import { attachmentsText } from "@/lib/attachment-text"
import { db, type Attachment, type Message, type ToolEvent } from "@/lib/db"

import {
  botProfile,
  chatScreen,
  connection,
  findAll,
  find,
  findText,
  json,
  mount,
  seedChat,
  sendPress,
  serveTranscript,
  settle,
  text,
  type,
  until,
} from "./component-kit.tsx"

const bot = connection("composer-steer")

const call = (label: string, startedAt: number, extra: Partial<ToolEvent> = {}): ToolEvent => ({
  toolCallId: `t-${label}`,
  tool: "terminal",
  label,
  status: "completed",
  startedAt,
  endedAt: startedAt + 100,
  ...extra,
})

const calling = (id: string) => ({ id, function: { name: "terminal", arguments: "{}" } })

// jsdom can't decode an image, so a photo has to be one the browser made a bitmap of; scaling
// answers with the file itself for a small photo, so no canvas is needed either.
globalThis.createImageBitmap = (async () => ({
  width: 2,
  height: 2,
  close: () => {},
})) as unknown as typeof createImageBitmap

type Sent = { steer: { text: string; attachments: Attachment[] }[]; queue: string[] }

function composer({ canSteer = true, sent }: { canSteer?: boolean; sent: Sent }) {
  const note =
    (kind: "steer" | "queue") =>
    (text: string, attachments: Attachment[] = []) => {
      if (kind === "steer") sent.steer.push({ text, attachments })
      else sent.queue.push(text)
    }
  return (
    <Composer
      busy
      steerByDefault
      canSteer={canSteer}
      onSteer={note("steer")}
      onQueue={note("queue")}
      onSend={note("queue")}
      onStop={() => {}}
      onCommand={() => {}}
      connection={bot}
      filesFeature="yes"
      imagesAvailable
    />
  )
}

const field = () => find('textarea[aria-label="Message"]')
const placeholder = () => field()?.getAttribute("placeholder")

async function paste(name: string, type: string) {
  const file = new File(["hello"], name, { type, lastModified: 1_700_000_000_000 })
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: { files: [file], items: [{ kind: "file", getAsFile: () => file }] },
  })
  await act(async () => {
    assert.ok(field(), "the field is on screen")
    field()!.dispatchEvent(event)
  })
  await settle()
}

const tiles = () => findAll("[aria-label^='Remove ']").map((one) => one.getAttribute("aria-label"))

test("a message carrying a file steers the reply, and the field says so", async () => {
  const sent: Sent = { steer: [], queue: [] }
  await mount(composer({ sent }), async () => {
    await paste("notes.txt", "text/plain")
    assert.deepEqual(tiles(), ["Remove notes.txt"])
    assert.equal(placeholder(), "Steer the response…", "a file can ride in a steer")
    await type(field(), "read this")
    await sendPress()
    assert.equal(sent.queue.length, 0)
    assert.equal(sent.steer.length, 1, "Enter hands it to the reply that runs")
    assert.equal(sent.steer[0].text, "read this")
    assert.deepEqual(
      sent.steer[0].attachments.map((a) => a.name),
      ["notes.txt"],
      "with the file it carries",
    )
  })
})

test("a message carrying a photo waits in the queue, and the field says so", async () => {
  const sent: Sent = { steer: [], queue: [] }
  await mount(composer({ sent }), async () => {
    await paste("cat.png", "image/png")
    assert.deepEqual(tiles(), ["Remove cat.png"])
    assert.equal(placeholder(), "Queue a message…")
    await type(field(), "look at this")
    assert.equal(placeholder(), "Queue a message…", "and still says it once there are words")
    await sendPress()
    assert.deepEqual(sent.steer, [], "a steer can't carry a photo")
    assert.deepEqual(sent.queue, ["look at this"])
  })
})

test("a file waits in the queue when the reply won't take a steer", async () => {
  const sent: Sent = { steer: [], queue: [] }
  await mount(composer({ canSteer: false, sent }), async () => {
    await paste("notes.txt", "text/plain")
    assert.equal(placeholder(), "Queue a message…")
    await type(field(), "read this")
    await sendPress()
    assert.deepEqual(sent.steer, [])
    assert.deepEqual(sent.queue, ["read this"])
  })
})

test("a steer of a file reads in the thread as what the user wrote", async () => {
  globalThis.fetch = (async () => json({})) as typeof fetch
  const files: Attachment[] = [
    {
      id: "f1",
      name: "notes.txt",
      type: "text/plain",
      size: 2048,
      image: false,
      path: "/host/notes.txt",
    },
  ]
  const messages: Message[] = [
    {
      id: "u1",
      conversationId: "c1",
      role: "user",
      content: "start",
      status: "done",
      createdAt: 1,
    },
    {
      id: "a1",
      conversationId: "c1",
      role: "assistant",
      content: "working on it",
      status: "done",
      createdAt: 2,
      steers: [{ id: "s1", text: attachmentsText("read this", files), contentOffset: 7, at: 3 }],
    },
  ]
  await seedChat({ id: "c1", messages, profile: botProfile("steer-bubble") })
  await mount(chatScreen("c1"), async () => {
    await until(async () => text().includes("Steered"), "the steer in the thread")
    assert.match(text(), /read this/, "the reply shows what the user wrote")
    assert.doesNotMatch(text(), /<attachment/, "not the markers it reached the model as")
  })
})

test("a steer the run read between two calls splits the row of calls there", async () => {
  globalThis.fetch = (async () => json({})) as typeof fetch
  // Both calls stand at the reply's one text offset, the steer's too, and at the turn's own time:
  // only the count says where it stood among them.
  const at = "working on it".length
  const tools: ToolEvent[] = [
    call("ls", 1000, { contentOffset: at }),
    call("pwd", 5000, { contentOffset: at }),
  ]
  const messages: Message[] = [
    {
      id: "u1",
      conversationId: "c1",
      role: "user",
      content: "start",
      status: "done",
      createdAt: 1,
    },
    {
      id: "a1",
      conversationId: "c1",
      role: "assistant",
      content: "working on it",
      status: "done",
      createdAt: 2,
      tools,
      steers: [{ id: "s1", text: "read this", contentOffset: at, toolsBefore: 1, at: 2 }],
    },
  ]
  await seedChat({ id: "c1", messages, profile: botProfile("steer-splits-calls") })
  await mount(chatScreen("c1"), async () => {
    await until(
      () => findAll('[data-slot="tool-group"]').length === 2,
      "a row of calls either side of the steer",
    )
    const [above, below] = findAll('[data-slot="tool-group"]')
    const steer = findText('[data-slot="message-content"]', "read this")
    assert.ok(steer, "the steer is drawn")
    assert.ok(
      above.compareDocumentPosition(steer) & Node.DOCUMENT_POSITION_FOLLOWING,
      "the call it landed after stands above it",
    )
    assert.ok(
      below.compareDocumentPosition(steer) & Node.DOCUMENT_POSITION_PRECEDING,
      "and the call the run made after it stands below",
    )
  })
})

test("a steer this device kept without the run's calls takes the fold's count", async () => {
  // A stream that missed the run's events kept the words, the steer, and no calls: its count is
  // zero whatever the run did, so the transcript's own is the one that places it.
  await seedChat({
    id: "c-merge",
    profile: botProfile("steer-merge"),
    messages: [
      {
        id: "u1",
        conversationId: "c-merge",
        role: "user",
        content: "go",
        status: "done",
        createdAt: 1,
      },
      {
        id: "a1",
        conversationId: "c-merge",
        role: "assistant",
        content: "working on it",
        status: "done",
        createdAt: 2,
        steers: [
          {
            id: "s1",
            text: "also this",
            contentOffset: 7,
            toolsBefore: 0,
            at: 2,
          },
        ],
      },
    ],
  })
  serveTranscript([
    { id: 1, role: "user", content: "go", timestamp: 1 },
    { id: 2, role: "assistant", content: "working on it", timestamp: 2, tool_calls: [calling("a")] },
    { id: 3, role: "tool", content: "ok", tool_call_id: "a", timestamp: 3 },
    { id: 4, role: "user", content: "also this", timestamp: 4, display_kind: "steer" },
    { id: 5, role: "assistant", content: null, timestamp: 5, tool_calls: [calling("b")] },
    { id: 6, role: "tool", content: "/app", tool_call_id: "b", timestamp: 6 },
    { id: 7, role: "assistant", content: "Done.", timestamp: 7, finish_reason: "stop" },
  ])
  await db.conversations.update("c-merge", { updatedAt: 99 })
  await mount(chatScreen("c-merge"), async () => {
    await until(async () => (await db.messages.get("a1"))?.tools?.length === 2, "the calls land")
  })
  await settle()
  const kept = await db.messages.get("a1")
  assert.deepEqual(
    (kept?.steers ?? []).map(({ text, contentOffset, toolsBefore }) => [text, contentOffset, toolsBefore]),
    [["also this", 7, 1]],
    "the count the fold kept, and the offset this device drew its own words at",
  )
})
