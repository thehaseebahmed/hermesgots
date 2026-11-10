import assert from "node:assert/strict"
import test from "node:test"

import { PAGE_MAX_BYTES, readPage } from "../src/lib/page-read.ts"

const answering = (response) => async () => response

test("a page the host serves is read as its text", async () => {
  const markup = "<!doctype html><html><head><title>Ré</title></head><body>hi</body></html>"
  const read = await readPage("https://host.test/media?path=r.html&token=t", {
    fetch: answering(new Response(markup, { status: 200, headers: { "content-type": "text/html" } })),
  })
  assert.deepEqual(read, { state: "ready", html: markup })
})

test("a staged page's blob URL is read the same way", async () => {
  const url = URL.createObjectURL(new Blob(["<p>staged</p>"], { type: "text/html" }))
  try {
    assert.deepEqual(await readPage(url, { fetch: (u, init) => fetch(u, init) }), { state: "ready", html: "<p>staged</p>" })
  } finally {
    URL.revokeObjectURL(url)
  }
})

test("an HTTP error fails with a note naming the status", async () => {
  const read = await readPage("https://host.test/x", { fetch: answering(new Response("no", { status: 401 })) })
  assert.equal(read.state, "failed")
  assert.match(read.note, /401/)
})

test("a network failure fails rather than throws", async () => {
  const read = await readPage("https://host.test/x", {
    fetch: async () => {
      throw new TypeError("Failed to fetch")
    },
  })
  assert.deepEqual(read, { state: "failed", note: "Failed to fetch" })
})

test("a page over the cap is refused, whether its length is said up front or not", async () => {
  assert.equal(PAGE_MAX_BYTES, 25 * 1024 * 1024, "the media route's cap for a download")
  const said = await readPage("https://host.test/x", {
    fetch: answering(new Response("x", { headers: { "content-length": String(PAGE_MAX_BYTES + 1) } })),
  })
  assert.equal(said.state, "failed")
  assert.match(said.note, /25 MB/)
  const unsaid = await readPage("https://host.test/x", { limit: 4, fetch: answering(new Response("12345")) })
  assert.equal(unsaid.state, "failed")
  const atCap = await readPage("https://host.test/x", { limit: 5, fetch: answering(new Response("12345")) })
  assert.deepEqual(atCap, { state: "ready", html: "12345" })
})

test("a read that never answers fails once its time is up", async () => {
  const read = await readPage("https://host.test/x", {
    timeoutMs: 10,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  })
  assert.deepEqual(read, { state: "failed", note: "The page took too long to load." })
})
