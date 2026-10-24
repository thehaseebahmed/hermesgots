/**
 * The bounded store behind the page's caches of object URLs: a thread that reads file after file
 * would pin every one of them, so each store keeps a count and lets the oldest go, calling back so
 * the bytes behind it can be released. Read it as a rule: what the store drops, and in what order.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { boundedStore } from "../src/lib/bounded-cache.ts"

/** A store of the strings it was given, recording what it let go of. */
function storeOf(limit) {
  const dropped = []
  const store = boundedStore({ limit, dispose: (value) => dropped.push(value) })
  return { store, dropped }
}

test("a store answers what it holds, and the bound drops the oldest", () => {
  const { store, dropped } = storeOf(2)
  store.set("a", "url:a")
  store.set("b", "url:b")
  store.set("c", "url:c")
  assert.equal(store.get("a"), undefined, "the oldest went")
  assert.equal(store.get("b"), "url:b")
  assert.equal(store.get("c"), "url:c")
  assert.deepEqual(dropped, ["url:a"], "and its bytes were let go of")
})

test("a read makes an entry the newest, so what goes is what nothing asked for", () => {
  const { store, dropped } = storeOf(2)
  store.set("a", "url:a")
  store.set("b", "url:b")
  assert.equal(store.get("a"), "url:a", "a is read again")
  store.set("c", "url:c")
  assert.equal(store.get("a"), "url:a", "so it stays")
  assert.equal(store.get("b"), undefined, "and the one not read since goes")
  assert.deepEqual(dropped, ["url:b"])
})

test("a key set again keeps one value, and only the one it replaced is let go", () => {
  const { store, dropped } = storeOf(4)
  store.set("a", "url:first")
  store.set("a", "url:second")
  assert.equal(store.get("a"), "url:second")
  assert.deepEqual(dropped, ["url:first"])
})

test("a missing key is not a read, and does not disturb the order", () => {
  const { store } = storeOf(2)
  store.set("a", "url:a")
  store.set("b", "url:b")
  assert.equal(store.get("missing"), undefined)
  assert.equal(store.has("a"), true)
  store.set("c", "url:c")
  assert.equal(store.get("a"), undefined, "a was still the oldest")
})
