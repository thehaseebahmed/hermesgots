import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { db, type Message, type Settings, type ToolEvent } from "@/lib/db"
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
  until,
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
 * A working-out no screen holds: the fixture repeated, with a last line of its own to look for. A
 * sheet draws all of it, down to that line.
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

/** The footer's working line: what the turn is doing, said under the reply. It never thinks. */
const workingLine = () => find('[aria-live="polite"]')

/** The open sheet's body: a row's words are on the page only while its sheet is open. */
const sheet = () => find("[data-slot=thinking-body]")

const sheetText = () => sheet()?.textContent ?? ""

/** The sheet's own scroll box, where a live run's newest words land. */
const sheetScroll = () => {
  const found = find("[data-slot=popup-scroll]")
  assert.ok(found, "the sheet has a scroll box")
  return found
}

/** Escape, the way the pop-up closes. */
async function shutSheet() {
  await act(async () => {
    sheet()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    )
  })
  await until(async () => !sheet(), "the sheet shut")
}

/** Whether the row carries the spinner that says the turn is thinking right now. */
const spins = (line: Element) => Boolean(line.querySelector("[data-slot=spinner]"))

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

test("a row spins for the turn's thinking, and the footer never says it too", async () => {
  host()
  const id = "streaming"
  await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
    await stream(id)
    const line = onlyThinkingLine()
    assert.equal(lineLabel(line), "Thinking…", "still thinking, so no duration yet")
    assert.ok(spins(line), "and it carries the spinner, as the tool row does while it runs")
    assert.equal(expanded(line), "false", "its sheet starts shut")
    assert.equal(sheet(), null, "with nothing of the run on the page until it is asked for")
    assert.equal(
      workingLine(),
      null,
      "the footer says nothing: the row is the one place the turn's thinking is named",
    )
  })
})

test("a reply that never thinks wears the row while it works, and loses it at the answer", async () => {
  host()
  const id = "no-reasoning"
  await screen(undefined, turn({ id }), async () => {
    await stream(id)
    const line = onlyThinkingLine()
    assert.equal(lineLabel(line), "Thinking…", "the row is on screen from the first working moment")
    assert.ok(spins(line), "with its spinner, before a word of thinking arrives")
    assert.equal(
      workingLine(),
      null,
      "and the footer leaves the saying to it",
    )

    await db.messages.put({ ...(await db.messages.get(id))!, content: ANSWER })
    await settle()
    assert.equal(thinkingLines().length, 0, "the model never thought, so the row goes with that")
    assert.match(screenText(), /Writing…/, "and the footer says what the reply is doing instead")
  })
})

test("behind a finished call, the model's quiet draws a row after it until words land", async () => {
  host()
  const id = "quiet-after-call"
  const TEXT = "I read the parser first."
  await screen(
    undefined,
    turn({
      id,
      content: TEXT,
      tools: [{ ...call("call-1"), contentOffset: TEXT.length }],
    }),
    async () => {
      await stream(id)
      const line = onlyThinkingLine()
      assert.equal(lineLabel(line), "Thinking…", "the model is quiet behind its last call")
      assert.ok(spins(line), "so the row spins where the footer's line used to be")
      const box = item(line)
      assert.ok(follows(toolRow(box), line), "drawn after the call the quiet follows")

      await db.messages.put({
        ...(await db.messages.get(id))!,
        content: `${TEXT} Then its blocks.`,
      })
      await settle()
      assert.equal(thinkingLines().length, 0, "the answer moving again takes the row with it")
    },
  )
})

test("a tap opens the whole working-out in a sheet, which never closes itself", async () => {
  host()
  const id = "sheet"
  await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
    await stream(id)
    await click(onlyThinkingLine())
    assert.equal(expanded(onlyThinkingLine()), "true", "a tap opens the row's sheet")
    assert.match(sheetText(), /then its blocks/, "the run's words read in it")
    assert.ok(
      !item(onlyThinkingLine()).contains(sheet()),
      "the words open in the sheet, not in the thread under the row",
    )

    // The answer begins: the label under the sheet is what changes, and the sheet stays put.
    await db.messages.put({ ...(await db.messages.get(id))!, content: ANSWER })
    await settle()
    assert.equal(lineLabel(onlyThinkingLine()), "Thought it through", "the thinking has ended")
    assert.equal(expanded(onlyThinkingLine()), "true", "and the sheet the reader opened stays open")
    assert.match(sheetText(), /then its blocks/, "still holding the run's words")

    await db.messages.put({ ...(await db.messages.get(id))!, status: "stopped" })
    await settle()
    assert.equal(expanded(onlyThinkingLine()), "true", "the turn ending closes nothing either")

    await shutSheet()
    assert.equal(expanded(onlyThinkingLine()), "false", "the reader closes it, their own way")
    assert.equal(sheet(), null, "and the words leave the page with it")
  })
})

