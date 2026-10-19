/**
 * The bot editor's screens, in tab order: the URL's third segment is one of these, and General's is
 * the bot's own address, so the others are the only ones that carry a segment.
 */
export const BOT_TABS = ["general", "models", "mcps"] as const

export type BotTab = (typeof BOT_TABS)[number]
