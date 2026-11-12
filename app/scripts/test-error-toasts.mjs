/**
 * The guard ADR 0148 asks for: a toast says the app's own words, never a failure's.
 *
 * It reads a file as syntax and resolves the names that file gives the two seams: `tell` under any
 * local name it is imported as, aliased (`const say = tell`), or taken apart by destructuring
 * (`const { error: announce } = tell`); and `attempt` imported, aliased, or read through a namespace
 * import. A call to any of them is a toast, and a call to `attempt` whose answer goes nowhere — bare,
 * `void`ed, awaited as a statement, or wrapped in parentheses — is a failure lost.
 *
 * What it objects to is shape, default-deny: an argument may be a string literal, a template, a
 * `+`, `??`, `||` or `&&` built from those, a conditional whose branches are, a read from one of the
 * app's own tables (`REFUSED.microphone`), or a property named `message`, `say` or `said`. Anything
 * else — a call, any other read, an element — is a shape nobody has shown to be the app's words.
 *
 * What that leaves out of its reach, and what review still has to catch: a local that holds the
 * words under a plain name (`const why = failure.say; tell.error(why)`), the words carried by
 * anything but those three properties, a helper of the app's that says them itself (`toastIt(f)` —
 * it knows only these two seams), a tone chosen at runtime (`tell[tone](...)`), and a module that
 * re-exports `tell` under another name. It is a guard over the spellings a failure is spoken by
 * today, not a proof that none ever is.
 *
 * `error-toast-allowlist.json` names each place that keeps a failure's words: the file, the function
 * inside it, why it keeps them, and how many such calls it holds. An entry that no longer holds its
 * calls fails, so the list cannot rot, and the file states its own ceiling so allowing one more is a
 * visible edit.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import ts from "typescript"

import { TELL_TONES } from "../src/lib/tell-tones.ts"
import { parsed, parseSource, sourceFiles } from "./source-tree.mjs"

const SRC = resolve(import.meta.dirname, "../src")
const SOURCE = /\.(ts|tsx)$/

const allowlist = JSON.parse(
  readFileSync(join(import.meta.dirname, "error-toast-allowlist.json"), "utf8"),
)

/** Every tone the seam can say, read off the seam's own list so a fifth tone cannot be forgotten. */
const TONES = new Set(TELL_TONES)

/** Why a place is allowed to keep a failure's words. */
const REASONS = new Set([
  "screen-cannot-hold-it",
  "ends-elsewhere",
  "read-at-a-control",
  "not-yet-converted",
])

/**
 * The names this codebase gives a failure's own words, and the reads that carry them. `alone` is not
 * among them: it is the sentence a call would have said by itself, and the one thing `refuse` may
 * hand back for a toast (`lib/refusal.ts`).
 */
const FAILURE_NAMES = /^(error|err|failure|exception|caught|said|message)$/
const FAILURE_READS = new Set(["message", "say", "said"])

/** A read from a table the app wrote: `REFUSED.microphone`, `REFUSED[started.reason ?? ""]`. */
const TABLE = /^[A-Z][A-Z0-9_]*$/

const isFailureName = (name) => FAILURE_NAMES.test(name) || /Error$/.test(name)

/** A node with the parentheses the writer wrapped it in taken off. */
function unwrap(node) {
  let it = node
  while (it && ts.isParenthesizedExpression(it)) it = it.expression
  return it
}

/** The text a node names where it is a string: `w["attempt"]`. */
function stringOf(node) {
  const it = unwrap(node)
  return it && (ts.isStringLiteral(it) || ts.isNoSubstitutionTemplateLiteral(it)) ? it.text : undefined
}

/** Whether a node reads `name` off one of the namespace imports in `space`. */
function memberOf(node, space, name) {
  const it = unwrap(node)
  if (!it) return false
  if (ts.isPropertyAccessExpression(it) && ts.isIdentifier(it.expression))
    return space.has(it.expression.text) && it.name.text === name
  if (ts.isElementAccessExpression(it) && ts.isIdentifier(it.expression))
    return space.has(it.expression.text) && stringOf(it.argumentExpression) === name
  return false
}

