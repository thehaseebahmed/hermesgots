/**
 * What a delegation's control call says on its row: the action it took, in the past once the call is
 * over and in the present while it runs. The words come from the same derivation the rest of the
 * thread asks (ADR 0053), so a row may say less than the truth, never more.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { AgentsContext } from "@/lib/agents"
import { MessageItem } from "@/components/chat/message-item"
import type { Message, ToolEvent } from "@/lib/db"
import type { HermesConfig } from "@/lib/hermes"
import { DELEGATE_TOOL } from "@/lib/spawn"
import { connection, find, json, mount, text } from "./component-kit.tsx"

const server: HermesConfig = connection("control-action-words")

/** A `delegate_task` call stored as the thread keeps it. */
function call(toolCallId: string, label: string, extra: Partial<ToolEvent> = {}): ToolEvent {
  return {
    toolCallId,
    tool: DELEGATE_TOOL,
    label,
    status: "completed",
    startedAt: 1_000,
    endedAt: 2_000,
    ...extra,
  }
}

function reply(tools: ToolEvent[]): Message {
  return {
    id: "m-1",
    conversationId: "c-1",
    role: "assistant",
    content: "",
    status: "done",
    createdAt: 2,
    tools,
  }
}

function drawn(tools: ToolEvent[], body: () => Promise<void>) {
  globalThis.fetch = (async () => json({})) as typeof fetch
  return mount(
    <AgentsContext.Provider value={{ agents: [], server, sessionId: "parent-session" }}>
      <MessageItem message={reply(tools)} />
    </AgentsContext.Provider>,
    body,
  )
}

/** The row's own line: what the group of calls says it did, uncut, for its tap target's name. */
const rowWords = () => find('[data-slot="tool-group"]')?.getAttribute("aria-label") ?? ""

test("a finished control call says which action it took, one phrase per action", async () => {
  await drawn(
    [
      call("c-list", "list", { action: "list" }),
      call("c-steer", "steer sub-1", { action: "steer" }),
      call("c-stop", "stop sub-2", { action: "stop" }),
    ],
    async () => {
      assert.equal(rowWords(), "Listed subagents, steered subagent, stopped subagent")
      assert.doesNotMatch(text(), /Used a tool/, "none of them is a nameless tool any more")
    },
  )
})

test("a running control call says its action in the present", async () => {
  await drawn([call("c-list", "list", { action: "list", status: "running" })], async () => {
    assert.equal(rowWords(), "Listing subagents")
  })
})

test("a running steer says it is steering, not that it steered", async () => {
  await drawn(
    [call("c-steer", "steer sub-1", { action: "steer", status: "running" })],
    async () => {
      assert.equal(rowWords(), "Steering subagent")
    },
  )
})

test("a running stop says it is stopping, not that it stopped", async () => {
  await drawn([call("c-stop", "stop sub-2", { action: "stop", status: "running" })], async () => {
    assert.equal(rowWords(), "Stopping subagent")
  })
})

test("a control row stored before the stamp reads the same words from its label alone", async () => {
  // Both shapes a label arrives in: the stream's preview words, and the JSON envelope that fell
  // back before the label was derived. Same reply, same words as the stamped calls above.
  await drawn(
    [
      call("c-list-legacy", "list"),
      call("c-steer-legacy", "steer sub-1"),
      call("c-stop-legacy", '{"action":"stop","subagent_id":"sub-2"}'),
    ],
    async () => {
      assert.equal(
        rowWords(),
        "Listed subagents, steered subagent, stopped subagent",
        "a reloaded chat says what it said while it streamed",
      )
    },
  )
})

test("an action the phrase table does not know keeps the generic tool row", async () => {
  // The stamp is authority over the label: a call whose arguments named something the table has no
  // words for is not dressed up as the action its label guessed.
  await drawn([call("c-unknown", "list", { action: "archive" })], async () => {
    assert.equal(rowWords(), "Used a tool")
  })
})

test("a delegation with no action and no label to read keeps the generic tool row", async () => {
  await drawn([call("c-bare", "delegate_task")], async () => {
    assert.equal(rowWords(), "Used a tool")
  })
})
