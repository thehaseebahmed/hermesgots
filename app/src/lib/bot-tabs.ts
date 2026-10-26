/**
 * A bot's settings pages, in list order: the URL's third segment is one of these, and every page —
 * General's included — carries its own. General leads and stands alone in the first card; every
 * other page follows in one card after it, since only the grouping is structural, not a heading.
 */

/** One page: the segment naming it, and what its row and its screen are called. */
export type BotPage = {
  segment: BotTab
  title: string
  subtitle: string
}

/** The pages in list order with the copy the list draws — the list's structure as data. */
export const BOT_PAGES = [
  {
    segment: "general",
    title: "General",
    subtitle: "Enabled, notifications, profile and your Hermes's address",
  },
  {
    segment: "models",
    title: "Models",
    subtitle: "Model, default model, triage model and fallback providers",
  },
  {
    segment: "coding",
    title: "Coding",
    subtitle: "Away From Keyboard and this bot's pick budget",
  },
  {
    segment: "speech-to-text",
    title: "Speech-to-text",
    subtitle: "Vocabulary, cleanup model and speech model",
  },
  {
    segment: "mcps",
    title: "MCP",
    subtitle: "The servers this bot works with",
  },
  {
    segment: "skills",
    title: "Skills",
    subtitle: "The skills this bot can use",
  },
] as const

/** The segment naming a page: the list names each one once. */
export type BotTab = (typeof BOT_PAGES)[number]["segment"]

/** The segments that named a page before the list, and the page that took each one's place. */
const OLD_TABS: Record<string, BotTab> = {
  chat: "models",
  dictation: "speech-to-text",
}

/** The page a URL's third segment names, old segments included, or nothing where it names none. */
export function botTabOf(segment: string | undefined): BotTab | undefined {
  if (!segment) return undefined
  return BOT_PAGES.find((page) => page.segment === segment)?.segment ?? OLD_TABS[segment]
}

/** The page a segment names: its title and subtitle, for a caller that has one. */
export function botPageOf(tab: BotTab): BotPage {
  return BOT_PAGES.find((page) => page.segment === tab) ?? BOT_PAGES[0]
}

/** A bot's own address: the list of its pages. */
export function botPath(botId: string): string {
  return `/settings/bots/${botId}`
}

/** A page's address: every page carries its own segment, General's included. */
export function botTabPath(botId: string, tab: BotTab): string {
  return `${botPath(botId)}/${tab}`
}
