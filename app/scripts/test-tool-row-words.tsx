/**
 * What a tool row puts beside its verb: the call's own words, and never the arguments a transcript
 * row fell back to. The decision is whether the label reads as an envelope, not whether it opens on
 * a brace — a command that starts with `{` is the words it is.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { MessageItem } from "@/components/chat/message-item"
import { WORK_LABEL_FLUSH } from "@/components/chat/work-row"
import type { Message, ToolEvent } from "@/lib/db"
import { PR_TOOL } from "@/lib/tools"
import { click, findAll, find, mount } from "./component-kit.tsx"

/** A call as the thread keeps it: its tool and the label its arguments were worded into. */
function call(toolCallId: string, tool: string, label: string): ToolEvent {
  return { toolCallId, tool, label, status: "completed", startedAt: 1, endedAt: 2 }
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

/** Each call's own row in the sheet the group opens, which is where its words are read. */
const callRows = () => findAll("ol li").map((row) => (row.textContent ?? "").trim())

test("a row drops an envelope's arguments but keeps words that only open on a brace", async () => {
  // A pull request call's transcript label is its arguments as JSON; a terminal command that starts
  // with `{` is not an envelope, so its words stay on the row.
  await mount(
    <MessageItem
      message={reply([
        call("c-brace", "terminal", "{ cat package.json; }"),
        call("c-pr", PR_TOOL, '{"action":"status","number":7}'),
      ])}
    />,
    async () => {
      await click(find('[data-slot="tool-group"]'))
      const rows = callRows()
      assert.equal(rows[0], "Ran { cat package.json; }", "the command's own words")
      assert.doesNotMatch(rows[1], /\{/, "the arguments never stand in for the row's words")
      assert.equal(rows[1], "Checked a pull request", "and the action words the call itself")
    },
  )
})

test("a failed group wears no mark before its words, and its reason stands flush under them", async () => {
  await mount(
    <MessageItem
      message={reply([
        {
          ...call("c-fail", "terminal", "ls -la"),
          status: "failed",
          error: "Exited 2",
        },
      ])}
    />,
    async () => {
      const row = find('[data-slot="tool-group"]')
      // No row a reply draws wears a mark of its own (ADR 0062): the label is the row's first child,
      // so nothing can sit in front of the words without this failing.
      assert.equal(row?.firstElementChild?.tagName, "SPAN", "the words lead the row")
      assert.equal(row?.querySelector('[aria-label="Failed"]'), null, "and no mark precedes them")
      assert.match(
        row?.getAttribute("aria-label") ?? "",
        /a call failed/,
        "the row's own name is what says it failed",
      )
      const reason = find('[data-slot="tool-group-reason"]')
      assert.equal(reason?.textContent, "Exited 2", "the host's reason stands under the label")
      assert.match(
        reason?.className ?? "",
        new RegExp(`(^|\\s)${WORK_LABEL_FLUSH}(\\s|$)`),
        "flush under the words rather than on a gap",
      )
    },
  )
})
