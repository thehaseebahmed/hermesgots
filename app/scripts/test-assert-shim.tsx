/**
 * The assert boundary: a red assertion handed a mounted element says why, in its own message, and
 * returns in milliseconds.
 *
 * `assert.equal(element, null)` makes Node build a diff by inspecting both arguments to depth 1000,
 * and a mounted element carries React's fiber graph, so the diff walks the whole component tree: the
 * worker grows to gigabytes and is SIGKILLed before the message prints. `component-loader.mjs` maps
 * `node:assert` and `node:assert/strict` to `assert-hooks.cjs`, which hands Node
 * `[element <span class="…">]` in the element's place — so the cost is the assertion's own, whatever
 * a test writes and whatever helper it hands the element to.
 *
 * The cases below are the two import spellings, the short label, and the assertions the shim must
 * leave exactly as they were.
 */
import assert, { equal } from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { botProfile, find, mount, seedChat, settle } from "./component-kit.tsx"

/** The failure an assertion raised, which a green one did not. */
function failureOf(run: () => void) {
  try {
    run()
  } catch (error) {
    return error as Error & { actual?: unknown }
  }
  throw new Error("the assertion ran green")
}

test("a red assertion handed a mounted element prints its message, at once", async () => {
  await seedChat({
    id: "chat-1",
    profile: botProfile("assert-shim"),
    settings: { onboarded: true, legacyChat: true },
  })
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await settle()
      const row = find('a[href^="/c/"]')
      assert.ok(row, "the row drew")
      const span = row!.querySelector("span")
      assert.ok(span, "the row draws a span")

      const started = Date.now()
      const failure = failureOf(() => assert.equal(span, null, "the row carries no span"))
      const elapsed = Date.now() - started

      assert.match(failure.message, /the row carries no span/, "the failure says what it means")
      assert.match(
        String(failure.actual),
        /^\[element <span[\s\S]{0,80}> #\d+\]$/,
        "the element reached Node as a short label",
      )
      assert.ok(elapsed < 1000, `the failure printed in ${elapsed}ms`)

      // The form a test writes, matched by its own words rather than by inspecting the element.
      assert.throws(
        () => assert.equal(span, null, "the row carries no span"),
        /the row carries no span/,
      )
    },
  )
})

test("the named import is scrubbed the same way", () => {
  const band = document.createElement("div")
  band.setAttribute("data-band", "rooms")

  const failure = failureOf(() => equal(band, null, "the band went"))
  assert.match(String(failure.actual), /^\[element <div data-band="rooms"> #\d+\]$/)
  assert.match(failure.message, /the band went/)

  const list = failureOf(() => equal([band], [], "the band went"))
  assert.deepEqual(list.actual, [failure.actual])
})

test("two nodes stay two nodes", () => {
  const one = document.createElement("div")
  const other = document.createElement("div")

  // The label carries the node's identity, so an assertion about *which* node still holds.
  assert.notStrictEqual(one, other)
  assert.strictEqual(one, one)
  assert.throws(() => assert.strictEqual(one, other), { name: "AssertionError" })
  assert.throws(() => assert.notStrictEqual(one, one), { name: "AssertionError" })
})

test("an assertion with nothing to scrub is the assertion it was", () => {
  assert.equal(null, null)
  assert.deepEqual([1], [1])
  assert.deepEqual([{ a: 1 }], [{ a: 1 }])

  // An element-free array keeps its identity, so `strictEqual` still means identity.
  const rows: number[] = []
  assert.strictEqual(rows, rows)

  // A genuine failure still fails, with its own message and its own diff.
  assert.throws(() => assert.equal(1, 2, "one is not two"), /one is not two/)
  assert.throws(() => assert.deepEqual([1], [2]), { name: "AssertionError" })
  assert.doesNotThrow(() => assert.equal("a", "a"))
})