/**
 * The names one file gives the seams: the toast seam under every local that holds it, the tones
 * taken off it, and the write seam under every local it is imported as, aliased to, or read through
 * a namespace as.
 */
function seams(file) {
  const found = { tell: new Set(), tone: new Map(), attempt: new Set(), space: new Set() }
  const visitImports = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text
      const bindings = node.importClause?.namedBindings
      if (/(^|\/)tell$/.test(from) && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements)
          if ((element.propertyName ?? element.name).text === "tell") found.tell.add(element.name.text)
      }
      if (/(^|\/)attempt$/.test(from) && bindings) {
        if (ts.isNamespaceImport(bindings)) found.space.add(bindings.name.text)
        else if (ts.isNamedImports(bindings)) {
          for (const element of bindings.elements)
            if ((element.propertyName ?? element.name).text === "attempt")
              found.attempt.add(element.name.text)
        }
      }
    }
    ts.forEachChild(node, visitImports)
  }
  visitImports(file)
  const visitAliases = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer)
      // `const { error: announce } = tell` names a tone the file can call on its own.
      if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(init) && found.tell.has(init.text)) {
        for (const element of node.name.elements) {
          const tone = element.propertyName ?? element.name
          if (ts.isIdentifier(element.name) && ts.isIdentifier(tone) && TONES.has(tone.text))
            found.tone.set(element.name.text, tone.text)
        }
      }
      if (ts.isIdentifier(node.name)) {
        if (ts.isIdentifier(init) && found.tell.has(init.text)) found.tell.add(node.name.text)
        if (ts.isIdentifier(init) && found.attempt.has(init.text)) found.attempt.add(node.name.text)
        if (memberOf(init, found.space, "attempt")) found.attempt.add(node.name.text)
      }
    }
    ts.forEachChild(node, visitAliases)
  }
  // An alias of an alias settles in a pass or two; the loop stops as soon as a pass names nothing.
  let size = -1
  while (size !== found.tell.size + found.tone.size + found.attempt.size) {
    size = found.tell.size + found.tone.size + found.attempt.size
    visitAliases(file)
  }
  return found
}

/** The tone a call's callee names, where the callee is one of the seam's own. */
function toneOf(callee, found) {
  const it = unwrap(callee)
  if (!it) return null
  if (ts.isIdentifier(it)) return found.tone.get(it.text) ?? null
  if (ts.isPropertyAccessExpression(it) && ts.isIdentifier(it.expression))
    return found.tell.has(it.expression.text) && TONES.has(it.name.text) ? it.name.text : null
  if (ts.isElementAccessExpression(it) && ts.isIdentifier(it.expression)) {
    const name = stringOf(it.argumentExpression)
    return found.tell.has(it.expression.text) && name && TONES.has(name) ? name : null
  }
  return null
}

/** Whether a call's callee is the write seam under whatever name this file gives it. */
function isAttempt(callee, found) {
  const it = unwrap(callee)
  if (!it) return false
  if (ts.isIdentifier(it)) return found.attempt.has(it.text)
  return memberOf(it, found.space, "attempt")
}

/**
 * Whether a call's answer goes nowhere: the call is the statement it stands in, `void`ed, or awaited
 * as one — with the parentheses the writer may have wrapped it in taken off on the way up.
 */
function dropped(node) {
  let it = node
  let parent = it.parent
  while (parent && ts.isParenthesizedExpression(parent)) {
    it = parent
    parent = it.parent
  }
  if (parent && ts.isAwaitExpression(parent)) {
    it = parent
    parent = it.parent
    while (parent && ts.isParenthesizedExpression(parent)) {
      it = parent
      parent = it.parent
    }
  }
  return Boolean(parent && (ts.isVoidExpression(parent) || ts.isExpressionStatement(parent)))
}

