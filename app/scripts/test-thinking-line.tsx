import assert from "node:assert/strict"
import test from "node:test"
import { db, saveAppearance, type Message, type Settings, type ToolEvent } from "@/lib/db"
import type { ReasoningRun } from "@/lib/thinking"
import {
  absent,
  botProfile,
  chatScreen,
  click,
  expanded,
  find,
  json,
  lineLabel,
  mount,
  onlyThinkingLine,
  resized,
  seedChat,
  settle,
  spyScrollIntoView,
  thinkingLines,
  withReducedMotion,
} from "./component-kit.tsx"

const bot = botProfile("thinking", { name: "Thinking" })

const ASK = "Where does the parser read a reply?"
const REASONING = "Read `parse.ts` first, then its blocks."
const SECOND = "Its blocks are what matter."
const ANSWER = "The parser reads it, then keeps its blocks."

/** Thinking written the way a model writes it: bold, a list and a fence, no plain parallel to them. */
const MARKDOWN = [
  "**Read the parser first**, then its blocks:",
  "",
  "- `parse.ts` keeps the scan",
  "- its blocks are what matter",
  "",
  "```ts",
  "const blocks = markdownBlocks(text)",
  "```",
].join("\n")

const run = (text: string, extra: Partial<ReasoningRun> = {}): ReasoningRun => ({ text, ...extra })

/**
 * A working-out no screen holds: the fixture repeated, with a last line of its own to look for. An
 * open row draws all of it, down to that line.
 */
const LONG = [...Array.from({ length: 6 }, () => MARKDOWN), "The scan is cheap in the end."].join(
  "\n\n",
)

function call(toolCallId: string, tool = "terminal", label = "ls"): ToolEvent {
  return {
    toolCallId,
    tool,
    label,
    status: "completed",
    startedAt: 2,
    contentOffset: 0,
  }
}

function turn(reply: Partial<Message> & { id: string }): Message[] {
  return [
    {
      id: "ask",
      conversationId: "",
      role: "user",
      content: ASK,
      status: "done",
      createdAt: 1,
    },
    {
      conversationId: "",
      role: "assistant",
      content: "",
      status: "done",
      createdAt: 2,
      ...reply,
    },
  ]
}

function host(transcript: unknown[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: transcript })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

async function screen(
  projectId: string | undefined,
  messages: Message[],
  body: () => Promise<void>,
  settings: Partial<Omit<Settings, "id">> = {},
) {
  const id = projectId ? "session-1" : "chat-1"
  await seedChat({ id, projectId, messages, profile: bot, settings })
  await mount(chatScreen(id), body)
}

/** The footer's working line: what the turn is doing, said under the reply. */
const workingLine = () => find('[aria-live="polite"]')

const reasoned = (line: Element) => {
  const id = line.getAttribute("aria-controls")
  assert.ok(id, "the control names the text it folds")
  const body = document.getElementById(id)
  assert.ok(body, "and that text is on the page")
  return body
}

const screenText = () => document.body.textContent ?? ""

const item = (line: Element) => {
  const found = line.closest("[data-slot=message-scroller-item]")
  assert.ok(found, "the line belongs to the reply's turn")
  return found
}

const leafWith = (root: Element, needle: string) =>
  [...root.querySelectorAll("*")].find(
    (one) => one.children.length === 0 && one.textContent?.includes(needle),
  )

const follows = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)

/** The one row the reply's tool calls are drawn as (calls that ran back to back are one group). */
const toolRow = (root: Element) => {
  const found = root.querySelector("[data-slot=tool-group]")
  assert.ok(found, "the call was drawn")
  return found
}

async function stream(id: string) {
  await db.messages.put({ ...(await db.messages.get(id))!, status: "streaming" })
  await settle()
}

/** The size a browser would report for a box; a DOM without layout has none to report. */
function sized(element: Element, size: { client: number; scroll: number }) {
  Object.defineProperty(element, "clientHeight", { value: size.client, configurable: true })
  Object.defineProperty(element, "scrollHeight", { value: size.scroll, configurable: true })
}

const viewport = () => {
  const found = find("[data-slot=message-scroller-viewport]")
  assert.ok(found, "the thread has a scroll box")
  return found
}

test("a streaming reply's run streams open and the working line stands down", async () => {
  host()
  const id = "streaming"
  await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
    await stream(id)
    const line = onlyThinkingLine()
    assert.equal(lineLabel(line), "Thinking…", "still thinking, so no duration yet")
    assert.equal(expanded(line), "true", "and open, as the thinking arrives")
    assert.match(
      reasoned(line).textContent ?? "",
      /then its blocks/,
      "its thinking readable",
    )
    assert.equal(
      document.querySelector('[aria-live="polite"]'),
      null,
      "with the row open, the working line is gone rather than saying Thinking… again",
    )
  })
})

test("a run that streams with no reasoning of its own keeps the working line", async () => {
  host()
  const id = "no-reasoning"
  await screen(undefined, turn({ id }), async () => {
    await stream(id)
    assert.equal(thinkingLines().length, 0, "there is nothing to fold")
    assert.match(screenText(), /Writing…/, "so the working line still says it is writing")
  })
})

test("while the turn waits on the user, the working line says so even with a run open", async () => {
  host()
  const id = "waiting"
  const messages = turn({
    id,
    reasoningRuns: [run(REASONING)],
    approval: {
      runId: "run-1",
      description: "Read parse.ts",
      choices: ["once", "deny"],
      requestedAt: 1_500,
    },
  })
  await screen(undefined, messages, async () => {
    await stream(id)
    assert.equal(expanded(onlyThinkingLine()), "true", "the thinking is still arriving")
    assert.match(screenText(), /Waiting for your approval…/, "but waiting on the user is named")
  })
})