test("an answered row's sheet opens at the top, a live one lands on its newest words", async () => {
  host()
  const spy = spyScrollIntoView()
  try {
    // A run already written reads from the start: opening lands nothing anywhere.
    await screen(
      undefined,
      turn({ id: "quiet-open", reasoningRuns: [run(REASONING)], content: ANSWER }),
      async () => {
        await click(onlyThinkingLine())
        assert.match(sheetText(), /then its blocks/, "the words are all there")
        assert.equal(spy.into.length, 0, "a finished run's sheet opens at its top")
        await shutSheet()
      },
    )

    // A run still thinking lands on its newest words, and follows them until the reader scrolls up.
    const id = "following"
    await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
      await stream(id)
      spy.into.length = 0
      await click(onlyThinkingLine())
      assert.equal(spy.into.at(-1)?.block, "end", "opening puts the run's end in view")
      assert.equal(spy.into.at(-1)?.behavior, "smooth", "gliding there, as a sheet's own moves do")

      // The sheet has less room than its words need, so the growth has somewhere to go.
      sized(sheetScroll(), { client: 400, scroll: 1_200 })
      spy.into.length = 0
      await db.messages.put({
        ...(await db.messages.get(id))!,
        reasoningRuns: [run(`${REASONING} Then the blocks.`)],
      })
      await settle()
      await resized("[data-slot=thinking-body]")
      assert.equal(spy.into.length, 0, "the report an observer gets at once is not growth")
      await resized("[data-slot=thinking-body]")
      assert.ok(spy.into.length > 0, "growth keeps the end of the sheet in view")

      sheetScroll().dispatchEvent(new window.WheelEvent("wheel", { deltaY: -120, bubbles: true }))
      spy.into.length = 0
      await db.messages.put({
        ...(await db.messages.get(id))!,
        reasoningRuns: [run(`${REASONING} Then the blocks. Its scan is cheap.`)],
      })
      await settle()
      await resized("[data-slot=thinking-body]")
      await resized("[data-slot=thinking-body]")
      assert.equal(spy.into.length, 0, "a scroll up inside the sheet stops the follow, for good")
    })

    await withReducedMotion(async () => {
      await screen(
        undefined,
        turn({ id: "no-motion", reasoningRuns: [run(REASONING)] }),
        async () => {
          await stream("no-motion")
          spy.into.length = 0
          await click(onlyThinkingLine())
          assert.equal(spy.into.at(-1)?.block, "end", "still the run's end")
          assert.equal(spy.into.at(-1)?.behavior, "auto", "placed with no motion at all")
        },
      )
    })
  } finally {
    spy.restore()
  }
})

test("the sheet reads the run as the reply's own markdown, whole and uncapped", async () => {
  host()
  await screen(
    undefined,
    turn({ id: "markdown", reasoningRuns: [run(LONG)], content: ANSWER }),
    async () => {
      await click(onlyThinkingLine())
      // The renderer is the app's own, loaded off the startup path; ask for it as a reply does.
      await import("@/components/chat/markdown-renderer")
      await settle()

      const body = sheet()
      assert.ok(body, "the sheet is open")
      assert.equal(
        body.querySelector("strong")?.textContent,
        "Read the parser first",
        "**bold** draws as a <strong>, not as its markers",
      )
      const items = [...body.querySelectorAll("li")].map((one) => one.textContent?.trim())
      assert.deepEqual(
        items.slice(0, 2),
        ["parse.ts keeps the scan", "its blocks are what matter"],
        "a list draws as list items",
      )
      assert.match(
        body.querySelector("pre code")?.textContent ?? "",
        /markdownBlocks\(text\)/,
        "a fence draws as code, as it does in the reply",
      )
      assert.match(
        sheetText(),
        /The scan is cheap in the end/,
        "the whole run reads, down to its last words, with no cap and no Show more",
      )
      absent("[data-slot=thinking-fade]")
      absent("[data-slot=thinking-cap]")
      absent("button", "Show more")
      assert.doesNotMatch(screenText(), /Show more/, "nowhere on the screen")
      assert.match(screenText(), new RegExp(ANSWER), "the answer is still drawn under it")
    },
  )
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
    assert.equal(expanded(onlyThinkingLine()), "false", "its sheet starts shut over an answer")
    assert.ok(!spins(onlyThinkingLine()), "and nothing spins for a run that ended")
    assert.match(screenText(), /12\.0s/, "and the turn's own duration stays in the stats line")
  })
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
    assert.equal(expanded(line), "false", "and its sheet shut")
    assert.match(screenText(), /12\.0s/, "while the reply's stats still show its own duration")
  })
})

