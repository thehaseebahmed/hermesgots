import assert from "node:assert/strict"
import test from "node:test"
import { db, type Message } from "@/lib/db"
import { noteAnswer, noteThinking } from "@/lib/thinking"
import {
  botProfile,
  chatScreen,
  click,
  expanded,
  json,
  lineLabel,
  mount,
  onlyThinkingLine,
  seedChat,
  settle,
  thinkingLines,
} from "./component-kit.tsx"

const bot = botProfile("thinking", { name: "Thinking" })

const ASK = "Where does the parser read a reply?"
const REASONING = "Read `parse.ts` first, then its blocks."
const ANSWER = "The parser reads it, then keeps its blocks."

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

async function stream(id: string) {
  await db.messages.put({ ...(await db.messages.get(id))!, status: "streaming" })
  await settle()
}

test("a streaming reply's line streams open and the working line stands down", async () => {
  host()
  const id = "streaming"
  await screen(undefined, turn({ id, reasoning: REASONING }), async () => {
    await stream(id)
    const line = onlyThinkingLine()
    assert.equal(lineLabel(line), "Thinking…", "still thinking, so no duration yet")
    assert.equal(expanded(line), "true", "and open, as the reasoning arrives")
    assert.match(
      reasoned(line).textContent ?? "",
      /Read `parse\.ts` first/,
      "its reasoning readable",
    )
    assert.equal(
      document.querySelector('[aria-live="polite"]'),
      null,
      "with the line open, the working line is gone rather than saying Thinking… again",
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

test("while the turn waits on the user, the working line says so even with the line open", async () => {
  host()
  const id = "waiting"
  const messages = turn({
    id,
    reasoning: REASONING,
    approval: {
      runId: "run-1",
      description: "Read parse.ts",
      choices: ["once", "deny"],
      requestedAt: 1_500,
    },
  })
  await screen(undefined, messages, async () => {
    await stream(id)
    assert.equal(expanded(onlyThinkingLine()), "true", "the reasoning is still arriving")
    assert.match(screenText(), /Waiting for your approval…/, "but waiting on the user is named")
  })
})

test("the first answer token folds the line and brings the working line back", async () => {
  host()
  const id = "first-token"
  await screen(undefined, turn({ id, reasoning: REASONING }), async () => {
    await stream(id)
    assert.equal(
      lineLabel(onlyThinkingLine()),
      "Thinking…",
      "the line streams open while the model thinks",
    )
    await db.messages.put({ ...(await db.messages.get(id))!, content: ANSWER })
    await settle()
    const line = onlyThinkingLine()
    assert.equal(expanded(line), "false", "the answer starting folds it")
    assert.equal(lineLabel(line), "Thought", "and no span was watched, so it reads bare")
    assert.equal(
      reasoned(line).getAttribute("aria-hidden"),
      "true",
      "folded text leaves the tree rather than being read out",
    )
    assert.match(screenText(), /Writing…/, "the working line says what the reply is doing again")
  })
})

test("a tap opens the folded line, a second folds it, and a remount folds it again", async () => {
  host()
  const messages = turn({ id: "tap-fold", reasoning: REASONING, content: ANSWER })
  await screen(undefined, messages, async () => {
    assert.equal(expanded(onlyThinkingLine()), "false", "an answered reply starts folded")
    await click(onlyThinkingLine())
    assert.equal(expanded(onlyThinkingLine()), "true", "a tap opens it")
    assert.match(
      reasoned(onlyThinkingLine()).textContent ?? "",
      /parse\.ts/,
      "and its reasoning is readable",
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

test("a tap while the model is still thinking folds the line, and the answer leaves it folded", async () => {
  host()
  const id = "tap-while-thinking"
  await screen(undefined, turn({ id, reasoning: REASONING }), async () => {
    await stream(id)
    assert.equal(
      lineLabel(onlyThinkingLine()),
      "Thinking…",
      "the line streams open while the model thinks",
    )
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
    assert.equal(lineLabel(answered), "Thought", "the first answer token ends the thinking")
    assert.equal(expanded(answered), "false", "and leaves the line as the user folded it")
    await click(onlyThinkingLine())
    assert.equal(expanded(onlyThinkingLine()), "true", "a second tap opens it again")
    assert.match(
      reasoned(onlyThinkingLine()).textContent ?? "",
      /parse\.ts/,
      "with its reasoning readable",
    )
  })
})

test("a line the user opens on an answered reply stays open until they fold it", async () => {
  host()
  const id = "opened-answered"
  await screen(undefined, turn({ id, reasoning: REASONING, content: ANSWER }), async () => {
    assert.equal(expanded(onlyThinkingLine()), "false", "an answered reply starts folded")
    await click(onlyThinkingLine())
    assert.equal(expanded(onlyThinkingLine()), "true", "a tap opens it")
    await db.messages.put({
      ...(await db.messages.get(id))!,
      reasoning: `${REASONING} Then its blocks.`,
    })
    await settle()
    const stillOpen = onlyThinkingLine()
    assert.match(
      reasoned(stillOpen).textContent ?? "",
      /Then its blocks\./,
      "the redraw brought the newer reasoning",
    )
    assert.equal(expanded(stillOpen), "true", "and the line stays open, as the user left it")
    await click(onlyThinkingLine())
    assert.equal(expanded(onlyThinkingLine()), "false", "until a tap folds it")
  })
})

test("a span this device watched reads in whole seconds, not the stats line's figure", async () => {
  host()
  const id = "watched"
  noteThinking(id, 1_000)
  noteAnswer(id, 13_000)
  const reply = {
    id,
    reasoning: REASONING,
    content: ANSWER,
    stats: { tokens: 40, estimated: false, durationMs: 12_000 },
  }
  await screen(undefined, turn(reply), async () => {
    assert.equal(lineLabel(onlyThinkingLine()), "Thought for 12s", "the span this device watched")
    assert.equal(expanded(onlyThinkingLine()), "false", "still folded over an answer")
    assert.match(screenText(), /12\.0s/, "and the turn's own duration stays in the stats line")
  })
})

test("a restored reply reads bare Thought and keeps its duration in the stats", async () => {
  host()
  const reply = {
    id: "restored",
    reasoning: REASONING,
    content: ANSWER,
    stats: { tokens: 40, estimated: false, durationMs: 12_000 },
  }
  await screen(undefined, turn(reply), async () => {
    const line = onlyThinkingLine()
    assert.equal(lineLabel(line), "Thought", "nothing here watched it think, so no number")
    assert.doesNotMatch(lineLabel(line), /\d/, "no figure at all")
    assert.equal(expanded(line), "false", "and folded")
    assert.match(screenText(), /12\.0s/, "while the reply's stats still show its own duration")
  })
})

test("a stopped or failed reply keeps its line, folded", async () => {
  host()
  const messages: Message[] = [
    ...turn({ id: "stopped", reasoning: REASONING, status: "stopped" }),
    {
      id: "failed",
      conversationId: "",
      role: "assistant",
      content: "",
      reasoning: REASONING,
      status: "error",
      statusText: "The host dropped the run.",
      createdAt: 3,
    },
  ]
  await screen(undefined, messages, async () => {
    const found = thinkingLines()
    assert.equal(found.length, 2, "each reply keeps what arrived")
    for (const line of found) {
      assert.equal(lineLabel(line), "Thought", "with no span watched")
      assert.equal(expanded(line), "false", "and folded")
      assert.match(reasoned(line).textContent ?? "", /parse\.ts/, "its reasoning still there")
    }
    assert.match(screenText(), /Stopped/, "the stopped reply says so")
    assert.match(screenText(), /The host dropped the run\./, "and the failed one says why")
  })
})

test("a reply with no thinking of its own draws no line", async () => {
  host()
  const messages: Message[] = [
    ...turn({ id: "empty", reasoning: "", content: ANSWER }),
    {
      id: "blank",
      conversationId: "",
      role: "assistant",
      content: ANSWER,
      reasoning: "  \n\t ",
      status: "done",
      createdAt: 3,
    },
  ]
  await screen(undefined, messages, async () => {
    assert.equal(thinkingLines().length, 0, "empty and whitespace-only thinking draw nothing")
  })
})

test("a reply broken by a steer and an answered approval keeps one line, above its first text", async () => {
  host()
  const reply = "I read the parser first.\n\nThen I kept its blocks."
  const messages: Message[] = [
    ...turn({
      id: "broken",
      reasoning: REASONING,
      content: reply,
      status: "done",
      approval: {
        runId: "run-1",
        description: "Read parse.ts",
        choices: ["once", "deny"],
        resolved: "once",
        contentOffset: 0,
        requestedAt: 1_500,
      },
      steers: [
        { id: "steer-1", text: "And its blocks?", contentOffset: reply.indexOf("Then"), at: 2 },
      ],
    }),
  ]
  await screen(undefined, messages, async () => {
    const line = onlyThinkingLine()
    assert.equal(
      lineLabel(line),
      "Thought",
      "the reasoning accumulates across the breaks, as one line",
    )
    const box = item(line)
    const first = leafWith(box, "I read the parser first.")
    assert.ok(first, "the reply's first text is in that turn")
    assert.ok(follows(line, first), "with the line drawn above it")
    const steer = leafWith(box, "And its blocks?")
    assert.ok(steer, "the steer sits where it reached the agent")
    assert.ok(follows(line, steer), "and below the one line")
  })
})

test("a coding session draws no line where the same reply in a chat draws one", async () => {
  host()
  const reply = {
    id: "session-reply",
    reasoning: REASONING,
    content: ANSWER,
  }
  await screen(undefined, turn(reply), async () => {
    assert.equal(lineLabel(onlyThinkingLine()), "Thought", "a chat draws the model's thinking")
  })
  await screen("project-1", turn(reply), async () => {
    assert.match(screenText(), /The parser reads it/, "the session still draws the reply")
    assert.equal(thinkingLines().length, 0, "with no thinking line")
  })
})

test("with reduced motion asked for, a tap still opens the line and a second folds it", async () => {
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
      reasoning: REASONING,
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