test("the first answer token folds the run and brings the working line back", async () => {
  host()
  const id = "first-token"
  await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
    await stream(id)
    assert.equal(lineLabel(onlyThinkingLine()), "Thinking…", "the row streams open while it thinks")
    await db.messages.put({ ...(await db.messages.get(id))!, content: ANSWER })
    await settle()
    const line = onlyThinkingLine()
    assert.equal(expanded(line), "false", "the answer starting folds it")
    assert.equal(lineLabel(line), "Thought it through", "and nothing measured it here")
    assert.equal(
      reasoned(line).getAttribute("aria-hidden"),
      "true",
      "folded text leaves the tree rather than being read out",
    )
    assert.match(screenText(), /Writing…/, "the working line says what the reply is doing again")
  })
})

test("only the reply's newest run streams open, and the answer folds them all", async () => {
  host()
  const id = "two-runs"
  const messages = turn({
    id,
    tools: [call("call-1"), call("call-2", "read_file", "parse.ts")],
    reasoningRuns: [run(REASONING), run(SECOND, { afterToolId: "call-2" })],
  })
  await screen(undefined, messages, async () => {
    await stream(id)
    const open = thinkingLines()
    assert.equal(open.length, 2, "one row per run")
    assert.equal(lineLabel(open[0]), "Thought it through", "the run before the calls is done")
    assert.equal(expanded(open[0]), "false", "so it is folded")
    assert.equal(lineLabel(open[1]), "Thinking…", "the run after them is still going")
    assert.equal(expanded(open[1]), "true", "so it is open")

    await db.messages.put({ ...(await db.messages.get(id))!, content: ANSWER })
    await settle()
    const folded = thinkingLines()
    assert.equal(folded.length, 2, "still one row per run")
    for (const line of folded) {
      assert.equal(lineLabel(line), "Thought it through", "both ended with no span measured")
      assert.equal(expanded(line), "false", "and both folded at the answer")
    }
  })
})

test("a tap opens the folded run, a second folds it, and a remount folds it again", async () => {
  host()
  const messages = turn({ id: "tap-fold", reasoningRuns: [run(REASONING)], content: ANSWER })
  await screen(undefined, messages, async () => {
    assert.equal(expanded(onlyThinkingLine()), "false", "an answered reply starts folded")
    await click(onlyThinkingLine())
    assert.equal(expanded(onlyThinkingLine()), "true", "a tap opens it")
    assert.match(
      reasoned(onlyThinkingLine()).textContent ?? "",
      /parse\.ts/,
      "and its thinking is readable",
    )
    await click(onlyThinkingLine())
    assert.equal(expanded(onlyThinkingLine()), "false", "a second tap folds it")
  })
  await screen(undefined, messages, async () => {
    assert.equal(
      expanded(onlyThinkingLine()),
      "false",
      "being open is not kept, so a remount folds it",
    )
  })
})

test("a row that streamed live stays open after its own run ends, and the answer folds it", async () => {
  host()
  const id = "latch"
  await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
    await stream(id)
    assert.equal(expanded(onlyThinkingLine()), "true", "the run streams open as its words arrive")

    // A call ends that run, measuring it, and a second stretch of thinking follows the call.
    await db.messages.put({
      ...(await db.messages.get(id))!,
      tools: [call("call-1")],
      reasoningRuns: [run(REASONING, { spanMs: 12_000 }), run(SECOND, { afterToolId: "call-1" })],
    })
    await settle()
    const rows = thinkingLines()
    assert.equal(rows.length, 2, "the call splits the thinking into two rows")
    assert.equal(lineLabel(rows[0]), "Thought for 12s", "the run that ended reads the span it measured")
    assert.equal(
      expanded(rows[0]),
      "true",
      "and stays open: the turn still works, so the row that streamed keeps its place",
    )
    assert.equal(lineLabel(rows[1]), "Thinking…", "the run after the call is still thinking")
    assert.equal(expanded(rows[1]), "true", "and open as its words arrive")

    await db.messages.put({ ...(await db.messages.get(id))!, content: ANSWER })
    await settle()
    for (const line of thinkingLines())
      assert.equal(expanded(line), "false", "the answer beginning folds every row of the turn")
  })
})

test("a merged row that streamed stays open when its newest stretch ends", async () => {
  host()
  const id = "merged-latch"
  await screen(
    undefined,
    turn({
      id,
      tools: [call("call-1"), call("call-2", "read_file", "parse.ts")],
      reasoningRuns: [
        run(REASONING),
        run("What the first call printed.", { afterToolId: "call-1", spanMs: 3_000 }),
        run(SECOND, { afterToolId: "call-2" }),
      ],
    }),
    async () => {
      await stream(id)
      const rows = thinkingLines()
      assert.equal(rows.length, 2, "the two stretches that touched are one row")
      assert.equal(expanded(rows[1]), "true", "and it streams open as its newest stretch thinks")

      // The newest stretch ends, measured, and the turn still works: a further call is running.
      await db.messages.put({
        ...(await db.messages.get(id))!,
        tools: [call("call-1"), call("call-2", "read_file", "parse.ts"), { ...call("call-3"), status: "running" }],
        reasoningRuns: [
          run(REASONING),
          run("What the first call printed.", { afterToolId: "call-1", spanMs: 3_000 }),
          run(SECOND, { afterToolId: "call-2", spanMs: 9_000 }),
        ],
      })
      await settle()
      const row = thinkingLines()[1]
      assert.equal(lineLabel(row), "Thought for 12s", "the row adds the spans both stretches measured")
      assert.equal(expanded(row), "true", "and stays open, as the row that streamed on this visit")
    },
  )
})

