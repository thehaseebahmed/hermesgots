/** How much of a transcript a read asks for once the device holds some of it. */
import assert from "node:assert/strict"
import test from "node:test"

import { readNewest, readTranscript } from "../src/chat-next/api.ts"
import { overlay } from "../src/chat-next/pages.ts"

const connection = { server: "http://hermes.test/v1", key: "k" }

const row = (id) => ({ id, role: id % 2 ? "user" : "assistant", content: `row ${id}` })

/** A host holding rows 1..count, answering the newest-first pages the app asks for. */
function host(count) {
  const asked = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    const limit = Number(url.searchParams.get("limit"))
    const offset = Number(url.searchParams.get("offset"))
    asked.push(offset)
    const newest = Array.from({ length: count }, (_, at) => row(count - at))
    const data = newest.slice(offset, offset + limit).reverse()
    return new Response(JSON.stringify({ data }), { status: 200 })
  }
  return { asked, grow: (more) => (count += more) }
}

test("without rows held, the whole transcript is read page by page", async () => {
  const { asked } = host(120)
  const rows = await readTranscript(connection, "s")
  assert.equal(rows.length, 120)
  assert.deepEqual(asked, [0, 50, 100])
})

test("a thread that has not moved costs the one page that joins what is held", async () => {
  const { asked } = host(120)
  const held = await readTranscript(connection, "s")
  asked.length = 0
  const read = await readNewest(connection, "s", undefined, held)
  assert.deepEqual(overlay(held, read.rows), held)
  assert.equal(read.rows.length, 50, "the one page, to lay over the rows held")
  const { more } = read
  assert.equal(more, undefined, "and the device already knows whether older rows are left")
  assert.deepEqual(asked, [0])
})

test("rows written since are added to what is held, reading back to where it joins", async () => {
  const { asked, grow } = host(120)
  const held = await readTranscript(connection, "s")
  grow(60)
  asked.length = 0
  const read = await readNewest(connection, "s", undefined, held)
  assert.deepEqual(
    overlay(held, read.rows).map((one) => one.id),
    Array.from({ length: 180 }, (_, at) => at + 1),
  )
  assert.deepEqual(asked, [0, 50], "the second page is the first that joins the held rows")
})

test("a transcript whose newest rows are not the held ones is read on to the start", async () => {
  const { asked } = host(120)
  // The device holds rows the host no longer has at its end, as after an undo or a compaction.
  const held = Array.from({ length: 120 }, (_, at) => row(at + 1000))
  const { rows, more } = await readNewest(connection, "s", undefined, held)
  assert.equal(more, false, "the whole chat is read")
  assert.equal(rows.length, 120)
  assert.equal(rows[0].id, 1)
  assert.deepEqual(asked, [0, 50, 100])
})
