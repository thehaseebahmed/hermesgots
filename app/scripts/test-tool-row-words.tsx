/** What a tool row puts beside its verb, and what its sheet says (ADR 0096, ADR 0098). */
import assert from "node:assert/strict"
import test from "node:test"

import { MessageItem } from "@/components/chat/message-item"
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

test("a failed group says so under its words, and its own row keeps the muted tone", async () => {
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
      const label = row?.querySelector("span")
      assert.equal(
        row?.firstElementChild,
        label,
        "the words lead the row: no mark stands ahead of them (ADR 0092)",
      )
      assert.equal(row?.querySelector('[data-slot="work-sign"]'), null, "and no sign is drawn")
      assert.doesNotMatch(
        label?.className ?? "",
        /text-destructive/,
        "the row's own words keep the muted tone: what failed is said under them (ADR 0096)",
      )
      assert.match(
        row?.getAttribute("aria-label") ?? "",
        /(^|,\s)failed$/,
        "the row's own name is what says it failed",
      )
      const reason = find('[data-slot="tool-group-reason"]')
      assert.equal(reason?.textContent, "Exited 2", "the host's reason stands under the label")
      assert.match(
        reason?.className ?? "",
        /text-destructive/,
        "and carries the failure's colour alone",
      )
      assert.doesNotMatch(
        reason?.className ?? "",
        /pl-6/,
        "on the row's own edge: there is no sign to clear",
      )
      assert.equal(
        reason?.previousElementSibling?.getAttribute("data-slot"),
        "tool-group",
        "and it follows the row it explains",
      )
    },
  )
})

/**
 * jsdom measures nothing, so a case that needs a fit lends the page its own widths — the row's
 * `clientWidth`, and the width of a line drawn in it. Answers the undo, since these prototypes outlive
 * the case.
 */
function withLayout(room: number) {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => room })
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: Element) {
      return (this.textContent ?? "").length * 7
    },
  })
  return () => {
    for (const name of ["clientWidth", "offsetWidth"])
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
  }
}

test("a cut row says its count, and the sheet it opens names the whole run", async () => {
  // The row needs a width for a cut to exist at all: with no room the fit leaves every phrase in the
  // line, and the heading assertion below would be comparing it with itself.
  const calls = [
    call("c-1", "terminal", "ls"),
    call("c-2", "read_file", "/etc/hosts"),
    call("c-3", "patch", "/etc/hosts"),
    call("c-4", "write_file", "/etc/notes"),
  ]
  const restore = withLayout(220)
  try {
    await mount(<MessageItem message={reply(calls)} />, async () => {
      const row = find('[data-slot="tool-group"]')
      assert.match(
        row?.textContent ?? "",
        /\(\+\d+\)$/,
        "the row cuts its line, and says how many phrases it left out",
      )
      await click(row)
      const heading = find("h2")
      assert.equal(
        heading?.textContent,
        "Ran a command, read a file, edited a file, created a file",
        "while the heading says every phrase the run holds",
      )
      assert.doesNotMatch(heading?.textContent ?? "", /\(\+\d+\)/, "and carries no cut count")
      assert.equal(callRows().length, 4, "with one row per call beneath it")
    })
  } finally {
    restore()
  }
})

test("a call the reader refused wears no failure, and its sheet says so", async () => {
  await mount(
    <MessageItem
      message={reply([
        {
          ...call("c-no", "terminal", "rm -rf /var/log"),
          status: "refused",
          result: JSON.stringify({
            output: "",
            exit_code: -1,
            error: "BLOCKED: Command denied by user.",
            status: "blocked",
          }),
        },
      ])}
    />,
    async () => {
      const row = find('[data-slot="tool-group"]')
      assert.doesNotMatch(row?.getAttribute("aria-label") ?? "", /failed/, "the row is not a failure")
      assert.equal(find('[data-slot="tool-group-reason"]'), null, "and draws no reason under it")
      await click(row)
      await click(find("ol li button"))
      const sheets = [...document.querySelectorAll("[data-popup-form]")]
        .map((one) => one.textContent ?? "")
        .join(" ")
      assert.match(sheets, /Refused/, "the call's sheet says it was refused, not Completed")
      assert.doesNotMatch(sheets, /Exit code/, "and reports no exit code for a command that never ran")
      assert.equal(
        document.querySelectorAll("[data-popup-form] .text-destructive").length,
        0,
        "nothing in its sheet wears the failure's colour",
      )
    },
  )
})