test("a turn that ends with no answer folds its rows", async () => {
  host()
  const id = "stopped-early"
  await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
    await stream(id)
    assert.equal(expanded(onlyThinkingLine()), "true", "the run streams open")
    await db.messages.put({ ...(await db.messages.get(id))!, status: "stopped" })
    await settle()
    const line = onlyThinkingLine()
    assert.equal(expanded(line), "false", "the turn ending folds the row, though no answer came")
    assert.equal(lineLabel(line), "Thought it through", "with nothing measured for it here")
  })
})

test("the answer folds every row of the turn, even one the reader opened mid-turn", async () => {
  host()
  const id = "opened-mid-turn"
  await screen(
    undefined,
    // The first run ended over a call before this visit, so its row arrives closed.
    turn({
      id,
      tools: [call("call-1")],
      reasoningRuns: [run(REASONING, { spanMs: 12_000 }), run(SECOND, { afterToolId: "call-1" })],
    }),
    async () => {
      await stream(id)
      assert.equal(expanded(thinkingLines()[0]), "false", "a row that never streamed starts closed")
      await click(thinkingLines()[0])
      assert.equal(expanded(thinkingLines()[0]), "true", "a tap opens it while the turn works")

      await db.messages.put({ ...(await db.messages.get(id))!, content: ANSWER })
      await settle()
      const folded = thinkingLines()
      for (const line of folded)
        assert.equal(expanded(line), "false", "the answer folds the turn's rows together")
      assert.equal(lineLabel(folded[0]), "Thought for 12s", "keeping the label its own stretch earned")

      await click(thinkingLines()[0])
      assert.equal(expanded(thinkingLines()[0]), "true", "a tap after the fold sticks for the visit")
    },
  )
})

test("a tap while the model is still thinking folds the run, and the answer leaves it folded", async () => {
  host()
  const id = "tap-while-thinking"
  await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
    await stream(id)
    assert.equal(lineLabel(onlyThinkingLine()), "Thinking…", "the row streams open")
    assert.equal(expanded(onlyThinkingLine()), "true", "and open")
    await click(onlyThinkingLine())
    const folded = onlyThinkingLine()
    assert.equal(expanded(folded), "false", "a tap folds it, even mid-stream")
    assert.equal(lineLabel(folded), "Thinking…", "the model is still thinking, so the label holds")
    assert.equal(
      reasoned(folded).getAttribute("aria-hidden"),
      "true",
      "and the folded text leaves the tree",
    )
    await db.messages.put({ ...(await db.messages.get(id))!, content: ANSWER })
    await settle()
    const answered = onlyThinkingLine()
    assert.equal(lineLabel(answered), "Thought it through", "the first answer token ends the thinking")
    assert.equal(expanded(answered), "false", "and leaves the row as the user folded it")
    await click(onlyThinkingLine())
    assert.equal(expanded(onlyThinkingLine()), "true", "a second tap opens it again")
    assert.match(
      reasoned(onlyThinkingLine()).textContent ?? "",
      /parse\.ts/,
      "with its thinking readable",
    )
  })
})

test("a run the user opens on an answered reply stays open while its text grows", async () => {
  host()
  const id = "opened-answered"
  await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)], content: ANSWER }), async () => {
    assert.equal(expanded(onlyThinkingLine()), "false", "an answered reply starts folded")
    await click(onlyThinkingLine())
    assert.equal(expanded(onlyThinkingLine()), "true", "a tap opens it")
    await db.messages.put({
      ...(await db.messages.get(id))!,
      reasoningRuns: [run(`${REASONING} Then its blocks.`)],
    })
    await settle()
    const stillOpen = onlyThinkingLine()
    assert.match(
      reasoned(stillOpen).textContent ?? "",
      /Then its blocks\./,
      "the redraw brought the newer thinking",
    )
    assert.equal(expanded(stillOpen), "true", "and the row stays open, as the user left it")
    await click(onlyThinkingLine())
    assert.equal(expanded(onlyThinkingLine()), "false", "until a tap folds it")
  })
})

test("a run this device measured reads in whole seconds, not the stats line's figure", async () => {
  host()
  const id = "watched"
  const reply = {
    id,
    reasoningRuns: [run(REASONING, { spanMs: 12_000 })],
    content: ANSWER,
    stats: { tokens: 40, estimated: false, durationMs: 12_000 },
  }
  await screen(undefined, turn(reply), async () => {
    assert.equal(lineLabel(onlyThinkingLine()), "Thought for 12s", "the span this device measured")
    assert.equal(expanded(onlyThinkingLine()), "false", "still folded over an answer")
    assert.match(screenText(), /12\.0s/, "and the turn's own duration stays in the stats line")
  })
})

test("a run that already ended stays folded while the call it broke runs", async () => {
  host()
  const id = "ended-run"
  await screen(
    undefined,
    turn({
      id,
      // The call that ended the run is still going: its own row says what it is doing.
      tools: [{ ...call("call-1"), status: "running" }],
      reasoningRuns: [run(REASONING, { spanMs: 12_000 })],
    }),
    async () => {
      await stream(id)
      const line = onlyThinkingLine()
      assert.equal(lineLabel(line), "Thought for 12s", "the number it measured is what it reads")
      assert.equal(
        expanded(line),
        "false",
        "an ended run does not re-open as Thinking… while the call it broke runs",
      )
    },
  )
})

