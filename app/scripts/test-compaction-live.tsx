/**
 * A run that compacts mid-turn, read the two ways the app reads it: the running turn polled from the
 * transcript (`liveTurn`), and the chat opened afterwards (`reconcileHistory`). Shaped on real
 * transcripts: the summary is a row of its own (assistant or user role), the turn's earlier work is
 * carried forward under fresh ids with its old times, and the request is restated after it with the
 * task list under it — whose ids are free-form words, not numbers.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  REPLAY_HEADER,
  RELOAD_NOTICE_BODY,
  RELOAD_NOTICE_HEADER,
  SUMMARY_END,
  SUMMARY_HEADER,
  TASK_SNAPSHOT_HEADER,
} from "@/lib/compaction-seam"
import { getMessages } from "@/lib/db"
import { liveTurn, reconcileHistory, toMessages } from "@/lib/history"
import type { SessionMessage } from "@/lib/hermes"

import {
  botProfile,
  chatScreen,
  connection,
  findAll,
  json,
  mount,
  seedChat,
  serveTranscript as serve,
  transcriptRows,
  until,
} from "./component-kit.tsx"

const SESSION = "compact-session"
const REQUEST = "Ask me that again."
const SUMMARY_TEXT = "SUMMARY-OF-EARLIER-WORK"
const SUMMARY = [`${SUMMARY_HEADER} Earlier turns were compacted.`, SUMMARY_TEXT, SUMMARY_END].join(
  "\n",
)
const SNAPSHOT = [
  TASK_SNAPSHOT_HEADER,
  "- [>] plugin. Plugin: store table (in_progress)",
  "- [ ] app-data. App: Dexie mirror (pending)",
].join("\n")
const NOTICE = `${RELOAD_NOTICE_HEADER}\n${RELOAD_NOTICE_BODY} verbatim, but the skills were pruned.`

const { row, call, result, pair, reset } = transcriptRows(100)

type Run = {
  summaryRole: "assistant" | "user"
  restated: boolean
  carried?: number
  amid?: "subagent" | "steer"
}

function run({ summaryRole, restated, carried = 3, amid }: Run) {
  reset(100)
  const rows: SessionMessage[] = [
    row("user", "An earlier ask"),
    row("assistant", "An earlier answer"),
  ]
  rows.push(row(summaryRole, SUMMARY))
  for (let i = 0; i < carried; i++) {
    rows.push(...pair("terminal", i === 0 ? "Carried words" : undefined))
    if (i === 0 && amid === "subagent")
      rows.push({
        ...row("user", "[ASYNC DELEGATION COMPLETE — a]\nA finding"),
        display_kind: "async_delegation_complete",
      })
    if (i === 0 && amid === "steer")
      rows.push({
        ...row("user", "[OUT-OF-BAND USER MESSAGE]\nAlso this\n[/OUT-OF-BAND USER MESSAGE]"),
        display_kind: "steer",
      })
  }
  if (restated) rows.push(row("user", `${REPLAY_HEADER}\n${REQUEST}\n\n${SNAPSHOT}\n\n${NOTICE}`))
  rows.push(...pair("patch", "After one"))
  rows.push(...pair("terminal"))
  rows.push(row("assistant", "After two"))
  return rows
}

const server = connection("compaction-live")

async function replies(rows: SessionMessage[], from: number, content: string) {
  const seen: { tools: number; content: string }[] = []
  for (let n = from; n <= rows.length; n++) {
    serve(rows.slice(0, n))
    const reply = await liveTurn(server, SESSION, content)
    if (reply) seen.push({ tools: reply.tools?.length ?? 0, content: reply.content })
  }
  return seen
}

for (const [name, opts, content] of [
  [
    "a restated request, the summary an assistant row",
    { summaryRole: "assistant", restated: true },
    REQUEST,
  ],
  [
    "a restated request, a long run before the boundary",
    { summaryRole: "assistant", restated: true, carried: 60 },
    REQUEST,
  ],
  [
    "an archived request, the summary a user row",
    { summaryRole: "user", restated: false },
    "archived ask",
  ],
] as const) {
  test(`the running turn keeps growing across a compaction: ${name}`, async () => {
    const rows = run(opts)
    const seen = await replies(rows, 3, content)
    assert.ok(seen.length > 0, "the turn is found once it has work")
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i].tools >= seen[i - 1].tools, "a call already drawn never leaves the turn")
      assert.ok(
        seen[i].content.startsWith(seen[i - 1].content) ||
          seen[i].content.includes(seen[i - 1].content),
        `text already drawn stays: ${JSON.stringify(seen[i - 1].content)} → ${JSON.stringify(seen[i].content)}`,
      )
    }
    const last = seen.at(-1)!
    const carried = opts.carried ?? 3
    assert.equal(last.tools, carried + 2, "every call, before the boundary and after it")
    assert.ok(!last.content.includes(SUMMARY_TEXT), "the summary is not the reply's words")
    const at = (s: string) => last.content.indexOf(s)
    assert.ok(
      at("Carried words") >= 0 &&
        at("After one") > at("Carried words") &&
        at("After two") > at("After one"),
      `the words before and after the boundary, in order: ${JSON.stringify(last.content)}`,
    )
  })
}

test("a chat opened after a compaction shows the turn's words before and after it, and not the summary", async () => {
  const rows = run({ summaryRole: "assistant", restated: true })
  serve(rows)
  const profile = botProfile("compaction-live")
  await seedChat({ id: "chat-live", profile, messages: [], hermesSessionId: SESSION })
  await reconcileHistory("chat-live")
  const drawn = (await getMessages("chat-live")).map((m) => `${m.role}: ${m.content}`)
  const text = drawn.join("\n")
  assert.ok(!text.includes(SUMMARY_TEXT), `the summary is not drawn: ${text.slice(0, 300)}`)
  for (const words of [
    "An earlier ask",
    "An earlier answer",
    REQUEST,
    "Carried words",
    "After one",
    "After two",
  ])
    assert.ok(text.includes(words), `${words} is drawn: ${text}`)
  assert.ok(
    text.indexOf(REQUEST) < text.indexOf("Carried words"),
    `the turn's carried work follows its request: ${text}`,
  )
})

test("the thread draws one divider where the run compacted, and the words around it, and not the summary", async () => {
  const rows = run({ summaryRole: "assistant", restated: true })
  const summary = rows.findIndex((r) => (r.content ?? "").startsWith("[CONTEXT"))
  const request = rows.findIndex((r) => (r.content ?? "").startsWith("[STILL"))
  rows.forEach((r, i) => {
    r.timestamp =
      i < summary
        ? 1_000 + i
        : i === summary
          ? 5_000
          : i < request
            ? 4_000 + i
            : i === request
              ? 3_000
              : 5_000 + i
  })
  const host = [...rows]
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (/\/messages$/.test(url.pathname)) {
      if (url.searchParams.has("include_compacted")) return json({ data: [] })
      const limit = Number(url.searchParams.get("limit"))
      const offset = Number(url.searchParams.get("offset"))
      return json({
        data: [...host]
          .sort((a, b) => b.id - a.id)
          .slice(offset, offset + limit)
          .reverse(),
      })
    }
    if (/\/context$/.test(url.pathname))
      return json({
        object: "memento.context",
        prompt_tokens: 4_200,
        compactions: [{ at: 5_000_000 }],
      })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
  const profile = botProfile("compaction-thread-live")
  await seedChat({ id: "chat-marked", profile, messages: [] })
  await reconcileHistory("chat-marked")
  let seen = { dividers: 0, html: "" }
  await mount(chatScreen("chat-marked"), async () => {
    await until(async () => findAll("[data-slot=message]").length > 1, "the thread's rows")
    await import("@/components/chat/markdown-renderer")
    await until(async () => findAll("[role=separator]").length > 0, "the divider")
    const scroller = findAll("[data-slot=message-scroller-item]")
    seen = {
      dividers: findAll("[role=separator]").length,
      html: scroller.map((item) => item.innerHTML).join(""),
    }
  })
  assert.equal(seen.dividers, 1, "one divider")
  // An in-place mark carries no size, so a divider drawn inside a reply says only what it is.
  assert.ok(seen.html.includes(">Compaction<"), "the divider names the compaction")
  assert.ok(!seen.html.includes(SUMMARY_TEXT), "the summary is not drawn")
  const place = (what: string) => seen.html.indexOf(what)
  const divider = seen.html.indexOf('role="separator"')
  for (const words of ["An earlier answer", REQUEST, "Carried words", "After one", "After two"])
    assert.ok(place(words) >= 0, `${words} is drawn`)
  assert.ok(
    place(REQUEST) < place("Carried words") && place("Carried words") < divider,
    "the request and the work done before the compaction sit above the line",
  )
  assert.ok(divider < place("After one"), "what the run did after it sits below the line")
})

const shape = (rows: SessionMessage[], options?: { hostOrder?: boolean }) =>
  toMessages("c", SESSION, rows, options).map(
    (m) =>
      `${m.role}: ${m.content.replace(/\n+/g, " / ")} [${m.tools?.length ?? 0} calls, ${m.seams?.length ?? 0} seams]`,
  )

for (const amid of ["subagent", "steer"] as const)
  test(`a ${amid} inside the carried work still leaves it under the request`, () => {
    const drawn = shape(run({ summaryRole: "assistant", restated: true, amid }))
    assert.deepEqual(
      drawn.slice(0, 3),
      [
        "user: An earlier ask [0 calls, 0 seams]",
        "assistant: An earlier answer [0 calls, 0 seams]",
        `user: ${REQUEST} [0 calls, 0 seams]`,
      ],
      `the earlier answer is left alone: ${drawn.join(" | ")}`,
    )
    assert.equal(drawn.length, 4, `one reply for the turn: ${drawn.join(" | ")}`)
    assert.match(
      drawn[3],
      /^assistant: Carried words \/ After one \/ After two \[5 calls, 1 seams\]$/,
    )
  })

test("a tool's result that opens with the summary's words is still its result", () => {
  reset(100)
  const reading = call("read_file", "Reading the old summary")
  const answered = { ...result(reading), content: SUMMARY }
  const reply = toMessages("c", SESSION, [row("user", "Read it"), reading, answered], {
    live: true,
  }).find((m) => m.role === "assistant")
  assert.deepEqual(
    reply?.tools?.map((tool) => [tool.status, tool.result]),
    [["completed", SUMMARY]],
    "the call finished, with the file's words as its result",
  )
})

test("carried work longer than every page the live read takes still comes back", async () => {
  const rows = run({ summaryRole: "assistant", restated: true, carried: 300 })
  serve(rows)
  const reply = await liveTurn(server, SESSION, REQUEST)
  assert.ok(reply, "the running turn is found")
  assert.ok(
    reply.content.includes("After two") && (reply.tools?.length ?? 0) >= 2,
    `at least what the run did after the boundary: ${reply.tools?.length} calls`,
  )
})

test("the archive's rows read the same way: no summary drawn, the divider where it fell", () => {
  const drawn = shape(run({ summaryRole: "assistant", restated: true }))
  assert.ok(!drawn.join(" ").includes(SUMMARY_TEXT), `no summary: ${drawn.join(" | ")}`)
  assert.equal(drawn.filter((line) => line.endsWith(", 1 seams]")).length, 1, drawn.join(" | "))
})

test("a summary the host folded the user's message into draws that message, and only that", () => {
  // Hermes writes the next user message under the summary's end line in the same row.
  reset(100)
  const folded = `${SUMMARY}\n\nWhy did it say this?`
  assert.deepEqual(shape([row("user", folded)]), ["user: Why did it say this? [0 calls, 0 seams]"])
})

test("a message that only quotes a summary mid-text stays the user's", () => {
  reset(100)
  const quoting = `As the note said:\n${SUMMARY}\nthat was hours ago.`
  assert.deepEqual(shape([row("user", quoting)]), [
    `user: ${quoting.replace(/\n+/g, " / ")} [0 calls, 0 seams]`,
  ])
})

test("the host's own flag names a summary the text alone would not", () => {
  reset(100)
  const rows = [row("user", "Ask"), row("assistant", "Before"), row("assistant", "Odd handoff")]
  rows.push(...pair("terminal", "After"))
  assert.equal(
    shape(rows).join(" | ").includes("Odd handoff"),
    true,
    "no flag: it is the reply's words",
  )
  const flagged = new Set([rows[2].id])
  const drawn = toMessages("c", SESSION, rows, { summaries: flagged }).map((m) => m.content)
  assert.ok(!drawn.join(" ").includes("Odd handoff"), `flagged: not drawn: ${drawn.join(" | ")}`)
})

test("a summary stamped after the carried copies sits where the compaction fell", () => {
  // Carried copies keep their old times; the summary is stamped with the moment it ran, so the
  // rows written after it are the ones that follow it — not the carried ones.
  reset(100)
  const rows = run({ summaryRole: "assistant", restated: true })
  const summary = rows.findIndex((r) => (r.content ?? "").startsWith("[CONTEXT"))
  const request = rows.findIndex((r) => (r.content ?? "").startsWith("[STILL"))
  rows.forEach((r, i) => {
    r.timestamp =
      i < summary ? 1_000 + i : i === summary ? 5_000 : i <= request ? 4_000 + i : 5_001 + i
  })
  const reply = toMessages("c", SESSION, rows).find((m) => m.role === "assistant" && m.seams)
  assert.equal(reply?.seams?.length, 1)
  assert.equal(reply?.seams?.[0].toolsBefore, 3, "the three carried calls are above the line")
  assert.equal(reply?.seams?.[0].row, rows[summary].id, "it names the summary's own row")
})

/** A turn that compacts twice: each compaction restates the request under its own summary. */
function twice({ copy }: { copy: boolean }) {
  reset(100)
  const restated = () => row("user", `${REPLAY_HEADER}\n${REQUEST}`)
  return [
    row("user", "An earlier ask"),
    row("assistant", "An earlier answer"),
    row("assistant", SUMMARY),
    ...pair("terminal", "Carried one"),
    restated(),
    ...pair("patch", "After one"),
    row("assistant", SUMMARY),
    ...pair("terminal", "Carried two"),
    ...(copy ? [restated()] : []),
    restated(),
    ...pair("patch", "After two"),
    row("assistant", "Final words"),
  ]
}

