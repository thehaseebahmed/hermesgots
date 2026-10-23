import assert from "node:assert/strict"
import test from "node:test"
import { db, type Message, type ToolEvent } from "@/lib/db"
import type { ReasoningRun } from "@/lib/thinking"
import {
  botProfile,
  chatScreen,
  click,
  expanded,
  find,
  findText,
  json,
  lineLabel,
  mount,
  onlyThinkingLine,
  resized,
  seedChat,
  settle,
  thinkingLines,
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
) {
  const id = projectId ? "session-1" : "chat-1"
  await seedChat({ id, projectId, messages, profile: bot })
  await mount(chatScreen(id), body)
}

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
  const found = [...root.querySelectorAll("button[aria-label]")].find((button) =>
    /command|file|code/i.test(button.getAttribute("aria-label") ?? ""),
  )
  assert.ok(found, "the call was drawn")
  return found
}

async function stream(id: string) {
  await db.messages.put({ ...(await db.messages.get(id))!, status: "streaming" })
  await settle()
}

/** The box the opened run's words sit in, and the two things a run too tall for it draws. */
const cap = () => find("[data-slot=thinking-cap]")
const fade = () => find("[data-slot=thinking-fade]")
const more = () => findText("button", "Show more")

/** The size a browser would report for a box; a DOM without layout has none to report. */
function sized(element: Element, size: { client: number; scroll: number }) {
  Object.defineProperty(element, "clientHeight", { value: size.client, configurable: true })
  Object.defineProperty(element, "scrollHeight", { value: size.scroll, configurable: true })
}

/** The thread's own scroll box: what a reader scrolls, and what the row's end is kept in view of. */
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

test("a run taller than its cap draws a fade and a Show more, which reveals the rest", async () => {
  host()
  await screen(
    undefined,
    turn({ id: "capped", reasoningRuns: [run(MARKDOWN)], content: ANSWER }),
    async () => {
      await click(onlyThinkingLine())
      const box = cap()
      assert.ok(box, "the opened run's words sit in their own box")
      assert.match(box.className, /max-h-\[30dvh\]/, "capped against the screen's own height")
      assert.equal(fade(), null, "nothing is hidden yet, so no fade")
      assert.equal(more(), null, "and nothing to reveal")

      // A browser measures the box; this one has to be told. The run is three times its cap.
      sized(box, { client: 240, scroll: 720 })
      await resized("[data-slot=thinking-cap]")
      assert.ok(fade(), "a fade at the edge the rest of the run falls past")
      const control = more()
      assert.ok(control, "and a Show more under it")
      assert.equal(lineLabel(control), "Show more", "worded plainly")

      await click(control)
      assert.equal(more(), null, "revealing the rest drops the control")
      assert.equal(fade(), null, "and the fade with it")
      assert.doesNotMatch(
        cap()?.className ?? "",
        /max-h-/,
        "and the cap, so the whole run reads inline",
      )
      assert.match(
        reasoned(onlyThinkingLine()).textContent ?? "",
        /markdownBlocks\(text\)/,
        "the last of it still there",
      )
    },
  )
})

test("opening a run lands on its newest words, and the tail follows until a scroll up", async () => {
  host()
  const id = "following"
  const into: ScrollIntoViewOptions[] = []
  const scrolled = HTMLElement.prototype.scrollIntoView
  const media = globalThis.matchMedia
  HTMLElement.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
    if (typeof options === "object" && options?.block === "end") into.push(options)
  }
  try {
    await screen(undefined, turn({ id, reasoningRuns: [run(REASONING)] }), async () => {
      await stream(id)
      // Fold it and open it again, the way a reader opens a row: opening is what lands on the end.
      await click(onlyThinkingLine())
      into.length = 0
      await click(onlyThinkingLine())
      assert.equal(into.at(-1)?.block, "end", "opening puts the run's end in view")
      assert.equal(into.at(-1)?.behavior, "smooth", "gliding there, as the thread's own moves do")

      // The words arrive: the row's end is put back in view as it grows.
      into.length = 0
      await db.messages.put({
        ...(await db.messages.get(id))!,
        reasoningRuns: [run(`${REASONING} Then the blocks.`)],
      })
      await settle()
      await resized("[data-slot=thinking-body]")
      assert.ok(into.length > 0, "growth keeps the end of the row in view")

      // A reader scrolling the thread up leaves the follow where it was: it stays off for this row.
      const view = viewport()
      view.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -120, bubbles: true }))
      into.length = 0
      await db.messages.put({
        ...(await db.messages.get(id))!,
        reasoningRuns: [run(`${REASONING} Then the blocks. Its scan is cheap.`)],
      })
      await settle()
      await resized("[data-slot=thinking-body]")
      assert.equal(into.length, 0, "a scroll up stops the follow, for good")

      // Opening it again re-arms it.
      await click(onlyThinkingLine())
      into.length = 0
      await click(onlyThinkingLine())
      assert.ok(into.length > 0, "and opening the row again follows it once more")
    })

    // With motion asked against, the same landing happens without an animation.
    const reduced = (query: string) => {
      const answer = media(query)
      if (query !== "(prefers-reduced-motion: reduce)") return answer
      return { ...answer, matches: true }
    }
    globalThis.matchMedia = reduced
    window.matchMedia = reduced
    await screen(undefined, turn({ id: "no-motion", reasoningRuns: [run(REASONING)], content: ANSWER }), async () => {
      into.length = 0
      await click(onlyThinkingLine())
      assert.equal(into.at(-1)?.block, "end", "still the run's end")
      assert.equal(into.at(-1)?.behavior, "auto", "placed with no motion at all")
    })
  } finally {
    HTMLElement.prototype.scrollIntoView = scrolled
    globalThis.matchMedia = media
    window.matchMedia = media
  }
})

test("with reduced motion asked for, a tap still opens the row and a second folds it", async () => {
  host()
  const media = globalThis.matchMedia
  const reduced = (query: string) => {
    const answer = media(query)
    if (query !== "(prefers-reduced-motion: reduce)") return answer
    return { ...answer, matches: true }
  }
  globalThis.matchMedia = reduced
  window.matchMedia = reduced
  try {
    const messages = turn({
      id: "reduced",
      reasoningRuns: [run(REASONING)],
      content: ANSWER,
    })
    await screen(undefined, messages, async () => {
      assert.equal(expanded(onlyThinkingLine()), "false", "folded to start")
      await click(onlyThinkingLine())
      assert.equal(expanded(onlyThinkingLine()), "true", "a tap opens it, with no motion needed")
      await click(onlyThinkingLine())
      assert.equal(expanded(onlyThinkingLine()), "false", "and a second folds it")
    })
  } finally {
    globalThis.matchMedia = media
    window.matchMedia = media
  }
})
