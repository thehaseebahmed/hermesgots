/**
 * The guard ADR 0148 asks for: a toast says the app's own words, never a failure's.
 *
 * It reads syntax, the way `test-toast-seam.mjs` reads what a file may import, and it is default-deny:
 * a `tell.error`, `tell.success` or `tell.note` argument may only be a string literal, a template or
 * a `+` built from plain data, a read from one of the app's own tables (`REFUSED.microphone`), or a
 * conditional whose every branch is one of those. Anything else — a call, an element read, a read of
 * `.message` — is a shape nobody has shown to be the app's words.
 *
 * It also fails a write whose answer is dropped: `void attempt(...)` and a bare `attempt(...)` (or a
 * bare `await attempt(...)`) still compile, and lose the failure they were given. `attempt` is
 * recognised by the import, so a file's own helper of that name is none of its business.
 *
 * What it reads is shape, not flow: a local that holds the host's words and is renamed to something
 * plain is beyond it. That is why it is default-deny over shapes rather than a list of the spellings
 * that are refused today — the next spelling has to be taught to it, in review.
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

/** The local name a file imported `attempt` under, or `null` where it imported none. */
function attemptName(file) {
  let name = null
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /\/(lib\/)?attempt$/.test(node.moduleSpecifier.text)
    ) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          if ((element.propertyName ?? element.name).text === "attempt") name = element.name.text
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return name
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
  if (ts.isConditionalExpression(node))
    return because(node.whenTrue) ?? because(node.whenFalse)
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
    const seam = attemptName(file)
    const visit = (node, scope) => {
      const inner = (isFunction(node) && nameOf(node)) || scope
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          callee.expression.text === "tell" &&
          TONES.has(callee.name.text)
        ) {
          const why = because(node.arguments[0])
          if (why) told.push({ file: path, line, function: inner, why })
        }
        if (seam && ts.isIdentifier(callee) && callee.text === seam) {
          const parent = node.parent
          const statement =
            (ts.isVoidExpression(parent) && parent) ||
            (ts.isAwaitExpression(parent) && ts.isExpressionStatement(parent.parent) && parent.parent) ||
            (ts.isExpressionStatement(parent) && parent)
          if (statement) droppedCall.push({ file: path, line, function: inner })
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
