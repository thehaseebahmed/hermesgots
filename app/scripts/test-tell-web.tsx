/**
 * What the app says in passing on the web: the page's own toaster, in the tone each caller asked
 * for. No phone is stood in for, so `tell` sits on the one road a browser has. It runs in the
 * component tier because `lib/tell` imports through the app's `@/` alias, which only that tier
 * resolves.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { saidDuring, spyToaster } from "./toaster-spy.ts"

test("the four tones are the toaster's own four", async () => {
  const { tell } = await import("@/lib/tell")
  const heard = await saidDuring(() => {
    tell.error("Couldn't save that.")
    tell.info("Canvas deleted.")
    tell.success("Saved.")
    tell.note("Network log copied")
  })
  assert.deepEqual(
    heard.map((one) => `${one.tone}: ${one.text}`),
    [
      "error: Couldn't save that.",
      "info: Canvas deleted.",
      "success: Saved.",
      "note: Network log copied",
    ],
    "each one says its words in the tone it asked in, the note with no tone at all",
  )
})

test("a note that asks to be held is held for the long toast's span", async () => {
  const { tell } = await import("@/lib/tell")
  const heard = await saidDuring(() => tell.note("Press back again to exit", { long: true }))
  assert.deepEqual(
    heard.map((one) => one.data?.duration),
    [3500],
    "the page is handed the same three and a half seconds the phone's long toast lasts",
  )
})

test("a note that asks for nothing is the toaster's default life", async () => {
  const { tell } = await import("@/lib/tell")
  const heard = await saidDuring(() => tell.note("Network log copied"))
  assert.deepEqual(
    heard.map((one) => one.data),
    [undefined],
    "nothing is timed for it, so the toaster's own lifetime stands",
  )
})

test("leaving takes the notice away in the page", async () => {
  const { tell } = await import("@/lib/tell")
  const toaster = spyToaster()
  try {
    tell.dismiss()
    assert.equal(toaster.dismissed, 1, "the toaster is asked to take it away")
    assert.deepEqual(toaster.heard, [], "and nothing new is drawn")
  } finally {
    toaster.restore()
  }
})
