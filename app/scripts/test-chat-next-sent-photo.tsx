/**
 * A message sent with a photo (ADR 0111): until the host's transcript names the same turn, the row
 * the send drew is the only copy the thread has, and it must draw the photo as soon as the host has
 * saved it. The paths the upload answered are what its cell is minted from — without them the cell
 * has nothing to draw from and the reader waits for the transcript instead.
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
// The screen polls at its own pace, so the wait is the kit's; the budget stays this screen's, as
// every other chat-next test reads it.
const SOON = 6_000

/** The photo's cell in a message, as the thread draws one: the button a tap opens it from. */
const cell = () => find('[data-chat-next] button[aria-label="Open photo.png"]')

/** What that cell's picture draws from: the URL the host signed, or the bytes this device held. */
const signed = () =>
  cell()?.querySelector("img")?.getAttribute("src") ?? ""

/** Attaches a photo the way a paste does, without sending: the composer's own intake. */
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
  // The transcript's page is held back, so nothing the host says about this turn is drawn: the row
  // the send drew is the thread's only copy of the message, as it is for a chat's first turn.
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
    // The cell draws from the path the host answered — a URL it signs — and not from bytes this
    // device held, which is what the drawn message was missing. The transcript's own copy is out of
    // reach here: the page's read went out before the turn existed, so a host answering it late
    // answers it with nothing.
    const path = host.saved[0].path
    await until(
      async () => signed().includes(encodeURIComponent(path)),
      "the photo's cell to draw from the path the host saved it at",
      SOON,
    )
  })
})
