/**
 * The question's own line in the thread. While the run waits the form is in the composer slot, so
 * the thread says only that it waits — a card there would repeat the question beside the one being
 * answered (reported as a question card drawn twice). Once answered, the call's result is the card's
 * only source: the message a screen like chat-next draws carries no `clarify` of its own.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { MessageItem } from "@/components/chat/message-item"
import type { Message, ToolEvent } from "@/lib/db"
import { mount, text } from "./component-kit.tsx"

const QUESTION = "Which logs should I count as old?"

const clarify: ToolEvent = {
  toolCallId: "call-question",
  tool: "clarify",
  label: QUESTION,
  status: "running",
  startedAt: 1,
  contentOffset: 0,
}

const reply = (tool: ToolEvent): Message => ({
  id: "m-1",
  conversationId: "c-1",
  role: "assistant",
  content: "",
  status: "streaming",
  createdAt: 1,
  tools: [tool],
})

async function drawn(message: Message) {
  let body = ""
  await mount(<MessageItem message={message} showStats />, async () => {
    body = text()
  })
  return body
}

test("a question still waiting says so in one line, with no card of its own", async () => {
  const body = await drawn(reply(clarify))
  assert.equal(
    body.split("Waiting for your answer").length - 1,
    1,
    `one waiting line, not two: "${body}"`,
  )
  assert.doesNotMatch(body, new RegExp(QUESTION), `the question is the composer's: "${body}"`)
  assert.doesNotMatch(body, /^Question$/, `no question card in the thread: "${body}"`)
  assert.doesNotMatch(body, /Ask again/, `nothing was missed: "${body}"`)
})

test("an answered call reads its answer, without the form", async () => {
  const answered: ToolEvent = {
    ...clarify,
    status: "completed",
    endedAt: 2,
    result: JSON.stringify({
      responses: [
        {
          question: QUESTION,
          choices_offered: ["Older than 90 days"],
          status: "answered",
          user_response: "Older than 90 days",
        },
      ],
      outcome: "submitted",
    }),
  }
  const body = await drawn(reply(answered))
  assert.match(body, /Answered/, `the card says it was answered: "${body}"`)
  assert.match(body, /Older than 90 days/, `the answer is shown: "${body}"`)
  assert.doesNotMatch(body, /No answer|Ask again/, `nothing is owed: "${body}"`)
})
