/**
 * What the app says in passing inside the Android app: the phone's own toast, and the page's toaster
 * when the build predates the plugin or the bridge refuses. Capacitor answers the platform from the
 * page's bridge, and `isNative` is read once as the app's modules load, so the phone is stood in for
 * before anything imports the app's copy of it. It runs in the component tier because `lib/tell`
 * imports through the app's `@/` alias, which only that tier resolves.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { saidDuring, spyToaster } from "./toaster-spy.ts"

const calls: { call: string; options: Record<string, unknown> }[] = []

let phone: "shows" | "refuses" | "silent" = "shows"

Object.assign(globalThis, {
  // What makes `Capacitor.getPlatform()` answer `android`, and `isNative` true with it.
  androidBridge: {},
  Capacitor: {
    PluginHeaders: [
      {
        name: "Toast",
        methods: [
          { name: "show", rtype: "promise" },
          { name: "hide", rtype: "promise" },
        ],
      },
    ],
    nativePromise: async (plugin: string, method: string, options: Record<string, unknown>) => {
      calls.push({ call: `${plugin}.${method}`, options })
      if (phone === "refuses") throw new Error("bridge gone")
      // A call the phone took and never answered: the shape a WebView torn down mid-call has.
      if (phone === "silent") return new Promise<void>(() => {})
    },
  },
})

async function said(run: () => void) {
  calls.length = 0
  const page = await saidDuring(run)
  return { page, asked: [...calls] }
}

test("an error is the phone's own toast, long", async () => {
  const { tell } = await import("@/lib/tell")
  const { page, asked } = await said(() => tell.error("Couldn't save that."))
  assert.deepEqual(
    asked,
    [{ call: "Toast.show", options: { text: "Couldn't save that.", long: true } }],
    "the phone's own toast, held there about twice as long",
  )
  assert.deepEqual(page, [], "and the page's toaster says nothing beside it")
})

test("a note is the phone's own toast, short", async () => {
  const { tell } = await import("@/lib/tell")
  const { page, asked } = await said(() => tell.note("Network log copied"))
  assert.deepEqual(
    asked,
    [{ call: "Toast.show", options: { text: "Network log copied", long: false } }],
    "the phone's own toast, and one that goes as quickly as it came",
  )
  assert.deepEqual(page, [], "and the page's toaster says nothing beside it")
})

test("a note that asks to be held is long", async () => {
  const { tell } = await import("@/lib/tell")
  const { page, asked } = await said(() => tell.note("Press back again to exit", { long: true }))
  assert.deepEqual(
    asked,
    [{ call: "Toast.show", options: { text: "Press back again to exit", long: true } }],
    "the one note whose words are timed asks for the long toast",
  )
  assert.deepEqual(page, [], "and the page's toaster says nothing beside it")
})

test("an info and a success are short too", async () => {
  const { tell } = await import("@/lib/tell")
  const { asked } = await said(() => {
    tell.info("Canvas deleted.")
    tell.success("Saved.")
  })
  assert.deepEqual(
    asked.map((one) => one.options.long),
    [false, false],
    "only an error is long unless a note asks",
  )
})

test("words with nothing in them are nothing to say", async () => {
  const { tell } = await import("@/lib/tell")
  const { page, asked } = await said(() => tell.error("   "))
  assert.deepEqual(asked, [], "the phone is asked for nothing")
  assert.deepEqual(page, [], "and the page draws no empty box")
})

test("a phone with no Toast plugin still says it in the page", async () => {
  const { tell } = await import("@/lib/tell")
  const bridge = (globalThis as { Capacitor: { isPluginAvailable: () => boolean } }).Capacitor
  const real = bridge.isPluginAvailable
  bridge.isPluginAvailable = () => false
  try {
    const { page, asked } = await said(() => tell.error("Couldn't save that."))
    assert.deepEqual(asked, [], "nothing is asked of a plugin that isn't there")
    assert.deepEqual(
      page.map((one) => one.text),
      ["Couldn't save that."],
      "and the message is not left unsaid",
    )
  } finally {
    bridge.isPluginAvailable = real
  }
})

test("a bridge that refuses the call says it in the page, once", async () => {
  const { tell } = await import("@/lib/tell")
  phone = "refuses"
  try {
    const { page, asked } = await said(() => tell.error("Couldn't save that."))
    assert.equal(asked.length, 1, "the phone was asked exactly once")
    assert.deepEqual(
      page.map((one) => one.text),
      ["Couldn't save that."],
      "and the words are said once, in the page",
    )
  } finally {
    phone = "shows"
  }
})

test("a phone that never answers still says it in the page", { timeout: 20_000 }, async () => {
  const { tell, TELL_LONG_MS } = await import("@/lib/tell")
  phone = "silent"
  const toaster = spyToaster()
  calls.length = 0
  try {
    tell.error("Couldn't save that.")
    // The span under test is the seam's own patience, so the test waits it out.
    await new Promise((resolve) => setTimeout(resolve, TELL_LONG_MS + 200))
    assert.equal(calls.length, 1, "the phone was asked once")
    assert.deepEqual(
      toaster.heard.map((one) => one.text),
      ["Couldn't save that."],
      "and the words reach the page rather than going unsaid",
    )
  } finally {
    toaster.restore()
    phone = "shows"
  }
})

test("leaving takes the notice away on the phone", async () => {
  const { tell } = await import("@/lib/tell")
  const toaster = spyToaster()
  calls.length = 0
  try {
    tell.dismiss()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(calls, [{ call: "Toast.hide", options: undefined }], "the phone is asked")
    assert.equal(toaster.dismissed, 0, "and the page's toaster is left alone")
  } finally {
    toaster.restore()
  }
})
