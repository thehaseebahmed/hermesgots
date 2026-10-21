/**
 * A chat's header: the drawer control, then the bot's picture, then the title with its status under
 * it, all left; the actions stay on the right. Alignment and truncation are layout, so the sweep
 * owns those (ADR 0019); this asserts the arrangement — what is there, in what order.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { ChatHeader } from "@/components/chat/chat-header"
import { find, mount } from "./component-kit.tsx"

const options = <button type="button" aria-label="Chat options" />

function rowParts() {
  const header = find("header")
  const row = header?.firstElementChild
  assert.ok(row, "the header draws a row")
  return [...row.children]
}

const lines = (part: Element) =>
  [...(part.firstElementChild?.children ?? [])].map((line) => line.textContent)

test("a chat's header reads left: drawer, picture, title over its status, actions right", async () => {
  await mount(
    <ChatHeader
      title="A title long enough to need cutting"
      subtitle="Working"
      muted
      actions={options}
    />,
    async () => {
      const row = rowParts()
      assert.equal(row.length, 4, "the row is the leading control, picture, text, actions")
      const [leading, picture, text, actions] = row
      assert.ok(
        leading.contains(find('[aria-label="Open conversations"]')),
        "the drawer control leads the row",
      )
      assert.ok(picture.contains(find('[role="img"]')), "the bot's picture comes second")
      assert.deepEqual(
        lines(text),
        ["A title long enough to need cutting", "Working"],
        "the title is the line over its status",
      )
      assert.equal(
        text.children[1]?.getAttribute("aria-label"),
        "Muted",
        "the muted mark sits beside the title, centred on the block",
      )
      assert.ok(
        actions.contains(find('[aria-label="Chat options"]')),
        "the actions are the row's last part",
      )
    },
  )
})

test("no picture beside a bot pane or before a chat has started", async () => {
  await mount(
    <ChatHeader title="A thread's title" subtitle="3 replies" showBot={false} actions={options} />,
    async () => {
      const row = rowParts()
      assert.equal(row.length, 3, "the row is the leading control, text, actions")
      const [leading, text, actions] = row
      assert.equal(find('[role="img"]'), null, "a bot pane already shows the bot")
      assert.deepEqual(
        lines(text),
        ["A thread's title", "3 replies"],
        "the title and its status still lead from the row's first part",
      )
      assert.ok(
        leading.contains(find('[aria-label="Open conversations"]')),
        "the drawer control still leads the row",
      )
      assert.ok(
        actions.contains(find('[aria-label="Chat options"]')),
        "the actions are still the row's last part",
      )
    },
  )
})

test("an unstarted chat keeps the row's middle", async () => {
  await mount(<ChatHeader title="" showBot={false} actions={options} />, async () => {
    const row = rowParts()
    assert.equal(row.length, 3, "the row still holds its parts without a title")
    assert.equal(row[1].textContent, "", "the middle of the row is empty")
    assert.ok(
      row[2].contains(find('[aria-label="Chat options"]')),
      "the actions are still the row's last part",
    )
  })
})