test("a restored reply reads Thought it through and keeps its duration in the stats", async () => {
  host()
  const reply = {
    id: "restored",
    reasoningRuns: [run(REASONING)],
    content: ANSWER,
    stats: { tokens: 40, estimated: false, durationMs: 12_000 },
  }
  await screen(undefined, turn(reply), async () => {
    const line = onlyThinkingLine()
    assert.equal(lineLabel(line), "Thought it through", "nothing here measured it, so no number")
    assert.doesNotMatch(lineLabel(line), /\d/, "no figure at all")
    assert.equal(expanded(line), "false", "and folded")
    assert.match(screenText(), /12\.0s/, "while the reply's stats still show its own duration")
  })
})

test("a stopped or failed reply keeps its run, folded", async () => {
  host()
  const messages: Message[] = [
    ...turn({ id: "stopped", reasoningRuns: [run(REASONING)], status: "stopped" }),
    {
      id: "failed",
      conversationId: "",
      role: "assistant",
      content: "",
      reasoningRuns: [run(REASONING)],
      status: "error",
      statusText: "The host dropped the run.",
      createdAt: 3,
    },
  ]
  await screen(undefined, messages, async () => {
    const found = thinkingLines()
    assert.equal(found.length, 2, "each reply keeps what arrived")
    for (const line of found) {
      assert.equal(lineLabel(line), "Thought it through", "with no span measured")
      assert.equal(expanded(line), "false", "and folded")
      assert.match(reasoned(line).textContent ?? "", /parse\.ts/, "its thinking still there")
    }
    assert.match(screenText(), /Stopped/, "the stopped reply says so")
    assert.match(screenText(), /The host dropped the run\./, "and the failed one says why")
  })
})

test("a reply with no thinking of its own draws no row", async () => {
  host()
  const messages: Message[] = [
    ...turn({ id: "empty", reasoningRuns: [], content: ANSWER }),
    {
      id: "blank",
      conversationId: "",
      role: "assistant",
      content: ANSWER,
      reasoningRuns: [run("  \n\t ")],
      status: "done",
      createdAt: 3,
    },
  ]
  await screen(undefined, messages, async () => {
    assert.equal(thinkingLines().length, 0, "empty and whitespace-only thinking draw nothing")
  })
})

test("a reply whose thinking is broken by tool calls draws a row above them and one below", async () => {
  host()
  const messages = turn({
    id: "broken-by-calls",
    content: "I read the parser first.\n\nThen I kept its blocks.",
    tools: [call("call-1"), call("call-2", "read_file", "parse.ts")],
    reasoningRuns: [run(REASONING), run(SECOND, { afterToolId: "call-2" })],
  })
  await screen(undefined, messages, async () => {
    const [before, after] = thinkingLines()
    assert.ok(before && after, "one row per stretch of thinking")
    assert.equal(lineLabel(before), "Thought it through", "the first run says it thought it through")
    assert.match(reasoned(before).textContent ?? "", /parse\.ts/, "and holds the first stretch")
    assert.match(reasoned(after).textContent ?? "", /blocks are what matter/, "the second its own")

    const box = item(before)
    const calls = toolRow(box)
    const text = leafWith(box, "I read the parser first.")
    assert.ok(text, "the reply's text is in that turn")
    assert.ok(follows(before, calls), "the thinking before the call is drawn above it")
    assert.ok(follows(calls, after), "and the thinking after it below, once the calls are one row")
    assert.ok(follows(after, text), "where it happened, before the text that followed")
  })
})

test("two calls back to back draw one row below them, holding both stretches", async () => {
  host()
  const messages = turn({
    id: "arrival-order",
    content: "I ran both, then answered.",
    // Nothing between the calls, so the thread draws them as one group.
    tools: [call("call-1"), call("call-2", "read_file", "parse.ts")],
    reasoningRuns: [
      run(REASONING),
      run("What the first call printed.", { afterToolId: "call-1" }),
      run(SECOND, { afterToolId: "call-2" }),
    ],
  })
  await screen(undefined, messages, async () => {
    const rows = thinkingLines()
    assert.equal(rows.length, 2, "the run before any call, and one row for the two that touched")
    const box = item(rows[0])
    assert.equal(item(rows[1]), box, "both rows belong to the one reply")
    const calls = toolRow(box)
    assert.ok(follows(rows[0], calls), "the run before any call is drawn above the group")
    assert.ok(follows(calls, rows[1]), "and the stretches that touched are drawn below it, as one row")
    const body = reasoned(rows[1]).textContent ?? ""
    const first = body.indexOf("first call printed")
    const second = body.indexOf("blocks are what matter")
    assert.ok(first >= 0, "the row holds the stretch the first call broke")
    assert.ok(second >= 0, "and the one the second call broke")
    assert.ok(first < second, "in the order they arrived")
    assert.equal(body.match(/first call printed/g)?.length, 1, "each stretch once, not once a row")
    assert.equal(lineLabel(rows[1]), "Thought it through", "and one label for the two of them")
  })
})

