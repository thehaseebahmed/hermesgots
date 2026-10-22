/**
 * An interface in a chat thread: a block that draws, from the component library and with no code
 * left behind; a block that cannot be drawn, shown as the source the model sent with its language
 * label; a patch, applied where the interface already sits; an orphan, drawn as code; and a reply
 * with no block, the reply it always was. The fold and the block arrive as lazy chunks and a reply
 * types its words out, so every assertion polls for what it expects rather than for a tick.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { act } from "react"

import { db, type Message } from "@/lib/db"
import {
  botProfile,
  chatScreen,
  findAll,
  json,
  mount,
  seedChat,
  settle,
  text,
  until,
} from "./component-kit.tsx"

const bot = botProfile("openui")

function host(transcript: unknown[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: transcript })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

/** The fold's chunk, the block's, and the renderer that draws a fallback's code. */
async function warm() {
  await import("@/lib/openui-thread.ts")
  await import("@/components/openui/openui-block")
  await import("@/components/chat/markdown-renderer")
}

/** The block's fence around its body, the wire format the model writes. */
const block = (body: string) => ["```openui-lang", body, "```"].join("\n")

const ask = (content: string): Message => ({
  id: "ask",
  conversationId: "",
  role: "user",
  content,
  status: "done",
  createdAt: 1,
})

const reply = (id: string, content: string, extra: Partial<Message> = {}): Message => ({
  id,
  conversationId: "",
  role: "assistant",
  content,
  status: "done",
  createdAt: 2,
  ...extra,
})

const rows = () => findAll("[data-slot=message]")
const replyRow = (needle: string) =>
  rows().find(
    (row) => row.getAttribute("data-align") === "start" && row.textContent?.includes(needle),
  )
const codeOf = (row: Element | undefined) => row?.querySelector("div[data-md-code]")
const cardOf = (row: Element | undefined) => row?.querySelector("[data-slot=card]")
/**
 * A code block's language label: the label slot carries the fence's own language, so a fence the
 * model wrote as `openui-lang` says exactly that.
 */
const labelOf = (code: Element) => code.querySelector("span")?.textContent

/** Polls until `check` holds, letting every lazy chunk, live read and typing frame land. */
async function drawn(check: () => boolean, what: string) {
  await until(async () => {
    await settle()
    return check()
  }, what)
}

/** What the console's verbose level says about fallbacks, counted for one test. */
function watch() {
  const notes: string[] = []
  const original = console.debug
  console.debug = (...args: unknown[]) => {
    notes.push(args.map(String).join(" "))
    original(...args)
  }
  return {
    fallbacks: () => notes.filter((line) => line.includes("openui block")).length,
    stop: () => {
      console.debug = original
    },
  }
}

async function screen(messages: Message[], body: () => Promise<void>) {
  host()
  await seedChat({ id: "chat-1", messages, profile: bot })
  await warm()
  const seen = watch()
  try {
    await mount(chatScreen("chat-1"), body)
  } finally {
    seen.stop()
  }
  return seen
}

