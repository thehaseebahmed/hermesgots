// The plan's step 3: a component test that hands a found element to assert's equality makes Node
// build its failure by inspecting that element, and a mounted element carries React's fiber graph,
// so a red run walks the tree until the worker holds gigabytes. `scripts/test-rooms-list.tsx` was
// killed at 5 GB by one `assert.equal(find(…), null, …)`. The sweep answered presence with a
// boolean; this keeps the form out, since the next red one is the next 5 GB.
//
// The check is textual, and reads a call by walking its parentheses rather than by matching a
// line: a call may put its argument on the next line, and a selector is often a template literal
// holding a comma or a bracket.
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

const EQUALITY = ["equal", "strictEqual", "notEqual", "deepEqual"]
const IDENTIFIER = /[A-Za-z0-9_$]/

/** The index just past the line's newline, so a `//` comment is skipped whole. */
function afterLine(source, i) {
  const end = source.indexOf("\n", i)
  return end === -1 ? source.length : end + 1
}

/** The index just past the end of a block comment, so the stars it closes on are skipped whole. */
function afterBlock(source, i) {
  const end = source.indexOf("*/", i + 2)
  return end === -1 ? source.length : end + 2
}

/** The index just past the string or template literal opening at i, an interpolation walked whole. */
function afterString(source, i) {
  const quote = source[i]
  let j = i + 1
  while (j < source.length) {
    const ch = source[j]
    if (ch === "\\") {
      j += 2
    } else if (ch === quote) {
      return j + 1
    } else if (quote === "`" && ch === "$" && source[j + 1] === "{") {
      j = afterBraces(source, j + 2)
    } else {
      j++
    }
  }
  return j
}

/** The index just past the `}` closing an interpolation whose body starts at i. */
function afterBraces(source, i) {
  let depth = 1
  let j = i
  while (j < source.length && depth > 0) {
    const ch = source[j]
    if (ch === "\\") j += 2
    else if (ch === '"' || ch === "'" || ch === "`") j = afterString(source, j)
    else {
      if (ch === "{") depth++
      else if (ch === "}") depth--
      j++
    }
  }
  return j
}

/** Where a call opened at `(` closes, and where its first argument ends. */
function callSpan(source, open) {
  let depth = 0
  let comma = -1
  let j = open
  while (j < source.length) {
    const ch = source[j]
    if (ch === "/" && source[j + 1] === "/") {
      j = afterLine(source, j)
      continue
    }
    if (ch === "/" && source[j + 1] === "*") {
      j = afterBlock(source, j)
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      j = afterString(source, j)
      continue
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--
      if (depth === 0) return { close: j, comma }
    } else if (ch === "," && depth === 1 && comma === -1) {
      comma = j
    }
    j++
  }
  return null
}

/** Whether an argument is a `find(…)`/`findAll(…)` call and nothing read off what it answered. */
function isFoundElement(argument) {
  const call = /^(find|findAll)\s*\(/.exec(argument)
  if (!call) return false
  const span = callSpan(argument, argument.indexOf("(", call[0].length - 1))
  return span !== null && argument.slice(span.close + 1).trim() === ""
}

/** Every `assert.<equality>(…)` whose first argument is a bare `find(…)` or `findAll(…)`. */
export function offendersIn(source) {
  const sites = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === "/" && source[i + 1] === "/") {
      i = afterLine(source, i)
      continue
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = afterBlock(source, i)
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = afterString(source, i)
      continue
    }
    const name = IDENTIFIER.test(source[i - 1] ?? "")
      ? undefined
      : EQUALITY.find((one) => source.startsWith(`assert.${one}(`, i))
    if (name === undefined) {
      i++
      continue
    }
    const open = i + `assert.${name}`.length
    const span = callSpan(source, open)
    if (span === null) break
    if (span.comma !== -1) {
      const argument = source.slice(open + 1, span.comma).trim()
      if (isFoundElement(argument)) {
        sites.push({ line: source.slice(0, i).split("\n").length, argument })
      }
    }
    i = span.close + 1
  }
  return sites
}

const FLAGGED = {
  "the single-line form": 'assert.equal(find(sel), null, "nothing drew")',
  "a multi-line call whose selector is a template literal": [
    "assert.equal(",
    '  find(`[data-row="${id}"]`),',
    "  null,",
    '  "the row went",',
    ")",
  ].join("\n"),
  "a list handed to deepEqual": "assert.deepEqual(findAll(sel), [])",
}

const ALLOWED = {
  "a property read": 'assert.equal(find(sel)?.textContent, "3", "the count")',
  "a count": "assert.equal(findAll(sel).length, 0)",
  "a presence boolean": 'assert.ok(missing(sel), "nothing there")',
  "the harness's own absence": 'absent(sel, "the row")',
  "a comment quoting the form": '// assert.equal(find(sel), null, "not a call")',
}

function componentTests() {
  return readdirSync(import.meta.dirname).filter((name) => /^test-.*\.tsx$/.test(name))
}

test("no component test hands a found element to assert's equality", () => {
  const files = componentTests()
  assert.ok(files.length > 0, "the component tests were read")
  const named = []
  for (const name of files) {
    const source = readFileSync(join(import.meta.dirname, name), "utf8")
    for (const site of offendersIn(source)) named.push(`${name}:${site.line} ${site.argument}`)
  }
  assert.deepEqual(
    named,
    [],
    `a found element makes assert inspect it until the worker runs out of memory; ask missing() for a boolean:\n${named.join("\n")}`,
  )
})

test("the checker names every form a component test can write", () => {
  for (const [what, source] of Object.entries(FLAGGED)) {
    const sites = offendersIn(source)
    assert.equal(sites.length, 1, `${what} is named once`)
    assert.match(sites[0].argument, /^(find|findAll)\(/, `${what} names the argument it found`)
    assert.equal(sites[0].line, 1, `${what} is named where its assertion starts`)
  }
})

test("the checker leaves a property read, a boolean and a comment alone", () => {
  for (const [what, source] of Object.entries(ALLOWED)) {
    assert.deepEqual(offendersIn(source), [], `${what} is not an offender`)
  }
})
