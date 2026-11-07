/**
 * A retry's message: the markers the app writes, and the rule both folds read them back by (ADR
 * 0112). The app is the one writer, so the shape is pinned here the way `test-wake-prompt.mjs` pins
 * the plugin's — one spelling, and the tokens it keys on are the stable half of it.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  isRetryRow,
  isRetryText,
  RETRY_CLOSE,
  RETRY_OPEN,
  requestIn,
  retryText,
} from "../src/lib/retry-message.ts"

const linesOf = (text) => {
  const [first, ...rest] = text.split("\n")
  return { first, body: rest.slice(0, -1).join("\n"), last: rest.at(-1) ?? "" }
}

test("the tokens are bracketed, em-dashed and one line, as every notice the host writes is", () => {
  assert.ok(RETRY_OPEN.startsWith("[RETRY — "), "a bracket, the word, and its em dash")
  assert.ok(RETRY_CLOSE.startsWith("[END OF RETRY — "), "and the closing token is the second mark")
  for (const token of [RETRY_OPEN, RETRY_CLOSE]) {
    assert.equal(token.includes("\n"), false, "a token is one line")
    assert.equal(token.endsWith("]"), false, "the bracket closes the sentence, not the token")
  }
})

test("a retry's message is its opening, the request, and its closing", () => {
  const text = retryText("Look around")
  const { first, body, last } = linesOf(text)
  assert.ok(first.startsWith(RETRY_OPEN), "the opening token on line 1")
  assert.ok(first.endsWith("]"), "with its sentence closed")
  assert.equal(body, "Look around", "the request, alone, between them")
  assert.ok(last.startsWith(RETRY_CLOSE), "and the closing token under it")
  assert.ok(last.endsWith("]"), "closed too")
  assert.equal(isRetryText(text), true)
})

test("the request keeps what the first send wrote, markers and all", () => {
  const sent = 'Look around\n<attachment name="plan.md" type="text/markdown" size="12" />'
  const text = retryText(sent)
  assert.equal(isRetryText(text), true)
  assert.ok(text.includes(`\n${sent}\n`), "the body is the request, untouched, between the marks")
  assert.equal(requestIn(text), sent, "and reading it back gives the request again")
})

test("one marker on its own is nobody's retry", () => {
  const { first, last } = linesOf(retryText("Look around"))
  assert.equal(isRetryText(first), false, "a header with no request")
  assert.equal(isRetryText(`${first}\nLook around`), false, "nor one without its end")
  assert.equal(isRetryText(`Look around\n${last}`), false, "an end with no header")
  assert.equal(isRetryText(`${first}\n${last}`), false, "nor the pair with nothing between")
  assert.equal(isRetryText(`${first}\n \n${last}`), false, "whitespace is not a request")
  assert.equal(isRetryText(retryText("")), false, "a retry is never sent without a request")
})

test("a message that quotes a marker is the user's own", () => {
  assert.equal(
    isRetryText(`What does this mean?\n${retryText("Look around")}`),
    false,
    "the header is not on line 1",
  )
  assert.equal(
    isRetryText(`${retryText("Look around")}\nand their own words under it`),
    false,
    "and the closing line is not the last",
  )
  assert.equal(isRetryText(` ${retryText("Look around")}`), false, "nor behind a space")
})

test("the tokens are the contract, the sentence between them is prose", () => {
  const { first, last } = linesOf(retryText("Look around"))
  const reworded = `${RETRY_OPEN}the words changed since this was written]`
  assert.equal(
    isRetryText(`${reworded}\nLook around\n${last}`),
    true,
    "a reworded opening still reads",
  )
  assert.equal(
    isRetryText(`${first}\nLook around\n${RETRY_CLOSE}and so did this]`),
    true,
    "and so does a reworded end",
  )
  assert.equal(
    isRetryText(`${first}\nLook around\n${last}`.replace(RETRY_OPEN, "[RETRY: ")),
    false,
    "a changed token does not",
  )
})

test("blank lines under the end are the host's, not a different message", () => {
  assert.equal(isRetryText(`${retryText("Look around")}\n\n`), true)
})

test("a row the host wrote with CRLF is the same message", () => {
  const crlf = retryText("First line\nSecond line").replace(/\n/g, "\r\n")
  assert.equal(isRetryText(crlf), true)
  assert.equal(requestIn(crlf), "First line\nSecond line", "read back with the app's line ends")
})

test("only a user row is a retry", () => {
  const text = retryText("Look around")
  assert.equal(isRetryRow({ role: "user", content: text }), true)
  assert.equal(isRetryRow({ role: "assistant", content: text }), false, "the bot's own words")
  assert.equal(isRetryRow({ role: "user", content: null }), false, "a row with nothing in it")
})

test("the request a retry re-asks is what stood between the tokens", () => {
  assert.equal(requestIn(retryText("Look around")), "Look around")
  assert.equal(requestIn("Look around"), "Look around", "and a plain message is its own request")
  assert.equal(
    requestIn(retryText(requestIn(retryText("Look around")))),
    "Look around",
    "asking a retry again never nests one marker in another",
  )
})