test("a merged row adds up the spans it holds, and claims none where a stretch went unwatched", async () => {
  host()
  const reply = (id: string, watches: (number | undefined)[]) => ({
    id,
    content: ANSWER,
    tools: [call("call-1"), call("call-2", "read_file", "parse.ts")],
    reasoningRuns: [
      run(REASONING),
      run("What the first call printed.", { afterToolId: "call-1", spanMs: watches[0] }),
      run(SECOND, { afterToolId: "call-2", spanMs: watches[1] }),
    ],
  })
  await screen(undefined, turn(reply("merged-watched", [5_000, 7_000])), async () => {
    const rows = thinkingLines()
    assert.equal(rows.length, 2, "the two stretches that touched are one row")
    assert.equal(lineLabel(rows[0]), "Thought it through", "the run above the group measured nothing")
    assert.equal(lineLabel(rows[1]), "Thought for 12s", "the merged row adds the spans it watched")
  })
  // A transcript rebuilt on another device carried a span onto one stretch only.
  await screen(undefined, turn(reply("merged-unwatched", [5_000, undefined])), async () => {
    const rows = thinkingLines()
    assert.equal(rows.length, 2, "still one row for the stretches that touched")
    const label = lineLabel(rows[1])
    assert.equal(label, "Thought it through", "one unmeasured stretch disqualifies the sum")
    assert.doesNotMatch(label, /\d/, "never the part of it this device measured")
  })
})

test("a merged row whose last stretch still streams reads Thinking…", async () => {
  host()
  const id = "merged-streaming"
  const messages = turn({
    id,
    tools: [call("call-1"), call("call-2", "read_file", "parse.ts")],
    reasoningRuns: [
      run(REASONING),
      run("What the first call printed.", { afterToolId: "call-1", spanMs: 5_000 }),
      run(SECOND, { afterToolId: "call-2" }),
    ],
  })
  await screen(undefined, messages, async () => {
    await stream(id)
    const rows = thinkingLines()
    assert.equal(rows.length, 2, "one row for the stretches that touched")
    assert.equal(lineLabel(rows[1]), "Thinking…", "a stretch still thinking holds the whole row there")
    assert.equal(expanded(rows[1]), "true", "and the row stands open over both of them")
    assert.match(reasoned(rows[1]).textContent ?? "", /first call printed/, "holding the one that ended")
    assert.match(reasoned(rows[1]).textContent ?? "", /blocks are what matter/, "and the one still going")
  })
})

test("a steer and an answered approval leave one row per run, never a row apiece", async () => {
  host()
  const reply = "I read the parser first.\n\nThen I kept its blocks."
  const messages = turn({
    id: "broken",
    content: reply,
    status: "done",
    tools: [call("call-1", "terminal", "ls")],
    reasoningRuns: [run(REASONING), run(SECOND, { afterToolId: "call-1" })],
    approval: {
      runId: "run-1",
      description: "Read parse.ts",
      choices: ["once", "deny"],
      resolved: "once",
      contentOffset: 0,
      requestedAt: 1_500,
    },
    steers: [{ id: "steer-1", text: "And its blocks?", contentOffset: reply.indexOf("Then"), at: 2 }],
  })
  await screen(undefined, messages, async () => {
    const found = thinkingLines()
    assert.equal(found.length, 2, "two stretches of thinking, two rows — the breaks add none")
    for (const line of found) assert.equal(expanded(line), "false", "each folded over the answer")

    const box = item(found[0])
    const boxed = item(found[1])
    assert.equal(box, boxed, "both rows belong to the one reply")
    const first = leafWith(box, "I read the parser first.")
    assert.ok(first, "the reply's first text is in that turn")
    assert.ok(follows(found[0], first), "with the first row drawn above it")
    assert.ok(follows(found[0], toolRow(box)), "and above the call it precedes")
    const steer = leafWith(box, "And its blocks?")
    assert.ok(steer, "the steer sits where it reached the agent")
    assert.ok(follows(toolRow(box), found[1]), "the second row is below the call that broke it")
  })
})

test("a reply stored before runs draws its thinking as one row at the top", async () => {
  host()
  const messages = turn({
    id: "old-shape",
    reasoning: `${REASONING}\n\n${SECOND}`,
    content: ANSWER,
    tools: [call("call-1")],
  })
  await screen(undefined, messages, async () => {
    const line = onlyThinkingLine()
    assert.equal(lineLabel(line), "Thought it through", "the fold keeps it as one run")
    const box = item(line)
    assert.ok(follows(line, toolRow(box)), "drawn at the top of the reply, above what it ran")
    assert.match(reasoned(line).textContent ?? "", /blocks are what matter/, "holding all of it")
  })
})

