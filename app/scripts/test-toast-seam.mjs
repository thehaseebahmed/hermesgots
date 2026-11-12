/**
 * The guard ADR 0147 asks for: every toast asks `lib/tell`, and sonner is named by the toaster that
 * draws a web toast and by the seam above it, and nothing else in `src/`.
 *
 * It reads syntax rather than text, so the spellings a screen really reaches for are caught — a
 * static import, a side-effect one, an `export … from`, a literal `import()` or `require()`, and a
 * re-export through one of the two owners, whose export lists are pinned below.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import test from "node:test"
import ts from "typescript"

import { parsed, sourceFiles } from "./source-tree.mjs"

const SRC = resolve(import.meta.dirname, "../src")

const OWNERS = new Set(["components/ui/sonner.tsx", "lib/tell.ts"])

const SOURCE = /\.(ts|tsx|js|jsx|mjs|cjs)$/

/** The module a parsed file names. */
function modulesIn(path) {
  const file = parsed(path, SRC)
  const named = []
  const namedImport = (node) => {
    const clause = node.importClause
    // A type-only import names a shape and draws nothing, so the toaster's props may be imported
    // from sonner by a screen that never asks it for a toast.
    if (clause?.isTypeOnly) return false
    const names = clause?.namedBindings
    const allTypes = Boolean(
      names && ts.isNamedImports(names) && names.elements.every((one) => one.isTypeOnly),
    )
    return !(allTypes && !clause?.name)
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && namedImport(node)) {
      named.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier) {
      named.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const callee = node.expression
      const dynamic = callee.kind === ts.SyntaxKind.ImportKeyword
      const required = ts.isIdentifier(callee) && callee.text === "require"
      const argument = node.arguments[0]
      if (dynamic || required) {
        if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
          named.push(argument.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return named
}

/** The names a file exports, from its own `export` statements. */
function exportsOf(path) {
  const text = readFileSync(join(SRC, path), "utf8")
  const names = new Set()
  for (const [, one] of text.matchAll(
    /export\s+(?:type\s+|interface\s+)?(?:const|let|function|class|type|interface)\s+(\w+)/g,
  )) {
    names.add(one)
  }
  for (const [, list] of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const one of list.split(",")) {
      const name = one.trim().split(/\s+as\s+/).pop()
      if (name) names.add(name.trim())
    }
  }
  return [...names].sort()
}

test("only the toaster and the seam name sonner", () => {
  const offenders = sourceFiles(SRC, "", SOURCE)
    .filter((path) => !OWNERS.has(path))
    .filter((path) =>
      modulesIn(path).some((name) => name === "sonner" || name.startsWith("sonner/")),
    )
    .sort()

  assert.deepEqual(
    offenders,
    [],
    "these reach sonner themselves; ask lib/tell instead — tell.error, .info, .success or .note — " +
      "so a phone shows its own toast",
  )
})

test("the toaster hands out the toaster and nothing else", () => {
  assert.deepEqual(
    exportsOf("components/ui/sonner.tsx"),
    ["Toaster"],
    "a second export here could hand sonner's toast to a screen without naming sonner",
  )
})

test("the seam hands out the four words, its span and its tone", () => {
  assert.deepEqual(exportsOf("lib/tell.ts"), ["TELL_LONG_MS", "TellTone", "tell"])
})
