/**
 * A pull request call's row, drawn: what it says, and the sheet under it that names the call. The
 * live path is the one that breaks silently — Hermes previews the call with nothing, so the stream's
 * label and the transcript's never agree — so this file pins the running turn read from the
 * transcript, the fold that carries what only the transcript knows, and the row's own text.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { MessageItem } from "@/components/chat/message-item"
import { db, type Message, type Profile, type ToolEvent } from "@/lib/db"
import { foldTranscriptDetails, liveTurn, reconcileHistory, toMessages } from "@/lib/history"
import { PR_TOOL, phrases } from "@/lib/tools"
import type { HermesConfig, SessionMessage } from "@/lib/hermes"
import {
  click,
  connection,
  findAll,
  find,
  json,
  mount,
  seedSettings,
  settle,
} from "./component-kit.tsx"

const server: HermesConfig = connection("pr-phrase")
const SESSION = "pr-session"
const STARTED = Math.round(Date.now() / 1000) - 60
const TITLE = "feat: add a dry-run flag to log rotation"

/** The arguments Hermes's tool takes: an action, and for ship a title and a body. */
const args = (action: string) =>
  JSON.stringify({
    action,
    title: TITLE,
    body: "## Summary\n\nAdds `--dry-run`.",
    commit_message: TITLE,
  })

/** A row the transcript's parse left behind: its label is the arguments as JSON, its action stamped. */
function transcriptRow(action: string, extra: Partial<ToolEvent> = {}): ToolEvent {
  return {
    toolCallId: `call_${action}`,
    tool: PR_TOOL,
    label: args(action),
    action,
    status: "completed",
    startedAt: STARTED * 1000,
    endedAt: STARTED * 1000 + 1000,
    ...extra,
  }
}

/** A row as the live stream draws it: its label is Hermes's preview — nothing at all — and no stamp. */
function streamedRow(extra: Partial<ToolEvent> = {}): ToolEvent {
  return {
    toolCallId: "run-1:3",
    tool: PR_TOOL,
    label: PR_TOOL,
    status: "running",
    startedAt: STARTED * 1000,
    ...extra,
  }
}

function reply(tools: ToolEvent[], status: Message["status"] = "done"): Message {
  return {
    id: "m-1",
    conversationId: "c-1",
    role: "assistant",
    content: "",
    status,
    createdAt: 2,
    tools,
  }
}

function drawn(tools: ToolEvent[], body: () => Promise<void>) {
  globalThis.fetch = (async () => json({})) as typeof fetch
  return mount(
    <MessageItem
      message={reply(tools, tools.some((t) => t.status === "running") ? "streaming" : "done")}
    />,
    body,
  )
}

/** The row's own line, exactly as the summary reads. */
const summary = () => find('[data-slot="tool-group"]')?.getAttribute("aria-label") ?? ""
/** Each call's own row in the sheet the group opens. */
const callRows = () => findAll("ol li").map((row) => (row.textContent ?? "").trim())

