/**
 * What a reader's gesture does to the photo in the Previewer, read from the transform drawn on it:
 * the style they see, not a component's state.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import type { Attachment, Message } from "@/lib/db"

import {
  botProfile,
  chatScreen,
  click,
  labelled,
  mediaHost,
  mount,
  seedChat,
  until,
} from "./component-kit.tsx"

const HOST = "/home/h/.hermes/memento/attachments/session-1"

const photo = (name: string, id: string): Attachment => ({
  id,
  name,
  type: "image/png",
  size: 1024,
  image: true,
  blob: new Blob(["png bytes"], { type: "image/png" }),
  path: `${HOST}/${name}`,
})

const message = (attachments: Attachment[]): Message => ({
  id: "m1",
  conversationId: "c1",
  role: "user",
  content: "look",
  status: "done",
  createdAt: 2,
  attachments,
})

const shown = () => document.querySelector('[role="dialog"] img')
const drawn = () =>
  (document.querySelector('[data-slot="previewer-photo"]') as HTMLElement | null)?.style.transform ??
  ""

/** A finger on the photo, as the browser reports one: it lands on the picture and bubbles up. */
const finger = (type: string, id: number, x: number, y: number) => {
  shown()!.dispatchEvent(
    new window.PointerEvent(type, {
      bubbles: true,
      pointerId: id,
      pointerType: "touch",
      isPrimary: id === 1,
      clientX: x,
      clientY: y,
    }),
  )
}

const tap = async (x: number, y: number) => {
  await act(async () => {
    finger("pointerdown", 1, x, y)
    finger("pointerup", 1, x, y)
  })
}

const open = async (name: string) => {
  await until(async () => labelled("button", `Open ${name}`) !== null, "the photo's cell")
  await click(labelled("button", `Open ${name}`))
  await until(() => shown() !== null, "the photo in the Previewer")
}

test("a double tap magnifies the photo at the point tapped, and the next one puts it back", async () => {
  const profile = botProfile("zoom-double-tap")
  await seedChat({ id: "c1", profile, messages: [message([photo("cat.png", "cat")])] })
  mediaHost({ host: "zoom-double-tap" })
  await mount(chatScreen("c1"), async () => {
    await open("cat.png")
    assert.match(drawn(), /scale\(1\)/, "a photo opens at its own shape")

    await tap(160, 200)
    await tap(161, 201)
    assert.match(drawn(), /scale\(2\.5\)/, "two taps in one place magnify it to reading size")

    await tap(160, 200)
    await tap(161, 201)
    assert.match(drawn(), /scale\(1\)/, "and the next two return the whole frame")
  })
})

test("a pinch magnifies the photo by the fingers' own spread", async () => {
  const profile = botProfile("zoom-pinch")
  await seedChat({ id: "c1", profile, messages: [message([photo("cat.png", "cat")])] })
  mediaHost({ host: "zoom-pinch" })
  await mount(chatScreen("c1"), async () => {
    await open("cat.png")
    await act(async () => {
      finger("pointerdown", 1, 100, 200)
      finger("pointerdown", 2, 200, 200)
      finger("pointermove", 2, 300, 200)
    })
    assert.match(drawn(), /scale\(2\)/, "the spread doubled the photo")

    await act(async () => {
      finger("pointermove", 2, 100, 200)
    })
    assert.match(drawn(), /scale\(1\)/, "a pinch that closes over is the whole frame again")
  })
})

test("stepping to another photo starts it at its own shape", async () => {
  const profile = botProfile("zoom-step")
  await seedChat({
    id: "c1",
    profile,
    messages: [message([photo("cat.png", "cat"), photo("dog.png", "dog")])],
  })
  mediaHost({ host: "zoom-step" })
  await mount(chatScreen("c1"), async () => {
    await open("cat.png")
    await tap(160, 200)
    await tap(161, 201)
    assert.match(drawn(), /scale\(2\.5\)/, "the first photo is magnified")
    await click(labelled("button", "Next"))
    await until(() => shown()?.getAttribute("alt") === "dog.png", "the second photo")
    assert.match(drawn(), /scale\(1\)/, "and the next one opens at its own shape")
  })
})

test("closing the Previewer and opening it again starts at its own shape", async () => {
  const profile = botProfile("zoom-reopen")
  await seedChat({ id: "c1", profile, messages: [message([photo("cat.png", "cat")])] })
  mediaHost({ host: "zoom-reopen" })
  await mount(chatScreen("c1"), async () => {
    await open("cat.png")
    await tap(160, 200)
    await tap(161, 201)
    assert.match(drawn(), /scale\(2\.5\)/)
    await click(labelled("button", "Close"))
    await until(() => shown() === null, "the Previewer closed")
    await open("cat.png")
    assert.match(drawn(), /scale\(1\)/, "the same photo opens at its own shape again")
  })
})
