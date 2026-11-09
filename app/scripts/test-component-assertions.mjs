/**
 * The style gate over the component tier's assertions. What keeps a red assertion cheap is the shim
 * the loader maps both assert specifiers to (`assert-hooks.cjs`), which scrubs an element before Node
 * inspects it; this reads the spellings the suite writes, so the suite also reads as though the shim
 * were not there. An imported helper and an element bound to a variable are outside what a file can
 * be read for, and those are the shim's alone.
 */
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import ts from "typescript"

/** Assert's equality family: each builds its failure by inspecting both arguments. */
const EQUALITY = new Set([
  "equal",
  "strictEqual",
  "deepEqual",
  "deepStrictEqual",
  "notEqual",
  "notDeepEqual",
])

/** An expression that answers one side or the other, so an element on either side is an element. */
const FALLBACKS = new Set([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
])

const ELEMENT_FUNCTIONS = new Set([
  "find",
  "findAll",
  "findText",
  "labelled",
  "composerField",
  "threadCard",
])

const DOCUMENT_FUNCTIONS = new Set(["querySelector", "querySelectorAll"])

function unwrap(node) {
  let current = node
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression
    else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression
    else if (ts.isNonNullExpression(current)) current = current.expression
    else if (ts.isAwaitExpression(current)) current = current.expression
    else return current
  }
}

function calleeName(call) {
  const expression = call.expression
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    if (expression.expression.text !== "document") return null
    return DOCUMENT_FUNCTIONS.has(expression.name.text) ? `document.${expression.name.text}` : null
  }
  return null
}

function elementValued(expression, helpers) {
  const node = unwrap(expression)
  // `a ?? b`, `a || b`, `a && b`: the value is one side's, so an element on either side is the
  // assertion's. Any other operator builds a new value (a comparison, a string), never the element.
  if (ts.isBinaryExpression(node)) {
    if (!FALLBACKS.has(node.operatorToken.kind)) return false
    return elementValued(node.left, helpers) || elementValued(node.right, helpers)
  }
  if (!ts.isCallExpression(node)) return false
  const name = calleeName(node)
  if (name === null) return false
  return name.startsWith("document.") || ELEMENT_FUNCTIONS.has(name) || helpers.has(name)
}

function returnedExpressions(fn) {
  if (!fn.body) return []
  if (!ts.isBlock(fn.body)) return [fn.body]
  const returns = []
  const walk = (node) => {
    if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression)
    // A return inside a nested function belongs to that function, not this one.
    if (ts.isFunctionLike(node) && node !== fn) return
    ts.forEachChild(node, walk)
  }
  walk(fn.body)
  return returns
}

function definitions(sourceFile) {
  const found = new Map()
  const note = (name, fn) => {
    if (!name || !fn) return
    if (!found.has(name)) found.set(name, [])
    found.get(name).push(...returnedExpressions(fn))
  }
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      note(statement.name.text, statement)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        const init = unwrap(declaration.initializer)
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          note(declaration.name.text, init)
        }
      }
    }
  }
  return found
}

function elementHelpers(sourceFile) {
  const answers = definitions(sourceFile)
  const helpers = new Set()
  let changed = true
  while (changed) {
    changed = false
    for (const [name, returned] of answers) {
      if (helpers.has(name)) continue
      if (returned.length > 0 && returned.every((one) => elementValued(one, helpers))) {
        helpers.add(name)
        changed = true
      }
    }
  }
  return helpers
}

function assertionName(call) {
  const expression = call.expression
  if (!ts.isPropertyAccessExpression(expression)) return null
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== "assert") return null
  return EQUALITY.has(expression.name.text) ? expression.name.text : null
}

/** A file read as a tree, or the parse error that stopped it, named where it sits. */
function parsed(source, file) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const errors = sourceFile.parseDiagnostics ?? []
  if (errors.length > 0) {
    const [error] = errors
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(error.start ?? 0)
    const why = ts.flattenDiagnosticMessageText(error.messageText, " ")
    throw new Error(`${file}:${line + 1}:${character + 1} could not be parsed: ${why}`)
  }
  return sourceFile
}

/**
 * The words an `absentText` call looks for are a control's own label, which this suite writes as
 * capitalised copy. A sentence opening as its messages do — "and nothing else on the page is typed
 * into" — is the shape #992 is: it matches no control and passes over whatever is on screen. A
 * capitalised sentence is the one shape this cannot see, so the helper's own doc and its contract
 * test name the slot as well.
 */
function readsAsLabel(text) {
  return /^[A-Z]/.test(text.trim())
}

function sentencesInLabelSlot(source, file = "<source>") {
  const sourceFile = parsed(source, file)
  const sites = []
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "absentText" &&
      node.arguments.length > 1 &&
      ts.isStringLiteralLike(node.arguments[1]) &&
      !readsAsLabel(node.arguments[1].text)
    )
      sites.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        label: node.arguments[1].text,
      })
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return sites
}

