/**
 * The bot editor's screens, in tab order: the URL's third segment is one of these, and General's is
 * the bot's own address, so the others are the only ones that carry a segment. Coding is how the
 * bot works when it is left alone, after the servers it works with; Skills is last.
 */
export const BOT_TABS = ["general", "models", "dictation", "mcps", "coding", "skills"] as const

export type BotTab = (typeof BOT_TABS)[number]

/** The tab a URL's third segment names, or nothing where it names none this editor has. */
export function botTabOf(segment: string | undefined): BotTab | undefined {
  return BOT_TABS.find((tab) => tab === segment)
}

/** A tab's address: General is the bot itself, and every other tab carries its own segment. */
export function botTabPath(botId: string, tab: BotTab): string {
  return tab === "general" ? `/settings/bots/${botId}` : `/settings/bots/${botId}/${tab}`
}
