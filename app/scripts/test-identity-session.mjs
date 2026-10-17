import assert from "node:assert/strict"
import test from "node:test"

import { claimsOf, tradeOutcome } from "../src/lib/identity-session.ts"

/** A JWT-shaped token carrying `claims`, which is all the app reads one for. */
const token = (claims) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`

test("a traded token renews", () => {
  assert.equal(tradeOutcome(200, "spent", "spent"), "renewed")
})

test("a token the store already replaced is a swap, not the end of the session", () => {
  assert.equal(tradeOutcome(400, "spent", "replacement"), "swapped")
})

test("a token Identity declined while the store still holds it ends the session", () => {
  assert.equal(tradeOutcome(400, "spent", "spent"), "ended")
  assert.equal(tradeOutcome(401, "spent", "spent"), "ended")
})

test("a 403 is Identity refusing the token, the way the function reads one", () => {
  assert.equal(tradeOutcome(403, "spent", "replacement"), "swapped")
  assert.equal(tradeOutcome(403, "spent", "spent"), "ended")
})

test("a rejection with no token left in the store is already the end", () => {
  assert.equal(tradeOutcome(400, "spent", null), "ended")
})

test("a rate-limited trade keeps the session", () => {
  assert.equal(tradeOutcome(429, "spent", "spent"), "retry")
})

test("an unwell service keeps the session", () => {
  assert.equal(tradeOutcome(503, "spent", "spent"), "retry")
  assert.equal(tradeOutcome(500, "spent", "spent"), "retry")
})

test("an answer that isn't about the token keeps the session", () => {
  assert.equal(tradeOutcome(404, "spent", "spent"), "retry")
  assert.equal(tradeOutcome(0, "spent", "spent"), "retry")
})

test("the stored access token names its owner", () => {
  assert.deepEqual(claimsOf(token({ sub: "user-1", email: "a@example.com" })), {
    id: "user-1",
    email: "a@example.com",
  })
})

test("a token with no subject names nobody", () => {
  assert.equal(claimsOf(token({ email: "a@example.com" })), null)
  assert.equal(claimsOf(token({ sub: "" })), null)
})

test("what isn't a token names nobody", () => {
  assert.equal(claimsOf(""), null)
  assert.equal(claimsOf("not-a-token"), null)
  assert.equal(claimsOf("header.@@not-base64@@.signature"), null)
})
