import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { resolveInterfaces } from "../src/lib/openui-thread.ts"

const block = (body, open = false) => ["```openui-lang", body, ...(open ? [] : ["```"])].join("\n")

const assistant = (id, content) => ({ id, role: "assistant", content })
const user = (id, content) => ({ id, role: "user", content })

test("two interfaces with different ids both draw as their own source", () => {
  const sales = '# id: sales\nroot = Stack([t])\nt = Card("a")'
  const team = '# id: team\nroot = Stack([u])\nu = Card("b")'
  const out = resolveInterfaces([assistant("r1", block(sales)), assistant("r2", block(team))])
  assert.deepEqual(
    out.get("r1"),
    [{ at: 0, draw: { kind: "interface", source: sales, id: "sales" } }],
    "the first draws its own source",
  )
  assert.deepEqual(
    out.get("r2"),
    [{ at: 0, draw: { kind: "interface", source: team, id: "team" } }],
    "and the second draws its own",
  )
})

test("a later block naming an earlier id resolves that interface to the merged source", () => {
  const sales = '# id: sales\nroot = Stack([t])\nt = Card("a")'
  const out = resolveInterfaces([
    assistant("r1", block(sales)),
    assistant("r2", block('# id: sales\nt = Card("b")')),
  ])
  assert.deepEqual(
    out.get("r1"),
    [
      {
        at: 0,
        draw: { kind: "interface", source: 'root = Stack([t])\nt = Card("b")', id: "sales" },
      },
    ],
    "the merged source exactly as the library returns it",
  )
  assert.deepEqual(
    out.get("r2"),
    [{ at: 0, draw: { kind: "patch", id: "sales" } }],
    "and the patch draws nothing of its own",
  )
})

test("a patch to the first of three interfaces changes that one alone", () => {
  const one = '# id: one\nroot = Stack([a])\na = Card("one")'
  const two = '# id: two\nroot = Stack([b])\nb = Card("two")'
  const three = '# id: three\nroot = Stack([c])\nc = Card("three")'
  const out = resolveInterfaces([
    assistant("r1", block(one)),
    assistant("r2", block(two)),
    assistant("r3", block(three)),
    assistant("r4", block('# id: one\na = Card("patched")')),
  ])
  assert.deepEqual(
    out.get("r1"),
    [
      {
        at: 0,
        draw: { kind: "interface", source: 'root = Stack([a])\na = Card("patched")', id: "one" },
      },
    ],
    "the patched interface carries the merge, exactly as the library returns it",
  )
  assert.deepEqual(
    out.get("r2"),
    [{ at: 0, draw: { kind: "interface", source: two, id: "two" } }],
    "the second is untouched",
  )
  assert.deepEqual(
    out.get("r3"),
    [{ at: 0, draw: { kind: "interface", source: three, id: "three" } }],
    "and the third is untouched",
  )
  assert.deepEqual(
    out.get("r4"),
    [{ at: 0, draw: { kind: "patch", id: "one" } }],
    "the patch names the one it changed",
  )
})

test("an id never seen earlier in the thread is reported as an orphan", () => {
  const out = resolveInterfaces([assistant("r1", block('# id: ghost\nt = Card("x")'))])
  assert.deepEqual(
    out.get("r1"),
    [{ at: 0, draw: { kind: "orphan", id: "ghost" } }],
    "a patch with nothing to patch is an orphan",
  )
})

test("a block that enters through the root component draws once the caller names it", () => {
  const content = block('# id: sales\nmain = Stack([t])\nt = Card("a")')
  assert.deepEqual(
    resolveInterfaces([assistant("r1", content)]).get("r1"),
    [{ at: 0, draw: { kind: "orphan", id: "sales" } }],
    "with no library to name the root component, no entry is found",
  )
  assert.deepEqual(
    resolveInterfaces([assistant("r1", content)], "Stack").get("r1"),
    [
      {
        at: 0,
        draw: {
          kind: "interface",
          source: '# id: sales\nmain = Stack([t])\nt = Card("a")',
          id: "sales",
        },
      },
    ],
    "and naming it, the block stands as an interface, the way the library reads it",
  )
})

test("ids that differ only by case are two interfaces", () => {
  const sales = '# id: sales\nroot = Stack([t])\nt = Card("a")'
  const capital = '# id: Sales\nroot = Stack([u])\nu = Card("b")'
  const out = resolveInterfaces([assistant("r1", block(sales)), assistant("r2", block(capital))])
  assert.deepEqual(
    out.get("r1"),
    [{ at: 0, draw: { kind: "interface", source: sales, id: "sales" } }],
    "the lowercase id claims an interface",
  )
  const [second] = out.get("r2")
  assert.equal(second.draw.kind, "interface", "and the capital S opens one of its own")
  assert.equal("id" in second.draw, false, "# id: Sales reads as no id at all")
  assert.equal(second.draw.source, capital, "drawing its own source")
})

test("a patch whose merge parses to nothing leaves the interface as it was", () => {
  const sales = '# id: sales\nroot = Stack([t])\nt = Card("a")'
  const out = resolveInterfaces([
    assistant("r1", block(sales)),
    assistant("r2", block("# id: sales\n%%% not lang %%%")),
    assistant("r3", block("# id: sales\n# just a comment")),
  ])
  assert.deepEqual(
    out.get("r1"),
    [{ at: 0, draw: { kind: "interface", source: sales, id: "sales" } }],
    "the interface is exactly as it was",
  )
  assert.deepEqual(
    out.get("r2"),
    [{ at: 0, draw: { kind: "patch", id: "sales" } }],
    "garbage still reads as a patch",
  )
  assert.deepEqual(
    out.get("r3"),
    [{ at: 0, draw: { kind: "patch", id: "sales" } }],
    "and so does a lone comment",
  )
})

