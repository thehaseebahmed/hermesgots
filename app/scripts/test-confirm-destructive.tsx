/**
 * The one destructive confirmation: it owns the write, so a refusal is read where the question was
 * asked rather than in a toast the reader has already missed.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { ConfirmDestructive } from "@/components/confirm-destructive"
import { click, find, findAll, mount, settle, until } from "./component-kit.tsx"

const question = (over: Partial<Parameters<typeof ConfirmDestructive>[0]> = {}) => (
  <ConfirmDestructive
    open
    title="Remove Test bot?"
    description="The bot stops having it, and its files go with it."
    confirmLabel="Remove"
    onOpenChange={() => {}}
    onConfirm={() => {}}
    {...over}
  />
)

test("a write that lands closes the question", async () => {
  const closed: boolean[] = []
  await mount(
    question({
      onOpenChange: (open) => closed.push(open),
      onConfirm: () => {},
    }),
    async () => {
      await click(findAll("button").find((one) => one.textContent?.trim() === "Remove") ?? null)
      await settle()
      assert.deepEqual(closed, [false], "the dialog asked to close once the write landed")
    },
  )
})

test("a write the host refuses keeps the question open, in the host's words", async () => {
  const closed: boolean[] = []
  await mount(
    question({
      onOpenChange: (open) => closed.push(open),
      onConfirm: () => Promise.reject(new Error("That bot is running a turn.")),
    }),
    async () => {
      const remove = () => findAll("button").find((one) => one.textContent?.trim() === "Remove")
      await click(remove() ?? null)
      await until(async () => Boolean(find('[role="alert"]')), "the host's reason", 2_000)
      assert.equal(
        find('[role="alert"]')?.textContent,
        "That bot is running a turn.",
        "the refusal is printed where it happened",
      )
      assert.deepEqual(closed, [], "and nothing closed")
      assert.equal(await remove()?.hasAttribute("disabled"), false, "the action is pressable again")
    },
  )
})

test("the action is held while the write runs", async () => {
  let release: () => void = () => {}
  await mount(
    question({ onConfirm: () => new Promise<void>((done) => (release = done)) }),
    async () => {
      const remove = () => findAll("button").find((one) => one.textContent?.trim() === "Remove")
      await click(remove() ?? null)
      await settle()
      assert.equal(
        findAll("button").some((one) => one.textContent?.trim() === "Remove"),
        false,
        "the label gives way to the loader while the write runs",
      )
      assert.ok(find("svg[class*=loader]"), "and the loader is the app's own")
      release()
      await settle()
    },
  )
})
