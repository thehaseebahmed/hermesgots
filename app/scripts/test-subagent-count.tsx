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