test("a coding session's thread draws the same rows, in place, as the same reply in a chat", async () => {
  host()
  const reply = {
    id: "session-reply",
    tools: [call("call-1"), call("call-2", "read_file", "parse.ts")],
    reasoningRuns: [run(REASONING), run(SECOND, { afterToolId: "call-2", spanMs: 12_000 })],
    content: ANSWER,
  }
  await screen(undefined, turn(reply), async () => {
    const chat = thinkingLines()
    assert.equal(chat.length, 2, "a chat draws one row per run")
    assert.deepEqual(
      chat.map(lineLabel),
      ["Thought it through", "Thought for 12s"],
      "each run reads its own label",
    )
    for (const line of chat) assert.equal(expanded(line), "false", "and both fold over the answer")
  })
  await screen("project-1", turn(reply), async () => {
    assert.match(screenText(), /The parser reads it/, "the session draws the reply")
    const session = thinkingLines()
    assert.equal(session.length, 2, "and one row per run, as a chat does")
    assert.deepEqual(
      session.map(lineLabel),
      ["Thought it through", "Thought for 12s"],
      "with the same words",
    )
    for (const line of session) assert.equal(expanded(line), "false", "folded over the answer")
    const box = item(session[0])
    assert.equal(item(session[1]), box, "both rows belong to the one reply")
    assert.ok(follows(session[0], toolRow(box)), "the run before the calls is drawn above them")
    assert.ok(follows(toolRow(box), session[1]), "and the run after them below the call that broke it")

    await db.messages.put({
      ...(await db.messages.get("session-reply"))!,
      content: "",
      status: "streaming",
      // A live turn's newest run hasn't ended, so it carries no span to re-open against.
      reasoningRuns: [run(REASONING), run(SECOND, { afterToolId: "call-2" })],
    })
    await settle()
    const streaming = thinkingLines()
    assert.equal(streaming.length, 2, "a streaming session keeps one row per run")
    assert.equal(lineLabel(streaming[0]), "Thought it through", "the run before the calls is done")
    assert.equal(lineLabel(streaming[1]), "Thinking…", "its newest run streams open, as a chat's does")
    assert.equal(expanded(streaming[1]), "true", "and is open")

    await db.messages.put({
      ...(await db.messages.get("session-reply"))!,
      content: ANSWER,
      status: "done",
    })
    await settle()
    for (const line of thinkingLines())
      assert.equal(expanded(line), "false", "the answer folds it, as a chat's folds")

    await click(thinkingLines()[1])
    assert.equal(expanded(thinkingLines()[1]), "true", "a tap opens it")
    assert.match(
      reasoned(thinkingLines()[1]).textContent ?? "",
      /blocks are what matter/,
      "with its thinking readable",
    )
    await click(thinkingLines()[1])
    assert.equal(expanded(thinkingLines()[1]), "false", "and a second tap folds it")
  })
})

test("an opened run reads as markdown, the way the reply's own answer does", async () => {
  host()
  await screen(
    undefined,
    turn({ id: "markdown", reasoningRuns: [run(MARKDOWN)], content: ANSWER }),
    async () => {
      assert.equal(expanded(onlyThinkingLine()), "false", "an answered reply starts folded")
      await click(onlyThinkingLine())
      // The renderer is the app's own, loaded off the startup path; ask for it as a reply does.
      await import("@/components/chat/markdown-renderer")
      await settle()

      const body = reasoned(onlyThinkingLine())
      assert.equal(
        body.querySelector("strong")?.textContent,
        "Read the parser first",
        "**bold** draws as a <strong>, not as its markers",
      )
      const items = [...body.querySelectorAll("li")].map((one) => one.textContent?.trim())
      assert.deepEqual(
        items,
        ["parse.ts keeps the scan", "its blocks are what matter"],
        "a list draws as list items",
      )
      assert.match(
        body.querySelector("pre code")?.textContent ?? "",
        /markdownBlocks\(text\)/,
        "a fence draws as code, as it does in the reply",
      )
      assert.doesNotMatch(
        body.textContent ?? "",
        /\*\*|```|- `parse/,
        "with no markdown left reading as text",
      )
      assert.match(screenText(), new RegExp(ANSWER), "the answer is still drawn under it")
    },
  )
})

test("a folded run's links wait for the open, as its words do", async () => {
  host()
  const messages = turn({
    id: "inert",
    reasoningRuns: [run("The scan is in [parse.ts](./parse.ts).")],
    content: ANSWER,
  })
  await screen(undefined, messages, async () => {
    const folded = reasoned(onlyThinkingLine())
    assert.equal(folded.hasAttribute("inert"), true, "a folded body is out of the tab order")
    assert.equal(folded.getAttribute("aria-hidden"), "true", "and out of the tree")
    await click(onlyThinkingLine())
    const shown = reasoned(onlyThinkingLine())
    assert.equal(shown.hasAttribute("inert"), false, "an opened one can be reached again")
    assert.equal(shown.getAttribute("aria-hidden"), "false")
  })
})

test("an open row longer than a screen shows its last words, with no cap and no Show more", async () => {
  host()
  await screen(
    undefined,
    turn({ id: "uncapped", reasoningRuns: [run(LONG)], content: ANSWER }),
    async () => {
      const folded = onlyThinkingLine()
      assert.equal(expanded(folded), "false", "an answered reply starts folded")
      assert.equal(lineLabel(folded), "Thought it through", "under the label its run earned")
      assert.ok(folded.querySelector("svg"), "with its chevron to turn")
      const hidden = reasoned(folded)
      assert.equal(hidden.getAttribute("aria-hidden"), "true", "a folded row hides its words")
      assert.equal(hidden.hasAttribute("inert"), true, "and keeps them out of reach")

      await click(onlyThinkingLine())
      const line = onlyThinkingLine()
      assert.equal(expanded(line), "true", "a tap opens it")
      assert.match(
        reasoned(line).textContent ?? "",
        /The scan is cheap in the end/,
        "the whole run reads, down to its last words",
      )
      absent("[data-slot=thinking-fade]")
      absent("[data-slot=thinking-cap]")
      absent("button", "Show more")
      assert.doesNotMatch(screenText(), /Show more/, "nowhere on the screen")
    },
  )
})

