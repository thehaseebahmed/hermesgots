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

test("with a call running the count is the line's only words, and turns no loader of its own", async () => {
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
  let line: Element | null = null
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
      line = document.querySelector('[data-slot="status-line"]')
      row =
        [...document.querySelectorAll("button")].find((one) =>
          /2 subagents running/.test(one.textContent ?? ""),
        ) ?? null
      separator = document.querySelector('[data-slot="status-separator"]')
    },
  )
  assert.ok(line, "the call's own row speaks, and the line keeps the count on it")
  assert.ok(row, "the count is drawn")
  assert.ok(line!.contains(row), "inside the status line, never as a row below it")
  assert.equal(separator, null, "with nothing to follow, there is no dot")
  assert.equal(
    line!.querySelectorAll('[role="status"]').length,
    0,
    "and no loader turns beside it: the tool row's is the one the reply is turning",
  )
  assert.match(row!.getAttribute("class") ?? "", /(^|\s)text-info(\s|$)/)
  assert.match(row!.getAttribute("class") ?? "", /min-h-\[29px\]/, "in the work rows' shape")
})

test("a finished turn's count is the line's only words, its loader turning in the blue", async () => {
  const done: Message = { ...reply, status: "done" }
  let line: Element | null = null
  let row: Element | null = null
  let counts = 0
  await mount(
    <MessageItem
      message={done}
      showStats
      onShowSubagents={() => {}}
      subagents={2}
      subagentsInline
    />,
    async () => {
      line = document.querySelector('[data-slot="status-line"]')
      row =
        [...document.querySelectorAll("button")].find((one) =>
          /2 subagents running/.test(one.textContent ?? ""),
        ) ?? null
      counts = [...document.querySelectorAll("button")].filter((one) =>
        /subagents? running/.test(one.textContent ?? ""),
      ).length
    },
  )
  assert.ok(line, "the turn is done and its subagents still run, so the line stands")
  assert.ok(row, "holding the count")
  assert.ok(line!.contains(row), "as the line's own words, not a row beneath it")
  assert.equal(
    document.querySelectorAll("[data-slot=status-words]").length,
    0,
    "with no words of its own",
  )
  const loader = row!.querySelector('[role="status"]')
  assert.ok(loader, "and its loader turns beside it")
  assert.match(row!.getAttribute("class") ?? "", /(^|\s)text-info(\s|$)/, "in the info blue")
  assert.doesNotMatch(
    loader?.getAttribute("class") ?? "",
    /text-(primary|muted-foreground)/,
    "the loader takes the count's blue rather than a colour of its own",
  )
  assert.equal(counts, 1, "and it is drawn once, never twice")
})
