import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { mermaidParts } from "../src/lib/mermaid-fences.ts"

const asText = (text) => [{ kind: "text", at: 0, text }]

const tiles = (text, parts) => {
  let at = 0
  for (const [i, part] of parts.entries()) {
    assert.equal(part.at, at, `part ${i} starts where the one before it ended`)
    const slice = text.slice(part.at, parts[i + 1]?.at ?? text.length)
    if (part.kind === "text") assert.equal(slice, part.text, `part ${i} is exactly its own text`)
    else
      assert.match(
        slice,
        /^```mermaid(?:\r?\n[\s\S]*)?\r?\n```$/,
        `part ${i} is a whole fence, opener to closer`,
      )
    at += slice.length
  }
  assert.equal(at, text.length, "the parts end at the text's end")
}

test("an empty text has no parts", () => {
  assert.deepEqual(mermaidParts(""), [], "nothing to place")
})

test("a text with no fence is one text part at the start", () => {
  const text = "Just an answer, nothing to draw."
  assert.deepEqual(mermaidParts(text), asText(text), "the whole text, one part")
})

test("one closed fence splits the text into text, fence and text", () => {
  const text = ["Before.", "", "```mermaid", "graph TD", "  A --> B", "```", "", "After."].join("\n")
  const at = text.indexOf("```mermaid")
  const close = text.indexOf("```", at + 3)
  assert.deepEqual(
    mermaidParts(text),
    [
      { kind: "text", at: 0, text: "Before.\n\n" },
      { kind: "mermaid", at, source: "graph TD\n  A --> B" },
      { kind: "text", at: close + 3, text: "\n\nAfter." },
    ],
    "each part at its own offset, and the source is the body alone",
  )
  tiles(text, mermaidParts(text))
})

test("a text that is only a closed fence is one diagram part", () => {
  const text = "```mermaid\ngraph TD\n```"
  assert.deepEqual(
    mermaidParts(text),
    [{ kind: "mermaid", at: 0, source: "graph TD" }],
    "no empty text on either side",
  )
})

test("only a fence whose info string is exactly mermaid draws", () => {
  for (const info of [
    "mermaid extra",
    "Mermaid",
    "MERMAID",
    " mermaid",
    "mermaid ",
    "mermaid\t",
    "mermaidx",
    "mermaid-js",
  ]) {
    const text = ["```" + info, "graph TD", "```"].join("\n")
    assert.deepEqual(mermaidParts(text), asText(text), `${JSON.stringify(info)} is not mermaid`)
  }
})

test("a fence that does not open in the first column stays text", () => {
  for (const indent of [" ", "  ", "    "]) {
    const text = [indent + "```mermaid", indent + "graph TD", indent + "```"].join("\n")
    assert.deepEqual(
      mermaidParts(text),
      asText(text),
      `a fence ${indent.length} space(s) in is markdown's code, not a diagram`,
    )
  }
})

test("a fence inside a list item stays text, and one back at the margin draws", () => {
  const inItem = ["- Steps:", "  ```mermaid", "  graph TD", "  ```"].join("\n")
  assert.deepEqual(mermaidParts(inItem), asText(inItem), "markdown draws that fence inside the item")

  const atMargin = ["- Steps:", "  one", "", "```mermaid", "graph TD", "```"].join("\n")
  const parts = mermaidParts(atMargin)
  assert.deepEqual(
    parts.map((part) => part.kind),
    ["text", "mermaid"],
    "the list stays text and the fence after it is the margin's",
  )
  assert.equal(parts[1].at, atMargin.indexOf("```mermaid"), "from its own fence")
  tiles(atMargin, parts)
})

test("a fence inside another fence stays text", () => {
  const inBackticks = ["```md", "```mermaid", "graph TD", "```"].join("\n")
  assert.deepEqual(
    mermaidParts(inBackticks),
    asText(inBackticks),
    "a text about fences keeps showing them as code",
  )

  const inTildes = ["~~~md", "```mermaid", "graph TD", "```", "~~~"].join("\n")
  assert.deepEqual(
    mermaidParts(inTildes),
    asText(inTildes),
    "a tilde fence holds a backtick one the same way",
  )
})