function offendersIn(source, file = "<source>") {
  const sourceFile = parsed(source, file)
  const helpers = elementHelpers(sourceFile)
  const sites = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && assertionName(node) !== null) {
      // Both arguments are read: Node inspects the expected value as thoroughly as the actual one.
      const offending = node.arguments
        .slice(0, 2)
        .filter((argument) => elementValued(argument, helpers))
      if (offending.length > 0) {
        sites.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          argument: offending.map((argument) => argument.getText(sourceFile)).join(", "),
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
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
  "a list handed to deepStrictEqual": "assert.deepStrictEqual(findAll(sel), [])",
  "a list handed to notDeepEqual": "assert.notDeepEqual(findAll(sel), [])",
  "the strict spelling": 'assert.strictEqual(find(sel), null, "the row went")',
  "a text find": 'assert.equal(findText(sel, "Send"), null, "the button went")',
  "a labelled find": 'assert.equal(labelled(sel, "Close"), null, "the row went")',
  "the composer's field": "assert.equal(composerField(), null)",
  "a thread card": "assert.equal(threadCard(id), null)",
  "the document's single query": "assert.equal(document.querySelector(sel), null)",
  "the document's list query": "assert.notEqual(document.querySelectorAll(sel), 0)",
  "a local arrow that answers find":
    'const dialog = () => find(\'[role="alertdialog"]\')\nassert.equal(dialog(), null, "the dialog stays shut")',
  "a local arrow that answers a list":
    "const rows = () => findAll('[data-row]')\nassert.deepEqual(rows(), [], \"the rows went\")",
  "a local function declaration":
    'function marker() {\n  return find("[data-marker]")\n}\nassert.equal(marker(), null)',
  "a helper of a helper": [
    'const one = () => find("[data-one]")',
    "const two = () => one()",
    "assert.equal(two(), null)",
  ].join("\n"),
  "an element as the expected value": 'assert.equal(null, find(sel), "nothing drew")',
  "a list as the expected value": "assert.deepEqual([], findAll(sel))",
  "an element behind a nullish fallback": "assert.equal(find(one) ?? find(two), null)",
  "an element behind a logical fallback": "assert.equal(composerField() || null, null)",
}

const ALLOWED = {
  "a property read": 'assert.equal(find(sel)?.textContent, "3", "the count")',
  "a count": "assert.equal(findAll(sel).length, 0)",
  "a presence boolean": 'assert.ok(missing(sel), "nothing there")',
  "the harness's own absence": 'absent(sel, "the row went")',
  "the harness's text-filtered absence": 'absentText(sel, "Save to library")',
  "a comment quoting the form": '// assert.equal(find(sel), null, "not a call")',
  "a local helper that answers a property":
    'const marker = () => find("[data-marker]")\nconst markerText = () => marker()?.textContent ?? null\nassert.equal(markerText(), null)',
  "a value found before the assertion": 'const row = find(sel)\nassert.equal(row?.textContent, "3")',
  "a property behind a nullish fallback": "assert.equal(find(sel)?.textContent ?? null, null)",
  "a comparison of an element": 'assert.equal(find(sel) === null, true, "the row went")',
  "a second argument that is no element": 'assert.equal(1, 2, "one is not two")',
}

function componentTests() {
  return readdirSync(import.meta.dirname).filter((name) => /^test-.*\.tsx$/.test(name))
}

test("no component test hands a found element to assert's equality", () => {
  const dir = import.meta.dirname
  const files = componentTests()
  assert.ok(files.length > 0, "the component tests were read")
  const named = []
  for (const name of files) {
    const source = readFileSync(join(dir, name), "utf8")
    for (const site of offendersIn(source, join(dir, name))) named.push(`${name}:${site.line} ${site.argument}`)
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
    const line = source.slice(0, source.indexOf("assert.")).split("\n").length
    assert.equal(sites.length, 1, `${what} is named once`)
    assert.equal(sites[0].line, line, `${what} is named where its assertion starts`)
    assert.ok(sites[0].argument.length > 0, `${what} names the argument it found`)
  }
})

test("the checker leaves a property read, a boolean and a comment alone", () => {
  for (const [what, source] of Object.entries(ALLOWED)) {
    assert.deepEqual(offendersIn(source), [], `${what} is not an offender`)
  }
})

test("no component test hands absentText a sentence where a control's words belong", () => {
  const dir = import.meta.dirname
  const named = []
  for (const name of componentTests()) {
    const source = readFileSync(join(dir, name), "utf8")
    for (const site of sentencesInLabelSlot(source, join(dir, name)))
      named.push(`${name}:${site.line} ${site.label}`)
  }
  assert.deepEqual(
    named,
    [],
    `absentText looks for a control's own words, so its second argument is the label and never a failure sentence:\n${named.join("\n")}`,
  )
})

test("the label checker names a sentence and leaves a control's words alone", () => {
  assert.equal(
    sentencesInLabelSlot('absentText("button", "and nothing else on the page is typed into")').length,
    1,
    "a sentence opening as the suite's messages do is named",
  )
  assert.deepEqual(
    sentencesInLabelSlot('absentText("button", "Save to library")'),
    [],
    "a control's words are left alone",
  )
  assert.deepEqual(
    sentencesInLabelSlot('absentText("button", label)'),
    [],
    "a variable is outside what a file can be read for",
  )
})

test("a file the checker cannot parse fails, naming it", () => {
  assert.throws(
    () => offendersIn("const = ;", "scripts/test-broken.tsx"),
    /scripts\/test-broken\.tsx:\d+:\d+ could not be parsed/,
    "an unreadable file is a failure rather than a skip",
  )
})
