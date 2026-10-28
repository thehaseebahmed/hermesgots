/** The rows, events and lists recorded from a real Hermes host under `src/chat-next/fixtures/`. */
import { readFileSync } from "node:fs"

/** A fixture's text. */
export const fixture = (name: string): string =>
  readFileSync(new URL(`../src/chat-next/fixtures/${name}`, import.meta.url), "utf8")

/** A JSON fixture, parsed. */
export const recorded = (name: string) => JSON.parse(fixture(name))

/** The loader for a family of fixtures that share a name prefix (`prefix.live.json`). */
export const family = (prefix: string) => (name: string) => recorded(`${prefix}.${name}`)

/** The events of a recorded `.sse` stream, in order. */
export const events = <T = { event: string }>(name: string): T[] =>
  fixture(name)
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)) as T)
