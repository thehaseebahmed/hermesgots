/**
 * A bot's settings pages: the URL's third segment is one of these, and every page carries its own.
 * The bot's own page is the entry — its switches, its profile and how it connects, then one card of
 * every page under them — so it carries a segment of its own for its edits, and it is not a row in
 * its own card: the pages that card lists are the settings behind it.
 */

/** One page: the segment naming it, and what its row and its screen are called. */
export type BotPage = {
  segment: BotTab
  title: string
  /** What the page holds, for the row that opens it — the bot's own page is not a row, so it has none. */
  subtitle?: string
}

/** The pages in order with the copy the list draws — the list's structure as data. */
export const BOT_PAGES = [
  { segment: "bot", title: "Bot" },
  {
    segment: "general",
    title: "General",
    subtitle: "Model, limits, session timeouts and update settings",
  },
  {
    segment: "models",
    title: "Models",
    subtitle: "The model this bot's chats run and its triage model",
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
  {
    segment: "delegation",
    title: "Delegation",
    subtitle: "Subagent model, limits and approvals",
  },
] as const

/** The segment naming a page: the list names each one once. */
export type BotTab = (typeof BOT_PAGES)[number]["segment"]

/** The segments that named a page before the list, and the page that took each one's place. */
const OLD_TABS: Record<string, BotTab> = {
  chat: "models",
  dictation: "speech-to-text",
  // The page General held before its rows moved onto the bot's own page.
  "general-old": "bot",
}

/** The settings a bot's own page lists: every page but itself, in list order. */
export const SETTING_PAGES: readonly BotPage[] = BOT_PAGES.filter((page) => page.segment !== "bot")

/** The page a URL's third segment names, old segments included, or nothing where it names none. */
export function botTabOf(segment: string | undefined): BotTab | undefined {
  if (!segment) return undefined
  return BOT_PAGES.find((page) => page.segment === segment)?.segment ?? OLD_TABS[segment]
}

/** The page a segment names: its title and subtitle, for a caller that has one. */
export function botPageOf(tab: BotTab): BotPage {
  return BOT_PAGES.find((page) => page.segment === tab) ?? BOT_PAGES[0]
}

/** A bot's own address: its page, and the settings under it. */
export function botPath(botId: string): string {
  return `/settings/bots/${botId}`
}

/** A page's address: every page carries its own segment, General's included. */
export function botTabPath(botId: string, tab: BotTab): string {
  return `${botPath(botId)}/${tab}`
}