test("each pull request action reads as what it took, not as an opening", async () => {
  await drawn(
    [
      transcriptRow("ship"),
      transcriptRow("push"),
      transcriptRow("update"),
      transcriptRow("status"),
    ],
    async () => {
      assert.equal(
        summary(),
        "Opened a pull request, pushed the branch, updated a pull request, checked a pull request",
        "four actions, four phrases, in the order they ran",
      )
      // The sheet's own rows, where the arguments-as-JSON label used to be drawn in mono.
      await click(find('[data-slot="tool-group"]'))
      const rows = callRows()
      assert.deepEqual(
        rows,
        [
          "Opened a pull request",
          "Pushed the branch",
          "Updated a pull request",
          "Checked a pull request",
        ],
        "each row says what it did, and never the arguments it fell back to",
      )
      assert.doesNotMatch(rows.join("\n"), /\{/, "no row carries the JSON beside its words")
    },
  )
})

test("a call still running reads in the present, phrased by its action", async () => {
  await drawn(
    [
      transcriptRow("ship", { status: "running", endedAt: undefined }),
      transcriptRow("push", { status: "running", endedAt: undefined }),
      transcriptRow("update", { status: "running", endedAt: undefined }),
      transcriptRow("status", { status: "running", endedAt: undefined }),
    ],
    async () => {
      assert.equal(
        summary(),
        "Opening a pull request, pushing the branch, updating a pull request, checking a pull request",
        "each action in the present while it runs",
      )
    },
  )
})

test("an action the tool never took reads as the generic row, never as a claim", async () => {
  // Merging and closing are the user's decision, so the tool refuses them: a host that streams such a
  // call anyway must not draw *Updated* over a write that never happened — nor *Opened* over anything.
  await drawn(
    [
      transcriptRow("merge"),
      transcriptRow("close"),
      streamedRow({ status: "completed", endedAt: STARTED * 1000 + 1000 }),
    ],
    async () => {
      assert.equal(summary(), "Used 3 tools", "no claimed action, the fail-toward-the-row default")
      assert.doesNotMatch(summary(), /pull request|branch/, "no phrase names a pull request")
    },
  )
})

test("a row stored before the stamp reads its action from the label it fell back to", async () => {
  await drawn(
    [
      // The transcript's JSON label, with no stamp: an old row, drawn as the call it was.
      streamedRow({ label: args("status"), status: "completed", endedAt: STARTED * 1000 + 1000 }),
      // The same shape for a call the tool never took.
      streamedRow({
        label: '{"action":"merge","pr":27}',
        status: "completed",
        endedAt: STARTED * 1000,
      }),
      // A streamed call's label is the call's title — the words of a pull request, not an action.
      streamedRow({ label: TITLE, status: "completed", endedAt: STARTED * 1000 }),
    ],
    async () => {
      assert.equal(
        summary(),
        "Checked a pull request, used 2 tools",
        "the label-only row reads its action; a title names none",
      )
    },
  )
})

test("the legacy open_pull_request tool keeps its own words", async () => {
  await drawn(
    [
      {
        toolCallId: "c-legacy",
        tool: "open_pull_request",
        label: TITLE,
        status: "completed",
        startedAt: STARTED * 1000,
        endedAt: STARTED * 1000 + 1000,
      },
    ],
    async () => {
      assert.equal(summary(), "Opened a pull request", "unchanged: it only ever opened")
    },
  )
})

/** A session row of the shape Hermes's transcript holds. */
function sessionRows(calls: { id: string; name: string; args: unknown }[], result?: string) {
  const rows: SessionMessage[] = [
    { id: 10, role: "user", content: "Ship it", timestamp: STARTED },
    {
      id: 11,
      role: "assistant",
      content: null,
      timestamp: STARTED,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    },
  ]
  if (result !== undefined)
    rows.push({
      id: 12,
      role: "tool",
      tool_call_id: calls[0].id,
      tool_name: calls[0].name,
      content: result,
      timestamp: STARTED,
    })
  return rows
}

/** Answers the transcript the session holds; everything else, an empty answer. */
function serve(rows: SessionMessage[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes("/api/sessions/") && url.includes("/messages")) {
      const limit = Number(new URL(url).searchParams.get("limit") ?? rows.length)
      const offset = Number(new URL(url).searchParams.get("offset") ?? 0)
      const data = [...rows].sort((a, b) => b.id - a.id).slice(offset, offset + limit)
      return json({ data })
    }
    return json({})
  }) as typeof fetch
}

test("a call that is still running takes its action from the transcript the chat reads mid-turn", async () => {
  // The path the app draws a live turn from: Hermes's events stream is blocked by CORS in a browser,
  // so the chat reads the running turn's transcript. The call's result row isn't written yet, so the
  // row is still running — and it must already say what it is doing.
  serve(sessionRows([{ id: "call_pr", name: PR_TOOL, args: { action: "status" } }]))
  const running = await liveTurn(server, SESSION, STARTED)
  assert.ok(running, "the running turn's reply, from its transcript")
  assert.deepEqual(
    (running.tools ?? []).map((tool) => [tool.tool, tool.status, tool.action]),
    [[PR_TOOL, "running", "status"]],
    "the call, still running, carrying the action its arguments named",
  )
  assert.deepEqual(phrases(running.tools ?? []), ["Checking a pull request"])
})

