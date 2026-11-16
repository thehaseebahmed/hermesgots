/**
 * A message sent with a photo: until the host's transcript names the same turn, the row the send drew
 * is the only copy the thread has, and it must draw the photo as soon as the host has saved it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { fakeHost } from "./chat-next-host.ts"
import {
  botProfile,
  chatScreen,
  composerField,
  find,
  mount,
  seedChats,
  sendPress,
  settle,
  type,
  until,
} from "./component-kit.tsx"

const bot = botProfile("hermes")
const id = "c-sent-photo"
const pick = { provider: "anthropic", model: "claude-sonnet-5-5" }
const SOON = 6_000

const cell = () =>
  find('[data-chat-next] [data-slot="message"] button[aria-label="Open photo.png"]')

const signed = () =>
  cell()?.querySelector("img")?.getAttribute("src") ?? ""

async function pastePhoto() {
  const field = composerField()
  assert.ok(field, "the composer's field is on screen")
  const file = new File([new Uint8Array(24)], "photo.png", {
    type: "image/png",
    lastModified: 7,
  })
  const event = new Event("paste", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "clipboardData", {
    value: { files: [file], items: [{ kind: "file", getAsFile: () => file }] },
  })
  await act(async () => {
    field.dispatchEvent(event)
  })
  await settle()
}

test("a photo sent with a message draws while the host's transcript is still out", async () => {
  await seedChats([{ id, title: "Sky colours" }], {
    bots: [{ ...bot, baseUrl: `http://${id}.test/v1`, modelChoice: pick }],
  })
  const host = fakeHost(`gots-${id}`, { plugin: true, uploads: true })
  const transcript = host.hold(0)
  await mount(chatScreen(id), async () => {
    await until(async () => Boolean(composerField()), "the app's composer is drawn", SOON)
    await pastePhoto()
    await type(composerField(), "what is in this photo?")
    await sendPress()
    await until(async () => host.saved.length > 0, "the host to save the photo", SOON)
    assert.equal(host.saved[0].name, "photo.png", "the file the message carried")
    assert.equal(host.saved[0].size, 24, "with the bytes it was sent with")
    await until(
      async () => cell() !== null,
      "the photo's cell on the message, before the host's transcript names the turn",
      SOON,
    )
    const path = host.saved[0].path
    await until(
      async () => signed().includes(encodeURIComponent(path)),
      "the photo's cell to draw from the path the host saved it at",
      SOON,
    )
  })
})
