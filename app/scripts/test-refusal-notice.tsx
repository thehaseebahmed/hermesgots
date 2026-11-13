/**
 * The refusal a surface draws: the host's own words, announced by `Alert`'s own role, and the one
 * control that takes them away. Nothing is drawn while there is nothing to say.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { Refusal } from "@/components/banner"
import { absent, click, find, findAll, mount } from "./component-kit.tsx"

const hold = (over: { words?: string; dismiss?: () => void } = {}) => ({
  words: "That bot is running a turn.",
  dismiss: () => {},
  ...over,
})

test("a refusal draws the host's words where the write was made", async () => {
  await mount(<Refusal hold={hold()} />, async () => {
    assert.equal(
      find('[role="alert"]')?.textContent,
      "That bot is running a turn.",
      "the host's sentence, in the notice",
    )
  })
})

test("nothing to say draws nothing at all", async () => {
  await mount(<Refusal hold={hold({ words: undefined })} />, async () => {
    absent('[role="alert"]', "a surface with nothing to say draws no notice")
  })
})

test("Dismiss is the notice's other control", async () => {
  let dismissed = 0
  await mount(
    <Refusal
      hold={hold({
        dismiss: () => {
          dismissed += 1
        },
      })}
    />,
    async () => {
      const dismiss =
        findAll("button").find((one) => one.getAttribute("aria-label") === "Dismiss") ?? null
      assert.ok(dismiss, "the notice carries a Dismiss, named for a reader who cannot see it")
      await click(dismiss)
      assert.equal(dismissed, 1, "and a tap asks the surface to take it away")
    },
  )
})