test("a streamed call takes its action from the transcript while it is still running", async () => {
  // What the chat does as such a call starts: it reads the turn's transcript once and folds in only
  // what the stream couldn't know. The row keeps the label and the status this device drew.
  serve(sessionRows([{ id: "call_pr", name: PR_TOOL, args: { action: "update" } }], undefined))
  const reply = await liveTurn(server, SESSION, STARTED)
  const tools = foldTranscriptDetails([streamedRow()], reply?.tools ?? [])
  assert.deepEqual(
    tools?.map((tool) => [tool.label, tool.action, tool.status]),
    [[PR_TOOL, "update", "running"]],
    "still the stream's row, now saying what it is doing",
  )
  assert.deepEqual(phrases(tools ?? []), ["Updating a pull request"])
})

test("a streamed row keeps its place when the transcript holds no matching call", async () => {
  // The fold pairs a call Hermes previews with nothing by its place in the run, and only where both
  // sides count the same: a truncated list leaves the row as it stands rather than borrowing the
  // words — or the status — of another call.
  const tools = foldTranscriptDetails(
    [streamedRow()],
    [transcriptRow("ship"), transcriptRow("status")],
  )
  assert.equal(tools, undefined, "nothing to fold in, so nothing changes")
})

test("a streamed row gains its action when catch-up folds the transcript in", async () => {
  // The turn as this device drew it while the call streamed, then as Hermes wrote it. The labels
  // never agree — Hermes previews a pull request with nothing, so the stream's is the tool's name and
  // the transcript's is the arguments as JSON — so the fold has to match them some other way.
  await seedSettings({ onboarded: true })
  await db.profiles.clear()
  await db.conversations.clear()
  await db.messages.clear()
  const profile: Profile = {
    id: "bot-1",
    name: "A bot",
    baseUrl: server.baseUrl,
    apiKey: "test-key",
    model: "test/model",
    botId: "bot-1",
    createdAt: 1,
    updatedAt: 1,
  }
  await db.profiles.put(profile)
  await db.conversations.put({
    id: "c-pr",
    profileId: profile.id,
    title: "A chat",
    hermesSessionId: SESSION,
    hermesTip: 10,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
  await db.messages.bulkPut([
    {
      id: "u-1",
      conversationId: "c-pr",
      role: "user",
      content: "Ship it",
      status: "done",
      createdAt: STARTED * 1000,
    },
    {
      ...reply([streamedRow({ status: "completed", endedAt: STARTED * 1000 + 1000 })]),
      id: "a-1",
      conversationId: "c-pr",
      createdAt: STARTED * 1000 + 1,
    },
  ])
  serve(
    sessionRows(
      [{ id: "call_pr", name: PR_TOOL, args: { action: "ship", title: TITLE } }],
      JSON.stringify({
        results: [{ name: "repo", pushed: true, pr: { number: 27, title: TITLE } }],
      }),
    ),
  )
  await reconcileHistory("c-pr")
  await settle()
  const stored = await db.messages.get("a-1")
  const tool = stored?.tools?.[0]
  assert.equal(tool?.action, "ship", "the streamed row took the action its arguments named")
  assert.equal(tool?.label, PR_TOOL, "and kept the label the stream gave it")
  assert.deepEqual(
    phrases(stored?.tools ?? []),
    ["Opened a pull request"],
    "so it reads as the ship",
  )
})

test("the transcript parse stamps the action and keeps the JSON label", () => {
  // What the ingest writes: the one derivation the thread and the phrase table both read.
  const parsed = toMessages(
    "c-1",
    SESSION,
    sessionRows([{ id: "call_pr", name: PR_TOOL, args: { action: "update" } }]),
    { live: true },
  ).find((message) => message.role === "assistant")
  const tool = parsed?.tools?.[0]
  assert.equal(tool?.action, "update")
  assert.equal(
    tool?.label,
    '{"action":"update"}',
    "the arguments as JSON: no preview, no primary argument",
  )
  assert.deepEqual(phrases(parsed.tools ?? []), ["Updating a pull request"])
})
