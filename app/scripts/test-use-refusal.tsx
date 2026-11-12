/**
 * The hold a surface keeps, as a screen keeps it: one object across renders, so an effect that holds
 * it is not re-run by a render, and the tap made last is the one answered — an answer to an earlier
 * tap that lands after it must not speak for the reader's last press.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useState } from "react"

import { Refusal } from "@/components/banner"
import { useRefusal, useSaidRefusal } from "@/lib/use-refusal"

import { click, find, findText, missing, mount, settle, until, wordsOf, withToasts } from "./component-kit.tsx"

/** A write the test settles when it chooses: no host answers until it does. */
function deferred() {
  let refuse: (why: string) => void = () => {}
  const promise = new Promise<unknown>((_, rejected) => {
    refuse = (why: string) => rejected(new Error(why))
  })
  return { promise, refuse: (why: string) => refuse(why) }
}

/** What each button's write does, replaced by the case that needs a write it can settle. */
const writes = {
  first: () => Promise.resolve(),
  second: () => Promise.resolve(),
}

/** Every hold the screen made, so a case can ask whether two renders made one object or two. */
const holds: unknown[] = []

function Harness() {
  const refusal = useRefusal()
  const [renders, again] = useState(0)
  holds.push(refusal)
  return (
    <>
      <button onClick={() => void refusal.write("the first write", writes.first)}>First write</button>
      <button onClick={() => void refusal.write("the second write", writes.second)}>Second write</button>
      <button onClick={() => again((count) => count + 1)}>Render again</button>
      <Refusal hold={refusal} />
      <span data-renders>{renders}</span>
    </>
  )
}

test("the hold is one object across renders", async () => {
  holds.length = 0
  await mount(<Harness />, async () => {
    const before = holds.at(-1)
    await click(findText("button", "Render again"))
    assert.equal(
      holds.at(-1),
      before,
      "a fresh object every render re-runs every effect that holds the refusal",
    )
  })
})

test("the tap made last is the one the surface answers", async () => {
  const first = deferred()
  const second = deferred()
  writes.first = () => first.promise
  writes.second = () => second.promise
  await mount(<Harness />, async () => {
    await click(findText("button", "First write"))
    await click(findText("button", "Second write"))
    second.refuse("The second tap was refused.")
    await until(async () => Boolean(find('[role="alert"]')), "the second tap's words")
    assert.equal(wordsOf(find('[role="alert"]')), "The second tap was refused.")
    // The first tap's answer lands now, after the reader has made a later one: it speaks for a
    // press they have moved on from, so it is not the surface's to draw.
    first.refuse("The first tap was refused.")
    await settle()
    assert.equal(
      wordsOf(find('[role="alert"]')),
      "The second tap was refused.",
      "an answer to an earlier tap does not replace the words of the last one",
    )
  })
})

test("an answer a later tap superseded is still said in passing", async () => {
  const first = deferred()
  const second = deferred()
  writes.first = () => first.promise
  writes.second = () => second.promise
  await withToasts(async (said) => {
    await mount(<Harness />, async () => {
      await click(findText("button", "First write"))
      await click(findText("button", "Second write"))
      second.refuse("The second tap was refused.")
      await until(async () => Boolean(find('[role="alert"]')), "the second tap's words")
      first.refuse("The first tap was refused.")
      await until(async () => said.length > 0, "the superseded answer to be said")
      assert.deepEqual(
        said,
        ["The first tap was refused."],
        "an answer the surface no longer draws is said in passing rather than vanishing",
      )
      assert.equal(
        wordsOf(find('[role="alert"]')),
        "The second tap was refused.",
        "while the notice still holds the tap the reader made last",
      )
    })
  })
})

/** A surface with nothing standing to draw a refusal: what a row outside the chat's providers gets. */
function Unheld() {
  const refusal = useSaidRefusal()
  return (
    <button onClick={() => void refusal.write("the write", () => Promise.reject(new Error("The host said no.")))}>
      Write
    </button>
  )
}

test("a hold with no notice draws nothing and says the host's words in passing", async () => {
  await withToasts(async (said) => {
    await mount(<Unheld />, async () => {
      await click(findText("button", "Write"))
      await until(async () => said.length > 0, "the host's words said in passing")
      assert.deepEqual(said, ["The host said no."], "the host's own sentence, out loud")
      assert.ok(missing('[role="alert"]'), "and nothing held where no notice could draw it")
    })
  })
})
