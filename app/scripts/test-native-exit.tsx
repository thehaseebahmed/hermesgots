/**
 * What the press the exit toast promised comes to: the app leaves by minimizing, so a reply keeps
 * streaming and the screen the reader was on is still there when they come back — Android's own
 * back from 12 on does the same (ADR 0143). The claim lives in `answerBackPress`'s own words, and
 * this is the check that holds it: the press is driven through the app's real answer, and the
 * native call it crosses is read.
 *
 * Capacitor reads the platform off the page as its module loads, so the phone is stood in for
 * before anything imports the app's copy of it: an Android bridge, and the promise the App plugin's
 * `minimizeApp` would cross. Nothing of the app is changed to make it observable — the bridge the
 * real APK brings is the only seam.
 */
import assert from "node:assert/strict"
import test from "node:test"

/** Every native call the app made, as `<plugin>.<method>`. */
const calls: string[] = []

Object.assign(globalThis, {
  // What makes `Capacitor.getPlatform()` answer `android`, and `isNative` true with it.
  androidBridge: {},
  Capacitor: {
    PluginHeaders: [{ name: "App", methods: [{ name: "minimizeApp", rtype: "promise" }] }],
    nativePromise: async (plugin: string, method: string) => {
      calls.push(`${plugin}.${method}`)
    },
  },
})

/** Lets the promises a plugin call is made of land, since the press fires it rather than awaiting it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test("the press the toast promised leaves by minimizing the app, once", async () => {
  const { answerBackPress } = await import("@/lib/native")
  assert.equal(answerBackPress(), "armed", "the first press at the app's edge arms the exit")
  assert.deepEqual(calls, [], "and leaves nothing")
  assert.equal(answerBackPress(), "leave", "the press the toast promised leaves")
  await settle()
  assert.deepEqual(calls, ["App.minimizeApp"], "by minimizing the app, exactly once")
})