test("a patch still streaming leaves the interface as it was until it closes", () => {
  const sales = '# id: sales\nroot = Stack([t])\nt = Card("a")'
  const out = resolveInterfaces([
    assistant("r1", block(sales)),
    assistant("r2", block('# id: sales\nt = Card("b")', true)),
  ])
  assert.deepEqual(
    out.get("r1"),
    [{ at: 0, draw: { kind: "interface", source: sales, id: "sales" } }],
    "nothing merged into the interface",
  )
  assert.deepEqual(
    out.get("r2"),
    [{ at: 0, draw: { kind: "patch", id: "sales" } }],
    "the open block draws nothing while it streams",
  )
})

test("an open block with no root yet opens its own interface rather than an orphan", () => {
  const writing = '# id: sales\nt = Card("a")'
  const out = resolveInterfaces([assistant("r1", block(writing, true))])
  assert.deepEqual(
    out.get("r1"),
    [{ at: 0, draw: { kind: "interface", source: writing, id: "sales" } }],
    "what the reply is writing is an interface",
  )
})

test("a block with no id opens an interface that a later id-less block never patches", () => {
  const first = 'root = Card("a")'
  const second = 'root = Card("b")'
  const content = [block(first), "", block(second)].join("\n")
  const out = resolveInterfaces([assistant("r1", content)])
  assert.deepEqual(
    out.get("r1"),
    [
      { at: 0, draw: { kind: "interface", source: first } },
      { at: content.lastIndexOf("```openui-lang"), draw: { kind: "interface", source: second } },
    ],
    "two interfaces, each its own source",
  )
})

test("a user row carrying a block is not read, and a row with no block has no entry", () => {
  const out = resolveInterfaces([
    user("u1", block('# id: sales\nroot = Card("a")')),
    assistant("r1", "Just an answer, nothing to draw."),
    assistant("r2", block('root = Card("b")')),
  ])
  assert.deepEqual([...out.keys()], ["r2"], "only the assistant row with a block is read")
  assert.deepEqual(
    out.get("r2"),
    [{ at: 0, draw: { kind: "interface", source: 'root = Card("b")' } }],
    "and its block draws",
  )
})

test("every draw's at is its block's own offset, and blocks come in thread order", () => {
  const first = '# id: a\nroot = Card("a")'
  const second = 'root = Card("b")'
  const third = '# id: c\nroot = Card("c")'
  const top = [block(first), "", "Between.", "", block(second)].join("\n")
  const at1 = top.indexOf("```openui-lang")
  const at2 = top.lastIndexOf("```openui-lang")
  const out = resolveInterfaces([assistant("r1", top), assistant("r2", block(third))])
  assert.deepEqual([...out.keys()], ["r1", "r2"], "rows in thread order")
  assert.deepEqual(
    out.get("r1").map((entry) => entry.at),
    [at1, at2],
    "each block at its own fence",
  )
  assert.equal(out.get("r2")[0].at, 0, "the last block at the start of its row")
  assert.ok(top.startsWith("```openui-lang", at1), "the first offset points at a fence")
  assert.ok(top.startsWith("```openui-lang", at2), "and so does the second")
  assert.deepEqual(
    out.get("r1").map((entry) => entry.draw.kind),
    ["interface", "interface"],
    "blocks read in the order the row carries them",
  )
})

test("folding the same thread twice answers the same thing, and the rows are untouched", () => {
  const rows = [
    assistant("r1", block('# id: sales\nroot = Stack([t])\nt = Card("a")')),
    assistant("r2", block('# id: sales\nt = Card("b")')),
    assistant("r3", block('# id: ghost\nt = Card("x")')),
  ]
  const before = JSON.parse(JSON.stringify(rows))
  const first = resolveInterfaces(rows)
  const second = resolveInterfaces(rows)
  assert.deepEqual(second, first, "the fold answers the same thing twice")
  assert.deepEqual(rows, before, "and the rows come back as they went in")
})

test("the fold reads nothing but the library and the extractor", () => {
  const raw = readFileSync(new URL("../src/lib/openui-thread.ts", import.meta.url), "utf8")
  const source = raw
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
    .replace(/^[ \t]*import\s+type\b[^\n]*\n?/gm, "")
  const froms = [...source.matchAll(/^[ \t]*(?:import|export)\b.*\bfrom\s*["']([^"']+)["']/gm)].map(
    (match) => match[1],
  )
  assert.deepEqual(
    [...new Set(froms)].sort(),
    ["./openui-block.ts", "@openuidev/lang-core"],
    "no module is reached but the library and the extractor",
  )
  assert.doesNotMatch(source, /\bimport\s*\(/, "and nothing is loaded on demand")
  for (const token of [
    "dexie",
    "indexeddb",
    "localstorage",
    "sessionstorage",
    "fetch",
    "xmlhttprequest",
  ]) {
    assert.ok(!source.toLowerCase().includes(token), `nothing here touches ${token}`)
  }
})
