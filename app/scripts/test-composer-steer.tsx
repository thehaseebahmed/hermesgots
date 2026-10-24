/**
 * What the composer does with a message sent while a reply runs, by what it carries: one of files
 * goes to the reply as a steer, and one carrying a photo waits in the queue — which the composer
 * says, in the field's own voice and in one line under it. And how a steer of files reads back in
 * the thread it joined.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { Composer } from "@/components/chat/composer"
import { attachmentsText } from "@/lib/attachment-text"
import type { Attachment, Message } from "@/lib/db"

import {
  botProfile,
  chatScreen,
  connection,
  findAll,
  find,
  json,
  mount,
  seedChat,
  settle,
  text,
  type,
  until,
} from "./component-kit.tsx"

const bot = connection("composer-steer")

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
      files="yes"
      imagesAvailable
    />
  )
}

const field = () => find('textarea[aria-label="Message"]')
const placeholder = () => field()?.getAttribute("placeholder")
const hint = () => find("[data-queue-hint]")?.textContent ?? ""

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

async function enter() {
  await act(async () => {
    field()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    )
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
    assert.equal(hint(), "", "and nothing says otherwise, since it does steer")
    await type(field(), "read this")
    await enter()
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

test("a message carrying a photo waits in the queue, and the composer says so", async () => {
  const sent: Sent = { steer: [], queue: [] }
  await mount(composer({ sent }), async () => {
    await paste("cat.png", "image/png")
    assert.deepEqual(tiles(), ["Remove cat.png"])
    assert.equal(placeholder(), "Queue a message…")
    assert.match(hint(), /A steer is text alone/, "the composer says where this one goes")
    assert.match(text(), /waits in the queue/)
    await type(field(), "look at this")
    assert.match(hint(), /A steer is text alone/, "and still says it once there are words")
    await enter()
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
    await enter()
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