/** The name of the function a node is, where it declares one. */
function nameOf(node) {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  )
    return node.name.text
  const parent = node.parent
  if (
    (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
    parent &&
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name)
  )
    return parent.name.text
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name))
    return parent.name.text
  return undefined
}

const isFunction = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isFunctionExpression(node) ||
  ts.isArrowFunction(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isConstructorDeclaration(node)

/** Whether a node reads a failure's own words, as a sentence the red can print; else nothing. */
function because(node) {
  if (ts.isParenthesizedExpression(node)) return because(node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return undefined
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) {
      const why = because(span.expression)
      if (why) return why
    }
    return undefined
  }
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
    ].includes(node.operatorToken.kind)
  )
    return because(node.left) ?? because(node.right)
  if (ts.isConditionalExpression(node)) return because(node.whenTrue) ?? because(node.whenFalse)
  if (ts.isPropertyAccessExpression(node)) {
    if (FAILURE_READS.has(node.name.text)) return `a \`${node.getText()}\` read`
    if (TABLE.test(node.expression.getText())) return undefined
    return because(node.expression)
  }
  if (ts.isElementAccessExpression(node)) {
    if (TABLE.test(node.expression.getText())) return undefined
    return because(node.expression)
  }
  if (ts.isIdentifier(node))
    return isFailureName(node.text) ? `the caught binding \`${node.text}\`` : undefined
  if (ts.isCallExpression(node)) return `a call to \`${node.expression.getText()}\``
  return `a \`${node.getText()}\` expression`
}

/** Every place in these files that says a failure's words in a toast, or drops a write's answer. */
function scan(sources) {
  const told = []
  const droppedCall = []
  for (const { path, file } of sources) {
    const found = seams(file)
    const visit = (node, scope) => {
      const inner = (isFunction(node) && nameOf(node)) || scope
      if (ts.isCallExpression(node)) {
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (toneOf(node.expression, found)) {
          const why = because(node.arguments[0])
          if (why) told.push({ file: path, line, function: inner, why })
        } else if (isAttempt(node.expression, found) && dropped(node)) {
          droppedCall.push({ file: path, line, function: inner })
        }
      }
      ts.forEachChild(node, (child) => visit(child, inner))
    }
    visit(file, "")
  }
  return { told, dropped: droppedCall }
}

/** Every finding in the app, read once: a parse error throws here rather than passing silently. */
let everything
const findings = () =>
  (everything ??= scan(sourceFiles(SRC, "", SOURCE).map((path) => ({ path, file: parsed(path, SRC) }))))

/** One planted file, scanned as though it were the app's. */
const planted = (text, path = "planted.tsx") => scan([{ path, file: parseSource(text, path) }])

const place = (site) => `${site.file}:${site.line} in ${site.function || "the module"}`

test("a file that will not parse stops the guard, naming it", () => {
  const dir = mkdtempSync(join(tmpdir(), "gots-sources-"))
  writeFileSync(join(dir, "broken.tsx"), "export const = 1\n")
  assert.throws(
    () => sourceFiles(dir, "", /\.tsx$/).map((path) => parsed(path, dir)),
    /broken\.tsx:\d+:\d+ could not be parsed/,
    "a file a guard could not read is a file it must not pass",
  )
})

test("a toast says the app's own words and never a failure's", () => {
  const left = []
  for (const site of findings().told) {
    const entry = allowlist.entries.find(
      (one) => one.file === site.file && one.function === site.function,
    )
    if (!entry) left.push(site)
  }
  assert.deepEqual(
    left.map((site) => `${place(site)} — ${site.why}`),
    [],
    "these build a toast from a failure's own words: draw them in the surface that holds the " +
      "control (`Refusal`), or add the place to scripts/error-toast-allowlist.json with a reason",
  )
})

