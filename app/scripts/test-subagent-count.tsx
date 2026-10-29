/**
 * What a streaming reply's footer draws for its subagent count: the count itself, and nothing at all
 * once every subagent has ended. A count is data, not a truthy word — `0 && <line/>` is the number
 * zero, which React prints, so the footer must say nothing rather than "0".
 */
import assert from "node:assert/strict"
import test from "node:test"

import { MessageItem } from "@/components/chat/message-item"
import type { Message } from "@/lib/db"
import { mount, text } from "./component-kit.tsx"

const reply: Message = {
  id: "m-1",
  conversationId: "c-1",
  role: "assistant",
  content: "Working on it.",
  status: "streaming",
  createdAt: 1,
}

async function drawn(props: Partial<Parameters<typeof MessageItem>[0]>) {
  let body = ""
  await mount(
    <MessageItem message={reply} showStats onShowSubagents={() => {}} {...props} />,
    async () => {
      body = text()
    },
  )
  return body
}

test("a reply with no subagent at work says nothing about them", async () => {
  const body = await drawn({ subagents: 0, subagentsInline: false })
  assert.doesNotMatch(body, /0/, `no stray zero in "${body}"`)
  assert.doesNotMatch(body, /subagent/i, `no subagent line in "${body}"`)
})

test("a reply with subagents at work counts them inline", async () => {
  const body = await drawn({ subagents: 2, subagentsInline: true })
  assert.match(body, /2 subagents running/)
})

test("a reply never told how many there are says nothing about them", async () => {
  const body = await drawn({ subagents: undefined, subagentsInline: false })
  assert.doesNotMatch(body, /subagent/i, `no subagent line in "${body}"`)
})

test("the dot parting the words from the count takes the count's blue", async () => {
  let dot: Element | null = null
  await mount(
    <MessageItem
      message={reply}
      showStats
      onShowSubagents={() => {}}
      subagents={2}
      subagentsInline
    />,
    async () => {
      dot = document.querySelector('[data-slot="status-separator"]')
    },
  )
  assert.equal(dot?.textContent, "·", "the words and the count are parted by a dot")
  assert.match(
    dot?.getAttribute("class") ?? "",
    /(^|\s)text-info(\s|$)/,
    "and it belongs to the blue line, not to the accent words",
  )
})

test("with working words the count rides beside them and brings no loader of its own", async () => {
  let loaders = 0
  await mount(
    <MessageItem
      message={reply}
      showStats
      onShowSubagents={() => {}}
      subagents={2}
      subagentsInline
    />,
    async () => {
      loaders = document.querySelectorAll('[data-slot="status-line"] [role="status"]').length
    },
  )
  assert.equal(loaders, 1, "the status line's loader serves the count too")
})

test("with no working words the count is a row of its own, with a loader in its own blue", async () => {
  const running: Message = {
    ...reply,
    tools: [
      {
        toolCallId: "t-1",
        tool: "terminal",
        label: "sleep",
        status: "running",
        startedAt: 2,
        contentOffset: 14,
      },
    ],
  }
  let row: Element | null = null
  let separator: Element | null = null
  await mount(
    <MessageItem
      message={running}
      showStats
      onShowSubagents={() => {}}
      subagents={2}
      subagentsInline
    />,
    async () => {
      row =
        [...document.querySelectorAll("button")].find((one) =>
          /2 subagents running/.test(one.textContent ?? ""),
        ) ?? null
      separator = document.querySelector('[data-slot="status-separator"]')
    },
  )
  assert.ok(row, "the count is drawn")
  assert.equal(separator, null, "with nothing to follow, there is no dot")
  assert.ok(row!.querySelector('[role="status"]'), "and it has its own loader")
  assert.match(row!.getAttribute("class") ?? "", /(^|\s)text-info(\s|$)/)
  assert.match(row!.getAttribute("class") ?? "", /min-h-\[29px\]/, "in the work rows' shape")
})