test("opening a run lands on its newest words, and the tail follows until a scroll up", async () => {
  host()
  const id = "following"
  const spy = spyScrollIntoView()
  try {
    await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
      await stream(id)
      // The thread has less room than its words need, so the row's end is not in view already.
      sized(viewport(), { client: 400, scroll: 1_200 })
      // Fold it and open it again, the way a reader opens a row: opening is what lands on the end.
      await click(onlyThinkingLine())
      spy.into.length = 0
      await click(onlyThinkingLine())
      assert.equal(spy.into.at(-1)?.block, "end", "opening puts the run's end in view")
      assert.equal(
        spy.into.at(-1)?.behavior,
        "smooth",
        "gliding there, as the thread's own moves do",
      )

      spy.into.length = 0
      await db.messages.put({
        ...(await db.messages.get(id))!,
        reasoningRuns: [run(`${REASONING} Then the blocks.`)],
      })
      await settle()
      await resized("[data-slot=thinking-body]")
      assert.equal(spy.into.length, 0, "the report an observer gets at once is not growth")
      await resized("[data-slot=thinking-body]")
      assert.ok(spy.into.length > 0, "growth keeps the end of the row in view")

      viewport().dispatchEvent(new window.WheelEvent("wheel", { deltaY: -120, bubbles: true }))
      spy.into.length = 0
      await db.messages.put({
        ...(await db.messages.get(id))!,
        reasoningRuns: [run(`${REASONING} Then the blocks. Its scan is cheap.`)],
      })
      await settle()
      await resized("[data-slot=thinking-body]")
      await resized("[data-slot=thinking-body]")
      assert.equal(spy.into.length, 0, "a scroll up stops the follow, for good")

      await click(onlyThinkingLine())
      spy.into.length = 0
      await click(onlyThinkingLine())
      assert.ok(spy.into.length > 0, "and opening the row again follows it once more")
    })

    await withReducedMotion(async () => {
      const quiet = (id: string) =>
        screen(undefined, turn({ id, reasoningRuns: [run(REASONING)], content: ANSWER }), async () => {
          spy.into.length = 0
          await click(onlyThinkingLine())
          assert.equal(spy.into.at(-1)?.block, "end", "still the run's end")
          assert.equal(spy.into.at(-1)?.behavior, "auto", "placed with no motion at all")
        })
      await quiet("no-motion")
    })
  } finally {
    spy.restore()
  }
})

test("a run that opens on its own leaves a reader who has scrolled away where they were", async () => {
  host()
  const id = "auto-open"
  const spy = spyScrollIntoView()
  try {
    await screen(
      undefined,
      // The call its second run follows is drawn between the two stretches, so they are two rows:
      // one above the group, one below it.
      turn({ id, tools: [call("call-1")], reasoningRuns: [run(REASONING)], content: ANSWER }),
      async () => {
        // The reader is reading higher up the thread when the turn's next run starts.
        const view = viewport()
        sized(view, { client: 400, scroll: 1_600 })
        view.scrollTop = 0
        spy.into.length = 0
        await db.messages.put({
          ...(await db.messages.get(id))!,
          status: "streaming",
          content: "",
          reasoningRuns: [run(REASONING), run(SECOND, { afterToolId: "call-1" })],
        })
        await settle()
        const rows = thinkingLines()
        assert.equal(rows.length, 2, "the turn's two runs, one row each")
        assert.equal(expanded(rows[1]), "true", "the new run opens as it streams")
        assert.equal(spy.into.length, 0, "and the reader is not pulled down to it")
      },
    )
  } finally {
    spy.restore()
  }
})

test("with reduced motion asked for, a tap still opens the row and a second folds it", async () => {
  host()
  const messages = turn({ id: "reduced", reasoningRuns: [run(REASONING)], content: ANSWER })
  await withReducedMotion(() =>
    screen(undefined, messages, async () => {
      assert.equal(expanded(onlyThinkingLine()), "false", "folded to start")
      await click(onlyThinkingLine())
      assert.equal(expanded(onlyThinkingLine()), "true", "a tap opens it, with no motion needed")
      await click(onlyThinkingLine())
      assert.equal(expanded(onlyThinkingLine()), "false", "and a second folds it")
    }),
  )
})

test("with the switch on, a streaming run stays folded and the working line says what it does", async () => {
  host()
  const id = "folded-stream"
  const settings = { foldThinkingByDefault: true }
  await screen(
    undefined,
    turn({ id, reasoningRuns: [run(REASONING)] }),
    async () => {
      await stream(id)
      const line = onlyThinkingLine()
      assert.equal(
        lineLabel(line),
        "Thinking…",
        "a folded row keeps its own label while its stretch streams",
      )
      assert.equal(expanded(line), "false", "and it never opens on its own")
      assert.equal(
        reasoned(line).getAttribute("aria-hidden"),
        "true",
        "so its words are out of the tree until it is asked for",
      )
      assert.match(
        workingLine()?.textContent ?? "",
        /Thinking…/,
        "the footer says what the turn is doing, where an open row used to",
      )

      await click(onlyThinkingLine())
      assert.equal(expanded(onlyThinkingLine()), "true", "a tap opens the row for the visit")
      assert.match(reasoned(onlyThinkingLine()).textContent ?? "", /then its blocks/, "readable")
      await click(onlyThinkingLine())
      assert.equal(expanded(onlyThinkingLine()), "false", "and a second tap folds it again")
    },
    settings,
  )
})

