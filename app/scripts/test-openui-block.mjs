/**
 * A reply's `openui-lang` fences: which ones are blocks to draw, where each one starts, the body it
 * holds, its id, and whether the reply is still streaming it.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { openuiParts } from "../src/lib/openui-block.ts"

const asText = (reply) => [{ kind: "text", at: 0, text: reply }]

/** Every part starts exactly where its `at` says it does. */
const startsWhereItSays = (reply, parts) =>
  parts.every((part) =>
    part.kind === "text"
      ? reply.startsWith(part.text, part.at)
      : /^(`{3,}|~{3,})openui-lang/.test(reply.slice(part.at)),
  )

test("a reply with no fence is one text part at the start", () => {
  const reply = "Just an answer, nothing to draw."
  assert.deepEqual(openuiParts(reply), asText(reply), "the whole reply, one part")
})

test("one block splits the reply into text, block and text", () => {
  const reply = ["Before.", "", "```openui-lang", "# id: sales", "a = 1", "```", "", "After."].join(
    "\n",
  )
  const at = reply.indexOf("```openui-lang")
  const close = reply.indexOf("```", at + 3)
  assert.deepEqual(
    openuiParts(reply),
    [
      { kind: "text", at: 0, text: "Before.\n\n" },
      { kind: "openui", at, source: "# id: sales\na = 1", id: "sales", open: false },
      { kind: "text", at: close + 3, text: "\n\nAfter." },
    ],
    "each part at its own offset, and the source is the body alone",
  )
})

test("two blocks come out in order with the text between them", () => {
  const reply = [
    "One.",
    "",
    "```openui-lang",
    "A",
    "```",
    "",
    "Two.",
    "",
    "```openui-lang",
    "B",
    "```",
    "",
    "Three.",
  ].join("\n")
  const parts = openuiParts(reply)
  assert.deepEqual(
    parts.map((part) => part.kind),
    ["text", "openui", "text", "openui", "text"],
    "text and blocks alternating",
  )
  assert.deepEqual(
    parts.filter((part) => part.kind === "openui").map((part) => part.source),
    ["A", "B"],
    "each block's own body, in order",
  )
  assert.deepEqual(
    parts.filter((part) => part.kind === "text").map((part) => part.text),
    ["One.\n\n", "\n\nTwo.\n\n", "\n\nThree."],
    "and the text around them is untouched",
  )
  assert.equal(parts[1].at, reply.indexOf("```openui-lang"), "the first block where it starts")
  assert.equal(
    parts[3].at,
    reply.lastIndexOf("```openui-lang"),
    "the second after the text between",
  )
  assert.ok(startsWhereItSays(reply, parts), "no offset drifts")
})

test("a reply that is only a block is one block part", () => {
  const reply = "```openui-lang\na = 1\n```"
  assert.deepEqual(
    openuiParts(reply),
    [{ kind: "openui", at: 0, source: "a = 1", open: false }],
    "no empty text on either side",
  )
})

test("a block with no closing fence is open, running to the end of the text", () => {
  const reply = ["Before.", "", "```openui-lang", "# id: sales", "a = 1"].join("\n")
  const parts = openuiParts(reply)
  assert.equal(parts.length, 2, "text, then the open block")
  assert.deepEqual(
    parts.at(-1),
    {
      kind: "openui",
      at: reply.indexOf("```openui-lang"),
      source: "# id: sales\na = 1",
      id: "sales",
      open: true,
    },
    "a reply still streaming looks like this",
  )
})

test("an open block drops one trailing newline", () => {
  const [part] = openuiParts("```openui-lang\na = 1\n")
  assert.equal(part.open, true, "nothing closed it")
  assert.equal(part.source, "a = 1", "and the stream's last newline is not the body")
})

test("a closed block reports open: false", () => {
  const [part] = openuiParts("```openui-lang\na = 1\n```")
  assert.equal(part.open, false, "the reply finished the block")
})

test("a closing fence longer than the opener closes the block", () => {
  const reply = "```openui-lang\na = 1\n`````"
  assert.deepEqual(
    openuiParts(reply),
    [{ kind: "openui", at: 0, source: "a = 1", open: false }],
    "four backticks close three",
  )
})

test("a closing fence shorter than the opener does not close the block", () => {
  const reply = "````openui-lang\na = 1\n```"
  const [part] = openuiParts(reply)
  assert.equal(part.open, true, "the short run is body")
  assert.equal(part.source, "a = 1\n```", "and the block runs on past it")
})

