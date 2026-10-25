/**
 * What a reply draws for cron calls: each action the call took, never "Used a tool" — and never a
 * claim about a job it didn't touch. The words themselves are `test-cron-words.mjs`'s.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { MessageItem } from "@/components/chat/message-item"
import type { Message, ToolEvent } from "@/lib/db"
import { toMessages } from "@/lib/history"
import { CRON_TOOL } from "@/lib/tools"
import { click, findAll, find, mount } from "./component-kit.tsx"

/** A cron call as the thread keeps it: its label, its status, and the stamp where it has one. */
function call(toolCallId: string, label: string, extra: Partial<ToolEvent> = {}): ToolEvent {
  return {
    toolCallId,
    tool: CRON_TOOL,
    label,
    status: "completed",
    startedAt: 1,
    endedAt: 2,
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

const toolRow = () => find('[data-slot="tool-group"]')
/** Each call's own row in the sheet the group opens, which is where a call's words are read. */
const callRows = () => findAll("ol li").map((row) => (row.textContent ?? "").trim())

test("a reply of cron calls says each action it took, not that a tool was used", async () => {
  await mount(
    <MessageItem
      message={reply([
        // Stamped by the transcript parse, its label the action word.
        call("c-create", "create", { action: "create" }),
        call("c-list", "list", { action: "list" }),
        call("c-run", "run", { action: "run" }),
        // Stored before the stamp existed: the label alone, read against the tool's own actions.
        call("c-pause", "pause"),
        // An action the table doesn't know: a tool row, as any unrecognised call is.
        call("c-unknown", '{"action":"frobnicate","name":"nightly"}', { action: "frobnicate" }),
      ])}
    />,
    async () => {
      const row = toolRow()
      assert.ok(row, "the calls drew as one tool group")
      assert.equal(
        row.getAttribute("aria-label"),
        "Created a cron job, listed cron jobs, ran a cron job, paused a cron job, used a tool",
        "the row's line, each action once, in the order it happened",
      )
      await click(row)
      const rows = callRows()
      assert.deepEqual(
        rows.slice(0, 4),
        ["Created a cron job", "Listed cron jobs", "Ran a cron job", "Paused a cron job"],
        "each call's own row says the action it took, and repeats no action word",
      )
      assert.match(rows[4], /^Used /, "and the action the table doesn't know is a generic tool row")
      assert.doesNotMatch(rows[4], /cron job/, "never a job it did not touch")
      assert.doesNotMatch(rows[4], /\{/, "nor the arguments the label fell back to")
    },
  )
})

test("a cron call reads in the present while it runs", async () => {
  await mount(
    <MessageItem
      message={reply([
        call("c-list", "list", { action: "list", status: "running", endedAt: undefined }),
      ])}
    />,
    async () => {
      const row = toolRow()
      assert.equal(
        row?.getAttribute("aria-label"),
        "Listing cron jobs",
        "the present, while it runs",
      )
      await click(row)
      assert.deepEqual(callRows(), ["Listing cron jobs"], "the sheet's row says the same")
    },
  )
})

test("the transcript stamps the action each cron call's arguments named", () => {
  // What the ingest writes, which only the app's own module graph can run: the label beside the
  // stamp is the same word, so the row's words survive a reload with no migration.
  const [reply] = toMessages("c-1", "s-1", [
    {
      id: 1,
      role: "assistant",
      content: null,
      timestamp: 1,
      tool_calls: [
        {
          id: "c-create",
          function: {
            name: CRON_TOOL,
            arguments: '{"action":"create","name":"nightly","schedule":"0 3 * * *"}',
          },
        },
        { id: "c-list", function: { name: CRON_TOOL, arguments: '{"action":"list"}' } },
        // A call whose arguments named no action at all: the label is its arguments, not a word.
        { id: "c-bare", function: { name: CRON_TOOL, arguments: '{"name":"nightly"}' } },
        // The deferred-tool bridge names the real call in its own arguments.
        {
          id: "c-wrapped",
          function: {
            name: "tool_call",
            arguments: `{"calls":[{"name":"${CRON_TOOL}","arguments":{"action":"resume","job_id":"j1"}}]}`,
          },
        },
      ],
    },
  ])
  const tools = reply.tools ?? []
  assert.deepEqual(
    tools.map((tool) => [tool.label, tool.action]),
    [
      ["create", "create"],
      ["list", "list"],
      ['{"name":"nightly"}', undefined],
      ["resume", "resume"],
    ],
    "each call's words and its stamped action",
  )
})