test("with the switch on, no row of the turn opens at any point, and the answer moves nothing", async () => {
  host()
  const id = "folded-turn"
  const settings = { foldThinkingByDefault: true }
  await screen(
    undefined,
    turn({ id, reasoningRuns: [run(REASONING)] }),
    async () => {
      await stream(id)
      assert.equal(expanded(onlyThinkingLine()), "false", "the streaming row is folded")

      // The first stretch ends over a call and a second one thinks: it never joins either.
      await db.messages.put({
        ...(await db.messages.get(id))!,
        tools: [call("call-1")],
        reasoningRuns: [run(REASONING, { spanMs: 12_000 }), run(SECOND, { afterToolId: "call-1" })],
      })
      await settle()
      const rows = thinkingLines()
      assert.equal(rows.length, 2, "the call splits the thinking into two rows")
      for (const row of rows) assert.equal(expanded(row), "false", "neither opened on its own")

      // The turn keeps working, its newest stretch measured, and a call running.
      await db.messages.put({
        ...(await db.messages.get(id))!,
        tools: [call("call-1"), { ...call("call-2"), status: "running" }],
        reasoningRuns: [
          run(REASONING, { spanMs: 12_000 }),
          run(SECOND, { afterToolId: "call-1", spanMs: 4_000 }),
        ],
      })
      await settle()
      for (const row of thinkingLines())
        assert.equal(expanded(row), "false", "a turn still working leaves every row folded")

      await db.messages.put({ ...(await db.messages.get(id))!, content: ANSWER })
      await settle()
      const answered = thinkingLines()
      assert.equal(answered.length, 2, "the answer draws no row of its own")
      for (const row of answered)
        assert.equal(expanded(row), "false", "and the answer moving in changes nothing")
    },
    settings,
  )
})

test("the switch turned on mid-turn leaves the open row open and the next one never opens", async () => {
  host()
  const id = "switch-mid-turn"
  await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
    await stream(id)
    assert.equal(expanded(onlyThinkingLine()), "true", "with the switch off the run streams open")

    await saveAppearance({ foldThinkingByDefault: true })
    await settle()
    assert.equal(
      expanded(onlyThinkingLine()),
      "true",
      "a row already open stays open for the visit: the switch governs what opens on its own",
    )

    await db.messages.put({
      ...(await db.messages.get(id))!,
      tools: [call("call-1")],
      reasoningRuns: [run(REASONING, { spanMs: 12_000 }), run(SECOND, { afterToolId: "call-1" })],
    })
    await settle()
    const rows = thinkingLines()
    assert.equal(expanded(rows[0]), "true", "the row that streamed before the switch stays open")
    assert.equal(lineLabel(rows[1]), "Thinking…", "the next stretch is still thinking")
    assert.equal(expanded(rows[1]), "false", "and it never opens, as the switch now asks")
  })
})

test("with the switch on, a reader who opens the streaming row takes the working line's place", async () => {
  host()
  const id = "opened-under-switch"
  await screen(
    undefined,
    turn({ id, reasoningRuns: [run(REASONING)] }),
    async () => {
      await stream(id)
      assert.equal(expanded(onlyThinkingLine()), "false", "the switch keeps the streaming row folded")
      assert.match(
        workingLine()?.textContent ?? "",
        /Thinking…/,
        "so the footer is what says the turn is thinking",
      )

      await click(onlyThinkingLine())
      assert.equal(expanded(onlyThinkingLine()), "true", "a tap opens the row for the visit")
      assert.equal(lineLabel(onlyThinkingLine()), "Thinking…", "and the row says it for itself")
      assert.equal(workingLine(), null, "so the footer stands down rather than saying it twice")

      await click(onlyThinkingLine())
      assert.equal(expanded(onlyThinkingLine()), "false", "a second tap folds it again")
      assert.match(workingLine()?.textContent ?? "", /Thinking…/, "and the footer speaks again")
    },
    { foldThinkingByDefault: true },
  )
})

test("with the switch off, a reader who folds the streaming row keeps the turn from going silent", async () => {
  host()
  const id = "folded-by-reader"
  await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
    await stream(id)
    assert.equal(expanded(onlyThinkingLine()), "true", "the row streams open as its words arrive")
    assert.equal(workingLine(), null, "so the footer stands down while it lies open")

    await click(onlyThinkingLine())
    const folded = onlyThinkingLine()
    assert.equal(expanded(folded), "false", "a tap folds it mid-stream")
    assert.equal(lineLabel(folded), "Thinking…", "the row keeps its label through the fold")
    assert.match(
      workingLine()?.textContent ?? "",
      /Thinking…/,
      "and the footer says the turn is thinking, so no row open leaves the turn silent",
    )
  })
})

test("with the switch on, a coding session's streaming row stays folded too", async () => {
  host()
  const id = "session-1"
  await screen(
    "project-1",
    turn({ id, reasoningRuns: [run(REASONING)] }),
    async () => {
      await stream(id)
      const line = onlyThinkingLine()
      assert.equal(lineLabel(line), "Thinking…", "the session's row says what its stretch is doing")
      assert.equal(expanded(line), "false", "and the switch keeps it folded here, as in a chat")
      assert.match(workingLine()?.textContent ?? "", /Thinking…/, "with the footer speaking instead")
    },
    { foldThinkingByDefault: true },
  )
})

test("a reply resumed after the stream dropped latches open again, and folds at the answer", async () => {
  host()
  const id = "resumed"
  await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
    await stream(id)
    assert.equal(expanded(onlyThinkingLine()), "true", "the row streams open as its words arrive")

    await db.messages.put({ ...(await db.messages.get(id))!, status: "stopped" })
    await settle()
    assert.equal(expanded(onlyThinkingLine()), "false", "the turn ending with no answer folds it")

    // The stream comes back: the same stretch of thinking is being watched again on this visit.
    await stream(id)
    const again = onlyThinkingLine()
    assert.equal(lineLabel(again), "Thinking…", "the resumed stretch is still thinking")
    assert.equal(expanded(again), "true", "and drawn open again, as a row being watched")

    await db.messages.put({ ...(await db.messages.get(id))!, content: ANSWER })
    await settle()
    assert.equal(expanded(onlyThinkingLine()), "false", "and the answer folds it, as it folds any row")
  })
})