test("the allowlist holds only what is still there, and no more than its ceiling", () => {
  const { told } = findings()
  for (const entry of allowlist.entries) {
    assert.ok(REASONS.has(entry.reason), `${entry.file}'s entry names a known reason`)
    const here = told.filter(
      (site) => site.file === entry.file && site.function === entry.function,
    ).length
    assert.equal(
      here,
      entry.calls ?? 1,
      `${entry.file} in ${entry.function} is allowed to keep ${entry.calls ?? 1} such call(s); ` +
        "an entry that no longer holds them is stale, and one that holds more was widened silently",
    )
  }
  assert.ok(
    allowlist.entries.length <= allowlist.ceiling,
    `the allowlist is at its ceiling of ${allowlist.ceiling}; raising it is its own edit`,
  )
  assert.equal(
    new Set(allowlist.entries.map((entry) => `${entry.file}:${entry.function}`)).size,
    allowlist.entries.length,
    "one entry per file and function",
  )
})

test("a write's answer is drawn, not dropped", () => {
  assert.deepEqual(
    findings().dropped.map((site) => place(site)),
    [],
    "these call `attempt` and throw its answer away: await it, and hand it to `refuse`",
  )
})

test("the write seam reaches no toast at all", () => {
  const file = parsed("lib/attempt.ts", SRC)
  const imports = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      imports.push(node.moduleSpecifier.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.deepEqual(
    imports.filter((name) => name === "sonner" || /(^|\/)tell$/.test(name)),
    [],
    "the seam names a toast: a failure a surface can draw is not one the app says in passing",
  )
  assert.deepEqual(
    scan([{ path: "lib/attempt.ts", file }]).told,
    [],
    "and it says nothing through the seam it is not allowed to name",
  )
})

test("the guard sees the seam under another name", () => {
  assert.equal(planted(`import { tell } from "@/lib/tell"\nconst say = tell\nexport const go = (error: Error) => say.error(error.message)`).told.length, 1)
})

test("the guard sees a tone taken off the seam", () => {
  assert.equal(planted(`import { tell } from "@/lib/tell"\nconst { error: announce } = tell\nexport const go = (error: Error) => announce(error.message)`).told.length, 1)
})

test("the guard sees a tone read off the seam by name", () => {
  assert.equal(planted(`import { tell } from "@/lib/tell"\nexport const go = (error: Error) => tell["error"](error.message)`).told.length, 1)
})

test("the guard sees the write seam read through a namespace", () => {
  assert.equal(
    planted(`import * as w from "@/lib/attempt"\nexport const go = () => { void w.attempt("save that", async () => {}) }`).dropped.length,
    1,
  )
})

test("the guard sees the write seam under another name", () => {
  assert.equal(
    planted(`import { attempt } from "@/lib/attempt"\nconst go = attempt\nexport const run = () => void go("save that", async () => {})`).dropped.length,
    1,
  )
})

test("the guard sees an answer dropped through parentheses", () => {
  assert.equal(
    planted(`import { attempt } from "@/lib/attempt"\nexport const run = async () => { void (await attempt("save that", async () => {})) }`).dropped.length,
    1,
  )
})

test("the guard reads the app's own words as its own", () => {
  assert.deepEqual(planted(`import { tell } from "@/lib/tell"\nexport const go = () => tell.success("Copied")`).told, [])
  assert.deepEqual(planted(`import { tell } from "@/lib/tell"\nexport const go = () => tell.error(REFUSED.microphone)`).told, [])
  assert.deepEqual(planted(`import { tell } from "@/lib/tell"\nexport const go = () => tell.error("Couldn't copy.")`).told, [])
})

test("a function of the file's own called attempt is none of the seam", () => {
  assert.deepEqual(
    planted(`const attempt = (what: string) => what\nexport const run = () => void attempt("x")`).dropped,
    [],
  )
})
