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
    subtitle: "The model this bot's chats run",
  },
  {
    segment: "llm-providers",
    title: "LLM Providers",
    subtitle: "The API keys this bot's providers use",
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
  {
    segment: "notifications",
    title: "Notifications",
    subtitle: "The ntfy server, topic and token this bot publishes to",
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

/**
 * A bot's entry: its own address, which is a doorway rather than a screen. It lands on the bot's Main
 * chat, taking that chat's address in this entry's place, so a bot opens on the conversation it keeps
 * rather than on a list to choose from (an absent Main — a host that publishes none — leaves the
 * bot's list standing where this address is).
 */
export function botMainPath(botId: string): string {
  return `/b/${botId}`
}

/**
 * A bot's chats as a list: the screen its entry leads into, and the list a chat of the bot's leads
 * back to. Under the bot's root rather than an address of its own, since it is the bot the screen is
 * of. One definition, so the address the whole shell is built on cannot disagree with itself.
 */
export function botChatsPath(botId: string): string {
  return `${botMainPath(botId)}/sidechats`
}

/**
 * A bot's routines, which its list opens and its list is the way back from. Built from the bot's root
 * and never from the list's address: a routine's notification still opens it, and it is the bot's
 * rather than the list's.
 */
export function botRoutinesPath(botId: string): string {
  return `${botMainPath(botId)}/routines`
}

/** A page's address: every page carries its own segment, General's included. */
export function botTabPath(botId: string, tab: BotTab): string {
  return `${botPath(botId)}/${tab}`
}
