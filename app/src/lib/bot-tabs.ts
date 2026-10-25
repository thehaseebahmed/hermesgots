/**
 * A bot's settings pages, in list order: the URL's third segment is one of these, and every page —
 * General's included — carries its own. General leads and stands alone in the first card; every
 * other page follows in one card after it, since only the grouping is structural, not a heading.
 */
export const BOT_TABS = ["general", "models", "coding", "speech-to-text", "mcps", "skills"] as const

export type BotTab = (typeof BOT_TABS)[number]

/** Where a page's row sits: General alone in the first card, everything else in the card below. */
export type BotPageGroup = "general" | "rest"

/** One page: the segment naming it, what its row and its screen are called, and its group. */
export type BotPage = {
  segment: BotTab
  title: string
  subtitle: string
  group: BotPageGroup
}

/** The pages in list order with the copy the list draws — the list's structure as data. */
export const BOT_PAGES: BotPage[] = [
  {
    segment: "general",
    title: "General",
    subtitle: "Enabled, notifications, profile and your Hermes's address",
    group: "general",
  },
  {
    segment: "models",
    title: "Models",
    subtitle: "Model, default model, triage model and fallback providers",
    group: "rest",
  },
  {
    segment: "coding",
    title: "Coding",
    subtitle: "Away From Keyboard and this bot's pick budget",
    group: "rest",
  },
  {
    segment: "speech-to-text",
    title: "Speech-to-text",
    subtitle: "Vocabulary, cleanup model and speech model",
    group: "rest",
  },
  {
    segment: "mcps",
    title: "MCP",
    subtitle: "The servers this bot works with",
    group: "rest",
  },
  {
    segment: "skills",
    title: "Skills",
    subtitle: "The skills this bot can use",
    group: "rest",
  },
]

/** The segments that named a page before the list, and the page that took each one's place. */
const OLD_TABS: Record<string, BotTab> = {
  chat: "models",
  dictation: "speech-to-text",
}

/** The page a URL's third segment names, old segments included, or nothing where it names none. */
export function botTabOf(segment: string | undefined): BotTab | undefined {
  if (!segment) return undefined
  return BOT_TABS.find((tab) => tab === segment) ?? OLD_TABS[segment]
}

/** A segment that used to name a page: an address to land on the page that took its place. */
export function isOldTab(segment: string): boolean {
  return segment in OLD_TABS
}

/** The page a segment names: its title, subtitle and group, for a caller that has one. */
export function botPageOf(tab: BotTab): BotPage {
  return BOT_PAGES.find((page) => page.segment === tab) ?? BOT_PAGES[0]
}

/** A page's address: every page carries its own segment, General's included. */
export function botTabPath(botId: string, tab: BotTab): string {
  return `/settings/bots/${botId}/${tab}`
}
