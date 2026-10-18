// What a listed server's row says about Server access, and what the Host's start answer means: the
// flag a Host that says nothing about a row must not turn into an offer, an answer whose URL is null
// because a stored access still works, and an expiry Hermes didn't send. The rules are pure
// (`src/lib/mcp-access.ts`), so the cases that read oddly are here rather than in the browser flow.
import assert from "node:assert/strict"
import test from "node:test"

import {
  offersAccess,
  parseMcpAccess,
  readMcpAccessOffer,
} from "../src/lib/mcp-access.ts"

test("only a row the Host marks startable offers the action", () => {
  assert.equal(readMcpAccessOffer({ name: "notion", access: true }), "startable")
  assert.equal(readMcpAccessOffer({ name: "github", access: false }), "none")
  // An older Host, and one answering junk: nothing to offer either way.
  assert.equal(readMcpAccessOffer({ name: "github" }), "none")
  assert.equal(readMcpAccessOffer({ name: "github", access: "yes" }), "none")
  assert.equal(readMcpAccessOffer(undefined), "none")
})

test("the offer needs both the Host's feature and the row's own flag", () => {
  assert.equal(offersAccess(true, "startable"), true)
  assert.equal(offersAccess(true, "none"), false)
  // A host that can start a flow for no server of this bot draws no button at all.
  assert.equal(offersAccess(false, "startable"), false)
  assert.equal(offersAccess(false, "none"), false)
})

test("a start answer carries the URL, its life, and nothing else", () => {
  assert.deepEqual(
    parseMcpAccess({
      object: { access: { name: "notion", url: "https://notion.example/auth", expires: 300 } },
    }),
    { name: "notion", url: "https://notion.example/auth", expires: 300 },
  )
})

test("an answer with no URL is the stored access still working, not a failure", () => {
  assert.deepEqual(parseMcpAccess({ object: { access: { name: "notion", url: null, expires: 0 } } }), {
    name: "notion",
    url: null,
    expires: 0,
  })
  // A Host that answered with an empty string or nothing at all means the same thing.
  assert.equal(parseMcpAccess({ object: { access: { name: "notion", url: "", expires: 0 } } }).url, null)
  assert.equal(parseMcpAccess({ object: { access: { name: "notion" } } }).url, null)
})

test("a missing expiry reads as no wait rather than a number the app invented", () => {
  assert.equal(parseMcpAccess({ object: { access: { name: "notion", url: "https://x.example" } } }).expires, 0)
  assert.equal(
    parseMcpAccess({ object: { access: { name: "notion", url: "https://x.example", expires: "300" } } })
      .expires,
    0,
  )
})

test("junk reads as an answer that can't be used, never as a throw", () => {
  assert.deepEqual(parseMcpAccess(null), { name: "", url: null, expires: 0 })
  assert.deepEqual(parseMcpAccess({}), { name: "", url: null, expires: 0 })
  assert.deepEqual(parseMcpAccess({ object: { access: "yes" } }), { name: "", url: null, expires: 0 })
})
