// `at` indexes into the string given to `openuiParts`, and the parts tile that string in order,
// with no gaps or overlaps.
import { fencedParts, type FencePolicy, type TextPart } from "./fences.ts"

export type OpenuiPart =
  TextPart | { kind: "openui"; at: number; source: string; id?: string; open: boolean }

type Block = Exclude<OpenuiPart, TextPart>

const ID = /^# id: ([a-z0-9-]{1,40})$/
export const INFO = "openui-lang"

function idOf(source: string) {
  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    if (trimmed) return ID.exec(trimmed)?.[1]
  }
  return undefined
}

/**
 * A reply's interface, read out of its text: a ```openui-lang fence whose body runs to a closing
 * fence, or to the end of a reply still streaming — the block it is drawn from and the `# id:` on its
 * first non-blank line when it carries one. The info string is compared exactly, so a space before or
 * after `openui-lang` leaves the fence as text, and a block inside another fence, or indented into a
 * list item, is an example of Lang and stays code.
 */
const BLOCK: FencePolicy<Block> = {
  info: INFO,
  stands: ({ inItem }) => !inItem,
  unclosed: "part",
  part: ({ at, source, open }) => {
    const id = idOf(source)
    return id ? { kind: "openui", at, source, id, open } : { kind: "openui", at, source, open }
  },
}

export function openuiParts(content: string): OpenuiPart[] {
  return fencedParts(content, BLOCK)
}

export function mayCarryBlock(content: string): boolean {
  return content.includes(INFO)
}

// A paste is often the fenced block a reply showed; the Lang inside it is what the reader means.
export function pastedBlock(content: string): string {
  const block = openuiParts(content).find((part) => part.kind === "openui")
  return block ? block.source : content.trim()
}

/** The source re-fenced as `openui-lang`: one backtick longer than its longest run, for Markdown. */
export function asLangFence(source: string) {
  let length = 3
  for (const run of source.match(/`+/g) ?? []) length = Math.max(length, run.length + 1)
  const fence = "`".repeat(length)
  return `${fence}${INFO}\n${source}\n${fence}`
}
