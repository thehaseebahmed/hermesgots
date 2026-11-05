/**
 * Why an app cannot be built on a bot, decided before any run starts. The screen puts this reason
 * on the build's control rather than starting a run a host cannot answer (ADR 0101): a host whose
 * plugin predates the app's section advertises no `apps` feature, and that reads as "this bot
 * cannot make apps" rather than as a fault; a build also needs the Interfaces switch on, since the
 * rules the model would build by are the switch's own fact (`openui-switch.ts`). `unknown` is
 * deliberately no refusal on either count — a Host that was away is asked again rather than read as
 * a `no`, and a switch not read yet is not an off (features.ts).
 */
import type { PluginFeatureAnswer } from "@/lib/features"
import { openuiParts } from "./openui-block.ts"

/** Why a build cannot start on this bot, if it can't. */
export function buildBlocked(
  apps: PluginFeatureAnswer,
  interfaces: boolean | undefined,
): string | undefined {
  if (apps === "no") return "This bot can't make apps"
  if (interfaces === false) return "Interfaces are turned off"
  return undefined
}

/** What a build's answer came to: the pages to write, or why there is nothing to write. */
export type BuiltPages = { pages: string[] } | { error: string }

/**
 * A finished build's blocks as the app's pages, in the order answered, the first the root. A block
 * still open when the answer ended means the answer broke off, and an answer with no block has
 * nothing to keep: either way nothing is written.
 */
export function pagesOf(output: string): BuiltPages {
  const blocks = openuiParts(output).filter((part) => part.kind === "openui")
  if (blocks.length === 0) return { error: "The bot didn't answer with an app." }
  if (blocks.some((block) => block.open)) return { error: "The bot's answer broke off." }
  return { pages: blocks.map((block) => block.source) }
}

/** What an app may call, read off its own pages: reads from queries, acts from mutations. */
export type Consent = { reads: string[]; acts: string[] }

const CALL = /\b(Query|Mutation)\(\s*"([^"\\]+)"/g

/** The tools a set of pages names, each once, sorted: the list the sheet asks the user to agree to. */
export function consentOf(pages: readonly string[]): Consent {
  const reads = new Set<string>()
  const acts = new Set<string>()
  for (const source of pages)
    for (const [, kind, tool] of source.matchAll(CALL)) (kind === "Query" ? reads : acts).add(tool)
  return { reads: [...reads].sort(), acts: [...acts].sort() }
}

const TITLE_CHARS = 60

/** An app's title from the words it was asked for: the first line, cut at a word where it runs long. */
export function titleOf(prompt: string): string {
  const line = prompt.trim().split("\n")[0].trim()
  if (line.length <= TITLE_CHARS) return line
  const cut = line.slice(0, TITLE_CHARS)
  const space = cut.lastIndexOf(" ")
  return `${space > 0 ? cut.slice(0, space) : cut}…`
}
