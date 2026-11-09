import assert from "node:assert/strict"
import test from "node:test"

import { absent, absentText, mount } from "./component-kit.tsx"

/** The failure an assertion raised, which a green one did not. */
function failureOf(run: () => void) {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error("the assertion ran green")
}

/** A page holding one control, which both helpers are asked about. */
const page = (body: () => Promise<void>) =>
  mount(
    <div>
      <button type="button">Remove</button>
    </div>,
    body,
  )

test("a sentence handed to absent fails on the selector, whatever the sentence says", async () => {
  await page(async () => {
    const failure = failureOf(() => absent("button", "and nothing else on the page is a button"))
    assert.equal(
      failure.message,
      "and nothing else on the page is a button",
      "the sentence is the failure's words, not a control to look for",
    )
  })
})

test("absent with no words still names the selector it found", async () => {
  await page(async () => {
    const failure = failureOf(() => absent("button"))
    assert.equal(failure.message, "nothing on the screen matches button", "a sentence of its own")
  })
})

test("absent passes where nothing matches the selector", async () => {
  await page(async () => {
    assert.doesNotThrow(() => absent("[data-nothing]"), "a selector no element carries")
    assert.doesNotThrow(
      () => absent("[data-nothing]", "and this sentence never has to be said"),
      "with a message it never has to use",
    )
  })
})

test("absentText reads a control's name where an icon carries no words", async () => {
  await mount(
    <button type="button" aria-label="Preview" />,
    async () => {
      const failure = failureOf(() => absentText("button", "Preview"))
      assert.match(
        failure.message,
        /button reading "Preview"/,
        "a control named by its aria-label is one the check finds",
      )
    },
  )
})

test("absentText reads a control's words, and only the words it was given", async () => {
  await page(async () => {
    const failure = failureOf(() => absentText("button", "Remove"))
    assert.equal(
      failure.message,
      'nothing on the screen matches button reading "Remove"',
      "the failure names the words it looked for",
    )

    assert.doesNotThrow(
      () => absentText("button", "Show more"),
      "a button is on screen, and none of them says this",
    )
  })
})
