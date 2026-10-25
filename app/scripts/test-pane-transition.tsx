import assert from "node:assert/strict"
import test from "node:test"
import { useState } from "react"

import { FADE_MS, PaneTransition } from "@/components/pane-transition"
import { click, find, findAll, mount, spyAnimate, withReducedMotion } from "./component-kit.tsx"

/** An item pane with a button per item, as a list beside it would open them. */
function Pane({ items }: { items: (string | undefined)[] }) {
  const [item, setItem] = useState(items[0])
  return (
    <>
      {items.map((one, at) => (
        <button key={at} type="button" data-open={one ?? "none"} onClick={() => setItem(one)}>
          {one ?? "none"}
        </button>
      ))}
      <PaneTransition item={item}>
        <p data-shown>{item ? `the ${item} item` : "nothing open"}</p>
      </PaneTransition>
    </>
  )
}

const fadesOut = (spy: ReturnType<typeof spyAnimate>) =>
  spy.asked.filter((one) => one.keyframes.at(-1)?.opacity === 0)

test("an item swapped in the pane fades a copy of the one left out over it", async () => {
  await mount(<Pane items={["first", "second"]} />, async () => {
    const spy = spyAnimate()
    try {
      await click(find('[data-open="second"]'))
    } finally {
      spy.restore()
    }
    const out = fadesOut(spy)
    assert.equal(out.length, 1, "one fade out")
    assert.equal(out[0].text, "the first item", "of the item left")
    assert.equal(out[0].options.duration, FADE_MS)
    assert.equal(find("[data-shown]")?.textContent, "the second item", "over the item asked for")
    assert.equal(
      findAll("[data-shown]").length,
      2,
      "the copy stands above it while it fades, a second element beside the live one",
    )
    const copy = findAll("[data-shown]")[1].closest("[inert]")
    assert.ok(copy, "and nothing in the copy can be reached")
    assert.equal(copy?.getAttribute("aria-hidden"), "true", "or read out")
    await new Promise((resolve) => setTimeout(resolve, FADE_MS + 20))
    assert.equal(findAll("[data-shown]").length, 1, "and it is gone once it has faded")
  })
})

test("the pane fades nothing when the item stays, opens from nothing or closes", async () => {
  await mount(<Pane items={["first", undefined, "second", "second"]} />, async () => {
    const spy = spyAnimate()
    try {
      await click(find('[data-open="first"]'))
      await click(find('[data-open="none"]'))
      await click(find('[data-open="second"]'))
    } finally {
      spy.restore()
    }
    assert.deepEqual(fadesOut(spy), [], "the list's own open and close are the pane's to animate")
  })
})

test("with reduced motion an item swaps in place, with no copy and no fade", () =>
  withReducedMotion(() =>
    mount(<Pane items={["first", "second"]} />, async () => {
      const spy = spyAnimate()
      try {
        await click(find('[data-open="second"]'))
      } finally {
        spy.restore()
      }
      assert.deepEqual(fadesOut(spy), [])
      assert.equal(findAll("[data-shown]").length, 1, "only the item asked for is drawn")
    }),
  ))