/** A stored reply changing the way a stream changes it: one write, one live read. */
async function store(patch: Partial<Message>) {
  await act(async () => {
    await db.messages.update("live", patch)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const SALES = ["# id: sales", "root = Stack([c])", 'c = Card("Quarterly sales", "Up 12%.")'].join(
  "\n",
)

test("a settled reply's block draws the interface, with no code left behind", async () => {
  const content = `Here are the numbers.\n\n${block(SALES)}\n\nThat is the quarter.`
  const seen = await screen([ask("How did the quarter go?"), reply("reply", content)], async () => {
    await drawn(() => Boolean(cardOf(replyRow("Here are the numbers"))), "the interface")
    const row = replyRow("Here are the numbers")
    assert.ok(row, "the reply is a row of the thread")
    assert.equal(
      row.querySelector("[data-slot=card-title]")?.textContent,
      "Quarterly sales",
      "the card draws from the library",
    )
    assert.match(row.textContent ?? "", /Up 12%\./, "with its body")
    assert.equal(row.querySelectorAll("pre").length, 0, "no <pre> left behind")
    assert.equal(row.querySelectorAll("[data-md-code]").length, 0, "and no code block")
    assert.match(row.textContent ?? "", /Here are the numbers\./, "the text before the block draws")
    assert.match(row.textContent ?? "", /That is the quarter\./, "and the text after")
    assert.doesNotMatch(row.textContent ?? "", /openui-lang/, "the fence's own text draws nothing")
  })
  assert.equal(seen.fallbacks(), 0, "the block drew: nothing was noted")
})

test("an unknown component draws as the fenced source, noted once and nowhere in the thread", async () => {
  const content = `This one is odd.\n\n${block('root = Stack([Nope("x")])')}`
  const seen = await screen([ask("Draw the odd one."), reply("reply", content)], async () => {
    await drawn(() => Boolean(codeOf(replyRow("This one is odd"))), "the fallback")
    const row = replyRow("This one is odd")
    assert.ok(row, "the reply is a row of the thread")
    const code = codeOf(row)
    assert.ok(code, "the block draws as code")
    assert.equal(labelOf(code), "openui-lang", "with the fence's language label")
    assert.match(code.textContent ?? "", /root = Stack\(\[Nope\("x"\)\]\)/, "as the model wrote it")
    assert.equal(cardOf(row), null, "and no interface")
    assert.doesNotMatch(text(), /\[memento\]/, "the note is nowhere in the thread")
    assert.doesNotMatch(text(), /openui block/, "nor its words")
    await settle()
  })
  assert.equal(seen.fallbacks(), 1, "noted once at the console's verbose level")
})

test("a validation failure draws as the fenced source", async () => {
  const content = `Validation fails here.\n\n${block('root = Stack([List(["a"])])')}`
  const seen = await screen([ask("Draw the list."), reply("reply", content)], async () => {
    await drawn(() => Boolean(codeOf(replyRow("Validation fails here"))), "the fallback")
    const row = replyRow("Validation fails here")
    assert.ok(row)
    const code = codeOf(row)
    assert.ok(code, "the block draws as code")
    assert.equal(labelOf(code), "openui-lang", "with the fence's language label")
    assert.match(code.textContent ?? "", /List\(\["a"\]\)/, "as the model wrote it")
    assert.equal(cardOf(row), null, "and no interface")
    assert.doesNotMatch(text(), /\[memento\]/, "the note is nowhere in the thread")
    await settle()
  })
  assert.equal(seen.fallbacks(), 1, "noted once at the console's verbose level")
})

test("a patch in a later reply changes the earlier interface and draws nothing where it sits", async () => {
  const first = ["# id: sales", "root = Stack([c])", 'c = Card("First")'].join("\n")
  const patch = ["# id: sales", 'c = Card("Second")'].join("\n")
  const seen = await screen(
    [
      ask("Show the card."),
      reply("first", `The card:\n\n${block(first)}`),
      reply("later", `The update:\n\n${block(patch)}`, { createdAt: 3 }),
    ],
    async () => {
      await drawn(
        () =>
          replyRow("The card:")?.querySelector("[data-slot=card-title]")?.textContent === "Second",
        "the patched interface",
      )
      const earlier = replyRow("The card:")
      const later = replyRow("The update:")
      assert.ok(earlier && later, "both replies are rows of the thread")
      assert.equal(
        earlier.querySelector("[data-slot=card-title]")?.textContent,
        "Second",
        "the earlier interface changed in place",
      )
      assert.equal(cardOf(later), null, "the patch draws nothing where it sits")
      assert.equal(codeOf(later), null, "and no code either")
      assert.equal(findAll("[data-slot=card]").length, 1, "one interface in the whole thread")
      assert.doesNotMatch(text(), /First/, "the superseded source draws nowhere")
      assert.doesNotMatch(text(), /openui-lang/, "nor does either fence")
      assert.match(later.textContent ?? "", /The update:/, "the patch's own text still draws")
    },
  )
  assert.equal(seen.fallbacks(), 0, "a patch that applied is no fallback")
})

test("a patch that repairs a broken interface draws it again", async () => {
  const broken = ["# id: sales", "root = Stack([c])", 'c = Chart("sales")'].join("\n")
  const patch = ["# id: sales", 'c = Card("Fixed")'].join("\n")
  const live = reply("live", "The fix.", { createdAt: 3 })
  const seen = await screen(
    [ask("Show the card."), reply("first", `The card:\n\n${block(broken)}`), live],
    async () => {
      await drawn(() => Boolean(codeOf(replyRow("The card:"))), "the fallback")
      assert.equal(cardOf(replyRow("The card:")), null, "the broken interface draws as code")
      await store({ content: `The fix.\n\n${block(patch)}` })
      await drawn(
        () =>
          replyRow("The card:")?.querySelector("[data-slot=card-title]")?.textContent === "Fixed",
        "the repaired interface",
      )
      const earlier = replyRow("The card:")
      assert.ok(earlier, "the earlier reply is still a row of the thread")
      assert.equal(codeOf(earlier), null, "the fallback it drew is gone")
      assert.ok(cardOf(earlier), "and the interface draws again")
      assert.equal(cardOf(replyRow("The fix.")), null, "the patch draws nothing where it sits")
    },
  )
  assert.equal(seen.fallbacks(), 1, "the failure was noted once, before the repair")
})

test("an orphan patch draws as the fenced source", async () => {
  const kept = ["# id: sales", "root = Stack([c])", 'c = Card("Kept")'].join("\n")
  const ghost = ["# id: ghost", 'c = Card("Phantom")'].join("\n")
  const seen = await screen(
    [
      ask("Show the card."),
      reply("first", `A card first.\n\n${block(kept)}`),
      reply("later", `This changes nothing.\n\n${block(ghost)}`, { createdAt: 3 }),
    ],
    async () => {
      await drawn(() => Boolean(codeOf(replyRow("This changes nothing"))), "the orphan")
      const earlier = replyRow("A card first.")
      const later = replyRow("This changes nothing")
      assert.ok(earlier && later)
      assert.equal(
        earlier.querySelector("[data-slot=card-title]")?.textContent,
        "Kept",
        "the interface the orphan named nothing of",
      )
      const code = codeOf(later)
      assert.ok(code, "the orphan draws as code")
      assert.equal(labelOf(code), "openui-lang", "with the fence's language label")
      assert.match(code.textContent ?? "", /Card\("Phantom"\)/, "as the model wrote it")
      assert.equal(cardOf(later), null, "and no interface of its own")
      assert.doesNotMatch(text(), /\[memento\]/, "the note is nowhere in the thread")
      await settle()
    },
  )
  assert.equal(seen.fallbacks(), 1, "noted once at the console's verbose level")
})

test("a reply with no block renders as before, its ordinary fence still drawing as ts", async () => {
  const content = [
    "## The parser",
    "",
    "A reply is read in `parse.ts`, then kept as blocks.",
    "",
    "> Its tests run on the device.",
    "",
    "```ts",
    "const blocks = markdownBlocks(text)",
    "```",
  ].join("\n")
  const seen = await screen(
    [ask("Where does the parser read a reply?"), reply("reply", content)],
    async () => {
      await drawn(() => Boolean(codeOf(replyRow("The parser"))), "the markdown")
      const row = replyRow("The parser")
      assert.ok(row)
      const code = codeOf(row)
      assert.ok(code, "the fence draws as code")
      assert.equal(labelOf(code), "ts", "labelled with its own language")
      assert.match(code.textContent ?? "", /markdownBlocks\(text\)/, "holding its code")
      assert.equal(row.querySelectorAll("div[data-md-code]").length, 1, "exactly the one fence")
      assert.ok(row.querySelector("blockquote"), "the quote keeps its treatment")
      assert.match(row.textContent ?? "", /A reply is read in/, "the text draws as before")
      assert.match(row.textContent ?? "", /parse\.ts/, "the inline code too")
      assert.equal(cardOf(row), null, "nothing of an interface")
    },
  )
  assert.equal(seen.fallbacks(), 0, "a reply with no block is no fallback")
})

test("a streaming reply shows nothing until a root parses, then the interface fills in", async () => {
  const control = `A card first.\n\n${block(["root = Stack([c])", 'c = Card("Control")'].join("\n"))}`
  const live = reply("live", "On it.", { createdAt: 3 })
  const seen = await screen([ask("Draw it live."), reply("control", control), live], async () => {
    // The control's card is the signal that both lazy chunks have landed and the fold has run. The
    // reply turns streaming in one stored write, the way a stream arrives — a reply left streaming
    // while this device is away is reconciled to stopped, so it can never start that way here.
    await drawn(() => text().includes("Control"), "the control interface")
    await store({ content: "On it.\n\n```openui-lang\nroot =", status: "streaming" })
    const row = () => replyRow("On it.")
    await drawn(
      () => Boolean(row()) && !codeOf(row()) && !cardOf(row()),
      "the reply to draw nothing",
    )
    await settle()
    assert.equal(cardOf(row()), null, "nothing shows before a root parses")
    assert.equal(row()?.querySelector("[aria-busy]"), null, "not even the shell")
    assert.equal(codeOf(row()), null, "and no code in its place")
    assert.doesNotMatch(row()?.textContent ?? "", /openui-lang/, "the fence draws nothing")

    await store({ content: "On it.\n\n```openui-lang\nroot = Stack([c])" })
    await drawn(() => Boolean(row()?.querySelector("[aria-busy]")), "the interface shell")
    assert.equal(cardOf(row()), null, "the shell holds no card yet")
    assert.equal(codeOf(row()), null, "still no code")

    await store({ content: 'On it.\n\n```openui-lang\nroot = Stack([c])\nc = Card("Late")' })
    await drawn(
      () => row()?.querySelector("[data-slot=card-title]")?.textContent === "Late",
      "the interface filling in",
    )
    assert.equal(codeOf(row()), null, "and still no code")
  })
  assert.equal(seen.fallbacks(), 0, "a healthy stream is no fallback")
})

test("a block that breaks mid-stream stops drawing and falls back once the reply stops", async () => {
  const drawing = 'Watch.\n\n```openui-lang\nroot = Stack([c, u])\nc = Card("Kept")'
  const broken = `${drawing}\nu = Nope("x")`
  const live = reply("live", "Watch.", { createdAt: 2 })
  const seen = await screen([ask("Draw it live."), live], async () => {
    await store({ content: drawing, status: "streaming" })
    await drawn(
      () => replyRow("Watch.")?.querySelector("[data-slot=card-title]")?.textContent === "Kept",
      "the interface",
    )
    await store({ content: broken })
    await drawn(
      () =>
        Boolean(replyRow("Watch.")) &&
        !cardOf(replyRow("Watch.")) &&
        !replyRow("Watch.")?.querySelector("[aria-busy]"),
      "the broken block to stop drawing",
    )
    assert.equal(codeOf(replyRow("Watch.")), null, "still writing: the gap reads as still typing")
    await settle()

    await store({ status: "stopped" })
    await drawn(() => Boolean(codeOf(replyRow("Watch."))), "the fallback")
    const code = codeOf(replyRow("Watch."))
    assert.ok(code, "the block draws as code")
    assert.equal(labelOf(code), "openui-lang", "with the fence's language label")
    assert.match(code.textContent ?? "", /u = Nope\("x"\)/, "holding the source the model sent")
    assert.doesNotMatch(text(), /\[memento\]/, "the note is nowhere in the thread")
    await settle()
  })
  assert.equal(seen.fallbacks(), 1, "noted once at the console's verbose level")
})

test("an open block in a reply that has stopped draws as the fenced source", async () => {
  const content = 'Cut off.\n\n```openui-lang\nroot = Stack([c])\nc = Card("Never")'
  const seen = await screen(
    [ask("Draw it live."), reply("live", content, { status: "stopped", createdAt: 2 })],
    async () => {
      await drawn(() => Boolean(codeOf(replyRow("Cut off."))), "the fallback")
      const row = replyRow("Cut off.")
      assert.ok(row)
      const code = codeOf(row)
      assert.ok(code, "the block draws as code")
      assert.equal(labelOf(code), "openui-lang", "with the fence's language label")
      assert.match(code.textContent ?? "", /Card\("Never"\)/, "holding the source the model sent")
      assert.equal(cardOf(row), null, "and no interface")
      assert.doesNotMatch(text(), /\[memento\]/, "the note is nowhere in the thread")
      await settle()
    },
  )
  assert.equal(seen.fallbacks(), 1, "noted once at the console's verbose level")
})
