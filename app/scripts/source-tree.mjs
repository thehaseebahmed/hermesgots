/**
 * The app's sources as rules read them: the walk over `src`, and a file parsed into a tree.
 *
 * A guard that reads code reads it as syntax, so a file that will not parse is a file it cannot
 * judge — and one it would otherwise pass silently, since a tree with no calls in it has no call to
 * object to. `parseSource` answers the tree or throws with the place the parser stopped, so no gate
 * can be quietly satisfied by a file it never read.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

const asPath = (dir) => (dir instanceof URL ? fileURLToPath(dir) : dir)

/** Every file under a directory, as a path relative to it. */
export function sourceFiles(dir, prefix = "", pattern = /\.(ts|tsx)$/) {
  const found = []
  for (const entry of readdirSync(asPath(dir), { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`
    if (entry.isDirectory()) found.push(...sourceFiles(join(asPath(dir), entry.name), `${path}/`, pattern))
    else if (pattern.test(entry.name)) found.push(path)
  }
  return found
}

/** The dialect a file is written in: a `.tsx` file's `<T>` is an element, and a `.ts` file's is a type. */
const kindOf = (name) => (/\.(tsx|jsx)$/.test(name) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

/** A source text as a tree, or the parse error that stopped it, named where it sits. */
export function parseSource(source, name) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, kindOf(name))
  const errors = file.parseDiagnostics ?? []
  if (errors.length > 0) {
    const [error] = errors
    const { line, character } = file.getLineAndCharacterOfPosition(error.start ?? 0)
    const why = ts.flattenDiagnosticMessageText(error.messageText, " ")
    throw new Error(`${name}:${line + 1}:${character + 1} could not be parsed: ${why}`)
  }
  return file
}

/** The file at `path`, under `root`, as a tree. */
export function parsed(path, root) {
  return parseSource(readFileSync(join(asPath(root), path), "utf8"), path)
}