test("a fence that never closes leaves its tail as text", () => {
  const text = ["Before.", "", "```mermaid", "graph TD", "  A --> B"].join("\n")
  assert.deepEqual(mermaidParts(text), asText(text), "a reply still streaming draws no half diagram")
})

test("a closed fence draws and a later one that never closed does not", () => {
  const text = ["```mermaid", "graph TD", "```", "", "Then:", "", "```mermaid", "pie"].join("\n")
  const parts = mermaidParts(text)
  assert.deepEqual(
    parts.map((part) => part.kind),
    ["mermaid", "text"],
    "one drawing, then the stretch still arriving",
  )
  assert.equal(parts[1].text, "\n\nThen:\n\n```mermaid\npie", "the unclosed fence is the tail's")
  tiles(text, parts)
})

test("the parts tile a text holding several fences", () => {
  const text = [
    "One.",
    "",
    "```mermaid",
    "graph TD",
    "  A --> B",
    "```",
    "",
    "Two.",
    "",
    "```mermaid",
    "sequenceDiagram",
    "  A->>B: hi",
    "```",
    "",
    "Three.",
  ].join("\n")
  const parts = mermaidParts(text)
  assert.deepEqual(
    parts.map((part) => part.kind),
    ["text", "mermaid", "text", "mermaid", "text"],
    "text and diagrams alternating",
  )
  assert.deepEqual(
    parts.filter((part) => part.kind === "mermaid").map((part) => part.source),
    ["graph TD\n  A --> B", "sequenceDiagram\n  A->>B: hi"],
    "each diagram's own source, in order",
  )
  tiles(text, parts)
})

test("a CRLF text splits where its LF twin does", () => {
  const lf = ["Before.", "", "```mermaid", "graph TD", "  A --> B", "```", "", "After."].join("\n")
  const crlf = lf.replaceAll("\n", "\r\n")
  const twin = mermaidParts(lf)
  const parts = mermaidParts(crlf)
  const shape = (part) =>
    part.kind === "text"
      ? [part.kind, part.text.replaceAll("\r\n", "\n")]
      : [part.kind, part.source]
  assert.deepEqual(
    parts.map(shape),
    twin.map(shape),
    "the same parts, the same sources and words, less their line endings",
  )
  assert.deepEqual(
    parts.map((part) => part.at),
    twin.map((part) => part.at + lf.slice(0, part.at).split("\n").length - 1),
    "and the same ats, moved only by the \\r each line gained",
  )
  assert.ok(
    parts.every((part) => part.kind !== "mermaid" || !part.source.includes("\r")),
    "no source carries a \\r",
  )
  tiles(crlf, parts)
})

test("a text with no marker at all is answered as one part, without a line split", () => {
  const prose = ["A paragraph.", "", "```python", "print(1)", "```", "", "And more."].join("\n")
  assert.ok(!prose.includes("mermaid"), "the text holds no marker, though it holds a fence")
  assert.deepEqual(mermaidParts(prose), asText(prose), "so the whole text comes back as one part")
  assert.deepEqual(mermaidParts(""), [], "and an empty text is still no parts at all")
})

test("the rule touches nothing but the string", () => {
  const raw = readFileSync(new URL("../src/lib/mermaid-fences.ts", import.meta.url), "utf8")
  const source = raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
  const imports = [...source.matchAll(/^[ \t]*import\b[^\n]*$/gm)].map(([line]) => line.trim())
  assert.equal(imports.length, 1, "one import, and no other: a rule reached from the startup path")
  assert.match(imports[0], /from "\.\/fences\.ts"$/, "and it is the scanner beside it")
  assert.doesNotMatch(source, /\bimport\s*\(/, "and nothing is loaded on demand")
})
