/**
 * The push lib as text. Its wiring can't be driven from `node --test` — reading a phone's channels
 * needs Capacitor — so the wiring tests pin the source's own lines, while the rules it calls are
 * unit-tested (ADR 0019: the cheapest tier that fails for the reason the change can fail).
 */
import { readFileSync } from "node:fs"

const lib = new URL("../src/lib/", import.meta.url)

/** One of the lib's files, as text. */
export const read = (path) => readFileSync(new URL(path, lib), "utf8")

const push = read("push.ts")

/** A function of `push.ts`, from its signature to the brace that closes it at the file's margin. */
export const body = (name) =>
  push.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\)[\\s\\S]*?\\n\\}`))?.[0] ?? ""