for (const copy of [false, true])
  test(`a turn that compacts twice stays one turn${copy ? ", with the first request carried again" : ""}`, async () => {
    const rows = twice({ copy })
    const turn = toMessages("c", SESSION, rows).slice(2)
    assert.deepEqual(
      turn.map((message) => message.role),
      ["user", "assistant"],
      "one request and one reply for the turn",
    )
    assert.equal(turn[0].content, REQUEST, "the request is drawn once")
    const summaries = rows.filter((one) => one.content === SUMMARY)
    assert.deepEqual(
      turn[1].seams?.map((seam) => [seam.row, seam.toolsBefore]),
      [
        [summaries[0].id, 1],
        [summaries[1].id, 3],
      ],
      "each compaction marks the reply where it fell: after the work it carried, before what came next",
    )
    serve(rows)
    const live = await liveTurn(server, SESSION, REQUEST)
    assert.ok(live, "the running turn is found")
    for (const words of ["Carried one", "After one", "Carried two", "After two", "Final words"])
      assert.ok(live.content.includes(words), `${words} is in the live reply: ${live.content}`)
    assert.equal(live.tools?.length, 4, "every call, before both boundaries and after them")
  })

test("the same words asked in two turns stay two turns when the second one compacts", () => {
  reset(100)
  const rows = [
    row("user", REQUEST),
    ...pair("terminal", "First turn's work"),
    row("assistant", "First turn's answer"),
    row("assistant", SUMMARY),
    ...pair("terminal", "Second turn's carried work"),
    row("user", `${REPLAY_HEADER}\n${REQUEST}`),
    ...pair("patch", "Second turn's later work"),
  ]
  const drawn = shape(rows)
  assert.equal(
    drawn.filter((line) => line.startsWith(`user: ${REQUEST}`)).length,
    2,
    `each turn keeps its own request: ${drawn.join(" | ")}`,
  )
})
