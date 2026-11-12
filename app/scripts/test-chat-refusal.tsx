/**
 * A chat that refuses says so where the reader is: the host's own words inside the card that asked,
 * above the composer that sent, and never as a toast. A card's refusal goes when the same control
 * writes again and lands, because the words are about the attempt that caused them.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { ApprovalCard } from "@/components/chat/approval-card"
import { Composer } from "@/components/chat/composer"
import type { Message } from "@/lib/db"

import {
  click,
  composerField,
  connection,
  find,
  findText,
  missing,
  mount,
  sendPress,
  type,
  until,
  withToasts,
  wordsOf,
} from "./component-kit.tsx"

const SAID = "This bot's repository is read-only until the plan is approved."

const awaiting: Message = {
  id: "m-approve",
  conversationId: "chat-refusal",
  role: "assistant",
  content: "",
  status: "waiting",
  createdAt: 1,
  approval: {
    id: "a-1",
    description: "Write the file where the build reads it.",
    command: "npm run build",
    choices: ["once", "deny"],
    resolved: undefined,
  },
  tools: [{ toolCallId: "call-1", tool: "terminal", status: "running", startedAt: 1 }],
}

const notice = () => find('[role="alert"]')
const allowOnce = () => findText("button", "Allow once")

test("a refused approval says so in its card, and no toast", async () => {
  await withToasts(async (said) => {
    await mount(
      <ApprovalCard message={awaiting} onAnswer={() => Promise.reject(new Error(SAID))} />,
      async () => {
        await click(allowOnce())
        await until(async () => Boolean(notice()), "the card's refusal")
        assert.equal(wordsOf(notice()), SAID, "the host's own sentence")
        assert.ok(
          find('[data-slot="card"]')?.contains(notice()!),
          "drawn inside the card that asked, beside the answer it refused",
        )
        assert.deepEqual(said, [], "and nothing said in passing")
      },
    )
  })
})

test("a card's refusal goes when the same answer lands", async () => {
  let refuses = true
  let landed = false
  await mount(
    <ApprovalCard
      message={awaiting}
      onAnswer={async () => {
        if (refuses) throw new Error(SAID)
        landed = true
      }}
    />,
    async () => {
      await click(allowOnce())
      await until(async () => Boolean(notice()), "the card's refusal")
      refuses = false
      await click(allowOnce())
      // The words are about the attempt that caused them, so they go on the answer that lands —
      // not as the next one starts, which is the moment this case used to be satisfied by.
      await until(async () => landed, "the answer to land")
      await until(async () => missing('[role="alert"]'), "the refusal to go")
    },
  )
})

test("a refused send says so above the composer, and no toast", async () => {
  let refuses = true
  const send = async () => {
    if (refuses) throw new Error(SAID)
  }
  await withToasts(async (said) => {
    await mount(
      <Composer
        busy={false}
        onSend={send}
        onQueue={send}
        onStop={() => {}}
        connection={connection("chat-refusal")}
        filesFeature="yes"
        imagesAvailable
      />,
      async () => {
        await type(composerField(), "one line")
        await sendPress()
        await until(async () => Boolean(notice()), "the composer's refusal")
        assert.equal(wordsOf(notice()), SAID, "the host's own sentence")
        const field = composerField()
        assert.ok(
          field && notice()!.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING,
          "the words stand above the field they were typed in",
        )
        assert.deepEqual(said, [], "and nothing said in passing")
        // The words the host refused come back to the field, so they can be sent again.
        await until(
          async () => composerField()?.value === "one line",
          "the message back in the field",
        )
        refuses = false
        await sendPress()
        await until(async () => missing('[role="alert"]'), "the refusal to go")
      },
    )
  })
})
