/**
 * The phone speaks the page's wire, and nothing here can share the page's constants.
 *
 * `BubbleNet.kt` spells the routes, the bounds and the retry pace a second time because the phone has
 * no access to `app/src/lib/`. This is the check that holds the two copies together: a number moved on
 * either side fails here, the way `bench/dictation/cut.py` holds the cut rule.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

const phone = () => read("android/app/src/main/java/app/memento/BubbleNet.kt")
const page = () => read("src/lib/dictation.ts")
const host = () => read("src/lib/hermes.ts")

/** A `const NAME = 60_000` in either language, read as the number it states. */
function numberIn(text, name) {
  const found = new RegExp(`\\b${name}\\s*=\\s*([0-9_]+)`).exec(text)
  assert.ok(found, `nothing states ${name}`)
  return Number(found[1].replaceAll("_", ""))
}

test("the phone's bounds are the page's", () => {
  assert.equal(numberIn(phone(), "UPLOAD_MS"), numberIn(page(), "UPLOAD_MS"), "one hung Upload")
  assert.equal(numberIn(phone(), "RELEASE_MS"), numberIn(page(), "RELEASE_MS"), "one dead take")
  assert.equal(numberIn(phone(), "TRIES"), numberIn(page(), "UPLOAD_TRIES"), "one Piece, three tries")
  assert.equal(numberIn(phone(), "RETRY_MS"), numberIn(page(), "RETRY_MS"), "one retry pace")
})

test("the phone's routes are the ones the host answers", () => {
  const routes = phone()
  for (const route of ["/dictation/warm", "/piece", "/confirm"]) {
    assert.ok(routes.includes(route), `BubbleNet.kt calls no ${route}`)
    assert.ok(host().includes(route), `${route} is not a route the app's own client calls`)
  }
  assert.match(routes, /requestMethod = "DELETE"|"DELETE"/, "a take abandoned goes to DELETE")
  assert.match(host(), /method: "DELETE"/, "and the app's own cancel does the same")
})

test("a Piece is posted with the fields the host reads", () => {
  const routes = phone()
  assert.match(routes, /"\?index="|index=/, "the index travels")
  assert.match(routes, /&ms=/, "and the Piece's own span")
  assert.ok(routes.includes("&vocabulary="), "and the bot's words")
  assert.ok(!routes.includes("&hint="), "and no hint: a Bubble has no chat to describe")
})

test("a finished take writes the row its bot's History reads, at the app's own route", () => {
  const routes = phone()
  assert.ok(routes.includes("/dictations\""), "BubbleNet.kt posts a dictation")
  const client = read("src/lib/hermes.ts")
  assert.ok(
    client.includes('pluginPath(config, "dictations"'),
    "at the route the app's own client writes one to",
  )
  for (const field of ["id", "text", "heard", "ms", "at", "level", "cleaned", "provider", "model"])
    assert.ok(routes.includes(`"${field}"`), `the row carries its ${field}`)
  assert.ok(
    !routes.includes('"words"'),
    "and no word count: the host counts them (dictations.record's own default)",
  )
})

test("the phone gives the log's write the app's own bound", () => {
  assert.equal(
    numberIn(phone(), "WRITE_MS"),
    numberIn(read("src/lib/freshness.ts"), "WRITE_TIMEOUT_MS"),
    "one write bound on both sides",
  )
})
