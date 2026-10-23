/**
 * What a thread draws while the host decides where a message goes: the message itself, and nothing
 * else. The status is data, so this compares what the row draws for each of them — no class name and
 * no computed style, with a control case to prove the comparison can disagree (ADR 0019).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { MessageItem } from "@/components/chat/message-item"
import type { Message } from "@/lib/db"
import { mount } from "./component-kit.tsx"

const message = (status: Message["status"]): Message => ({
  id: "m-1",
  conversationId: "c-1",
  role: "user",
  content: "Something for the host to place",
  status,
  createdAt: 1,
})

async function drawn(status: Message["status"]) {
  let html = ""
  await mount(<MessageItem message={message(status)} showStats />, async () => {
    html = document.body.innerHTML
  })
  return html
}

test("a message the host is triaging draws as any message the user sent", async () => {
  assert.equal(await drawn("triaging"), await drawn("done"), "the same bubble, and no line under it")
})

test("a message that failed is the one that wears a mark, so the comparison can disagree", async () => {
  assert.notEqual(await drawn("error"), await drawn("done"), "a failed message says it didn't go")
})
