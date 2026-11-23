/**
 * The streamed image read: a megabyte and a half drawn as it lands, so the update screen's
 * Downloading bar is the host's own answer rather than a spinner. The fetch is faked as the
 * Response it answers with — `getCharmFirmwareImage` stays the app's own client's business, and
 * the component tests fake the fetch itself — because the rule worth pinning alone is the read's:
 * every chunk reports the bytes that have landed, of the whole the length names.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { readFirmwareImage } from "../src/lib/firmware-image.ts"

/** A wait that gives a stream's first chunk the microtasks it needs to land. */
async function until(check) {
  for (const end = Date.now() + 500; Date.now() < end; ) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail("waited for the stream")
}

test("a streamed image reports each chunk as it lands, and is whole at the end", async () => {
  const first = Uint8Array.from([1, 2, 3, 4])
  const second = Uint8Array.from([5, 6])
  let release
  const gate = new Promise((done) => (release = done))
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(first)
      await gate
      controller.enqueue(second)
      controller.close()
    },
  })
  const seen = []
  const reading = readFirmwareImage(
    new Response(body, { headers: { "Content-Length": "6" } }),
    (progress) => seen.push({ ...progress }),
  )
  await until(() => seen.length === 1)
  assert.deepEqual(
    seen[0],
    { received: 4, total: 6 },
    "the bytes that have landed, of the whole the length names",
  )
  release()
  assert.deepEqual([...(await reading)], [1, 2, 3, 4, 5, 6], "the bytes in the order they arrived")
  assert.deepEqual(seen[1], { received: 6, total: 6 }, "the last one says the image is all there")
})

test("an answer that names no length still counts its bytes as they land", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([7, 8]))
      controller.close()
    },
  })
  const seen = []
  const image = await readFirmwareImage(new Response(body), (progress) => seen.push({ ...progress }))
  assert.deepEqual([...image], [7, 8], "the bytes, with no length to divide them by")
  assert.deepEqual(seen, [{ received: 2, total: 0 }], "no length is claimed that none named")
})

test("an answer with no body to stream is read whole", async () => {
  // A proxy or an old runtime can hand back no reader; the bytes are still the image, so they are
  // read the one remaining way rather than refused.
  const seen = []
  const image = await readFirmwareImage(
    {
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => Uint8Array.from([9]).buffer,
    },
    (progress) => seen.push({ ...progress }),
  )
  assert.deepEqual([...image], [9], "the whole image, read at once")
  assert.deepEqual(seen, [], "no chunk ever landed, so none is reported")
})