test("tilde fences work the same", () => {
  const reply = "~~~openui-lang\na = 1\n~~~"
  assert.deepEqual(
    openuiParts(reply),
    [{ kind: "openui", at: 0, source: "a = 1", open: false }],
    "a block in tildes",
  )
  assert.ok(startsWhereItSays(reply, openuiParts(reply)), "at the fence it opened on")
})

test("a backtick opener is not closed by tildes", () => {
  const reply = "```openui-lang\na = 1\n~~~"
  const [part] = openuiParts(reply)
  assert.equal(part.open, true, "a different character closes nothing")
  assert.equal(part.source, "a = 1\n~~~", "the tilde line is body")
})

test("a block shown inside another fence stays an example", () => {
  const reply = ["```md", "```openui-lang", "# id: sales", "a = 1", "```"].join("\n")
  assert.deepEqual(
    openuiParts(reply),
    [asText(reply)[0]],
    "a reply about Lang keeps showing Lang as code",
  )
})

test("a fence inside a list item is an example, not a block", () => {
  const reply = ["- Items:", "   ```openui-lang", "   # id: sales", "   ```"].join("\n")
  assert.deepEqual(openuiParts(reply), [asText(reply)[0]], "the whole list is the reply's text")
})

test("a fence back at the margin after a list is a block again", () => {
  const reply = ["- Items:", "  one", "", "```openui-lang", "a = 1", "```"].join("\n")
  const parts = openuiParts(reply)
  assert.deepEqual(
    parts.map((part) => part.kind),
    ["text", "openui"],
    "the list stays text",
  )
  assert.equal(parts[1].source, "a = 1", "and the block after it is read")
  assert.equal(parts[1].at, reply.indexOf("```openui-lang"), "from its own fence")
})

test("only the exact info string opens a block", () => {
  for (const info of ["openui", "openui-lang ", "openui-lang x", "openui-langx", "Openui-lang"]) {
    const reply = ["```" + info, "a = 1", "```"].join("\n")
    assert.deepEqual(
      openuiParts(reply),
      asText(reply),
      `${JSON.stringify(info)} is not openui-lang`,
    )
  }
})

test("a fence indented four spaces is text", () => {
  const reply = ["    ```openui-lang", "    a = 1", "    ```"].join("\n")
  assert.deepEqual(openuiParts(reply), asText(reply), "four spaces in is code, not a block")
})

test("the id is read from the first non-blank line of the body", () => {
  const reply = ["```openui-lang", "", "   ", "# id: sales", "a = 1", "```"].join("\n")
  const [part] = openuiParts(reply)
  assert.equal(part.kind, "openui", "the reply is one block")
  assert.equal(part.id, "sales", "read past the blank lines")
  assert.equal(part.source, "\n   \n# id: sales\na = 1", "and the body is otherwise as written")
})

test("the id line stays in the source", () => {
  const reply = ["```openui-lang", "# id: sales", "a = 1", "```"].join("\n")
  const [part] = openuiParts(reply)
  assert.equal(part.id, "sales", "the id is read")
  assert.ok(part.source.startsWith("# id: sales\n"), "the parser strips that line, not this one")
})

test("a malformed id is no id, and the block still comes back", () => {
  const malformed = [
    "# id: Sales",
    "# id:",
    "#id: sales",
    `# id: ${"a".repeat(41)}`,
    "# id: sale_s",
    "# id: sales extra",
  ]
  for (const line of malformed) {
    const reply = ["```openui-lang", line, "a = 1", "```"].join("\n")
    const [part] = openuiParts(reply)
    assert.equal(part.kind, "openui", `${line} still leaves a block`)
    assert.equal("id" in part, false, `${line} carries no id at all`)
    assert.ok(part.source.startsWith(line), `${line} is still the body's first line`)
  }
})

test("the splitter touches nothing but the string", () => {
  const raw = readFileSync(new URL("../src/lib/openui-block.ts", import.meta.url), "utf8")
  const source = raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
  assert.doesNotMatch(source, /^[ \t]*(?:import|export)\b.*\bfrom\b/m, "no module is reached")
  assert.doesNotMatch(source, /\bimport\s*\(/, "and nothing is loaded on demand")
  assert.doesNotMatch(source, /^[ \t]*import\b/m, "not even for its side effect")
  for (const token of ["dexie", "indexeddb", "localstorage", "sessionstorage"]) {
    assert.ok(!source.toLowerCase().includes(token), `nothing here touches ${token}`)
  }
})