test("a stopped or failed reply keeps its run, its words behind the row's sheet", async () => {
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
      assert.equal(expanded(line), "false", "and its sheet shut")
    }
    assert.match(screenText(), /Stopped/, "the stopped reply says so")
    assert.match(screenText(), /The host dropped the run\./, "and the failed one says why")
    await click(found[0])
    assert.match(sheetText(), /parse\.ts/, "its thinking still there, in the sheet")
    await shutSheet()
    await click(thinkingLines()[1])
    assert.match(sheetText(), /parse\.ts/, "and the other reply's too")
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

test("a run that already ended keeps its label while the call it broke runs", async () => {
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
      assert.ok(
        !spins(line),
        "an ended run does not spin as Thinking… while the call it broke runs",
      )
    },
  )
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
    assert.equal(lineLabel(after), "Thought it through", "and the second, its own way")

    const box = item(before)
    const calls = toolRow(box)
    const text = leafWith(box, "I read the parser first.")
    assert.ok(text, "the reply's text is in that turn")
    assert.ok(follows(before, calls), "the thinking before the call is drawn above it")
    assert.ok(follows(calls, after), "and the thinking after it below, once the calls are one row")
    assert.ok(follows(after, text), "where it happened, before the text that followed")

    await click(before)
    assert.match(sheetText(), /parse\.ts/, "the first stretch reads in its own sheet")
    assert.doesNotMatch(sheetText(), /blocks are what matter/, "and only its own")
    await shutSheet()
    await click(after)
    assert.match(sheetText(), /blocks are what matter/, "the second stretch in its own sheet")
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
    assert.equal(lineLabel(rows[1]), "Thought it through", "one label for the two of them")

    await click(rows[1])
    const body = sheetText()
    const first = body.indexOf("first call printed")
    const second = body.indexOf("blocks are what matter")
    assert.ok(first >= 0, "the sheet holds the stretch the first call broke")
    assert.ok(second >= 0, "and the one the second call broke")
    assert.ok(first < second, "in the order they arrived")
    assert.equal(body.match(/first call printed/g)?.length, 1, "each stretch once, not once a row")
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

test("a merged row whose last stretch still streams reads Thinking… and spins", async () => {
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
    assert.ok(spins(rows[1]), "and the spinner says the turn is at it now")
    assert.equal(expanded(rows[1]), "false", "with its sheet shut until a tap")
    await click(rows[1])
    assert.match(sheetText(), /first call printed/, "holding the one that ended")
    assert.match(sheetText(), /blocks are what matter/, "and the one still going")
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
    await click(line)
    assert.match(sheetText(), /blocks are what matter/, "holding all of it")
  })
})

test("while the turn waits on the user, the working line says so beside the spinning row", async () => {
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
    assert.ok(spins(onlyThinkingLine()), "the thinking is still arriving")
    assert.match(screenText(), /Waiting for your approval…/, "waiting on the user is named")
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
    const box = item(session[0])
    assert.equal(item(session[1]), box, "both rows belong to the one reply")
    assert.ok(follows(session[0], toolRow(box)), "the run before the calls is drawn above them")
    assert.ok(follows(toolRow(box), session[1]), "and the run after them below the call that broke it")

    await db.messages.put({
      ...(await db.messages.get("session-reply"))!,
      content: "",
      status: "streaming",
      // A live turn's newest run hasn't ended, so it carries no span to read a number from.
      reasoningRuns: [run(REASONING), run(SECOND, { afterToolId: "call-2" })],
    })
    await settle()
    const streaming = thinkingLines()
    assert.equal(streaming.length, 2, "a streaming session keeps one row per run")
    assert.equal(lineLabel(streaming[0]), "Thought it through", "the run before the calls is done")
    assert.equal(lineLabel(streaming[1]), "Thinking…", "its newest run spins, as a chat's does")
    assert.ok(spins(streaming[1]), "with the spinner the row wears everywhere")
    assert.equal(
      workingLine(),
      null,
      "and the session's footer leaves the saying to the row too",
    )

    await click(streaming[1])
    assert.match(sheetText(), /blocks are what matter/, "a tap opens the sheet here as well")
    await shutSheet()

    await db.messages.put({
      ...(await db.messages.get("session-reply"))!,
      content: ANSWER,
      status: "done",
    })
    await settle()
    const done = thinkingLines()
    assert.equal(done.length, 2, "the answer draws no row of its own")
    for (const line of done) assert.equal(expanded(line), "false", "with every sheet shut")
  })
})
