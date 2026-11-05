/** A terminal call Hermes previews as "first + N commands" reads whole once the transcript is folded in. */
import assert from "node:assert/strict"
import test from "node:test"

import type { ToolEvent } from "@/lib/db"
import { foldTranscriptDetails } from "@/lib/history"
import { isCountedPreview } from "@/lib/tool-preview"

const call = (toolCallId: string, label: string): ToolEvent => ({
  toolCallId,
  tool: "terminal",
  label,
  status: "completed",
  startedAt: 1,
  endedAt: 2,
})

test("a counted preview is read for the whole command", () => {
  assert.ok(isCountedPreview("terminal", "sleep 8 + 1 command"))
  assert.ok(isCountedPreview("terminal", "which gh + 3 commands"))
  assert.ok(!isCountedPreview("terminal", "ls -la"))
  assert.ok(!isCountedPreview("read_file", "a + 1 command"))
})

test("the fold swaps the counted preview for the command, and leaves plain rows alone", () => {
  const whole = "which gh; gh auth status; echo a; echo b"
  const tools = foldTranscriptDetails(
    [call("a", "which gh + 3 commands"), call("b", "ls -la")],
    [call("a", whole), call("b", "ls -la")],
  )
  assert.deepEqual(tools?.map((tool) => tool.label), [whole, "ls -la"])
})

test("a list of another length is left as it stands", () => {
  const tools = foldTranscriptDetails([call("a", "sleep 8 + 1 command")], [])
  assert.equal(tools, undefined)
})
