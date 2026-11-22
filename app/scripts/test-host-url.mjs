/**
 * Where a bot's routes live, and the one scheme rule every reader of a typed address shares: the
 * Voice row deciding whether a charm can call an address, the update op fetching an image, and the
 * two rows that read a host a reader pasted or typed.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { schemeOf } from "../src/lib/host-url.ts"

test("one rule names the scheme a typed address wears, in any case", () => {
  assert.equal(schemeOf("https://bot.example/v1"), "https")
  assert.equal(schemeOf("HTTP://100.64.0.2:8642"), "http", "lowercased, as a URL parser reads it")
  assert.equal(schemeOf("  http://100.64.0.2  "), "http", "and pasted with space around it")
  // A host and a port wear no `//`, so they name no scheme: `bot.example:8642` is a URL parser's
  // scheme of its own, which is why the two rows that read a typed host test this before handing an
  // address to `new URL`.
  assert.equal(schemeOf("bot.example:8642"), undefined)
  assert.equal(schemeOf("bot.example/api/plugins/gots"), undefined)
  assert.equal(schemeOf(""), undefined)
})
