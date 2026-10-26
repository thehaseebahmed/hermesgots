import type { BotTab } from "@/lib/bot-tabs"

/**
 * What a page's sub-screens are. An edit is a pushed screen below 1024px and a centred card from it;
 * a detail is a pushed screen below 1024px and the page pane from it (ADR 0055). A pick is neither —
 * it opens as a sheet below 1024px and a centred card from it, without an address of its own.
 */
export type SubKind = "edit" | "detail"

export type BotSub = {
  id: string
  kind: SubKind
  /** What the pushed screen and the card are titled. */
  title: string
}

/** The sub-screens whose ids the pages themselves name. */
const FIXED: Partial<Record<BotTab, BotSub[]>> = {
  general: [
    { id: "name", kind: "edit", title: "Name" },
    { id: "base-url", kind: "edit", title: "API base URL" },
    { id: "server-key", kind: "edit", title: "Server key" },
  ],
  models: [{ id: "fallbacks", kind: "detail", title: "Fallback providers" }],
  "speech-to-text": [{ id: "vocabulary", kind: "detail", title: "Vocabulary" }],
}

/** The pages whose sub-screens are named by an item they hold. */
const ITEM_PAGES: BotTab[] = ["mcps", "skills"]

/** The sub-screen a URL's fourth segment names, or nothing where the page has none by that name. */
export function botSubOf(tab: BotTab, segment: string | undefined): BotSub | undefined {
  if (!segment) return undefined
  const fixed = FIXED[tab]?.find((sub) => sub.id === segment)
  if (fixed) return fixed
  if (!ITEM_PAGES.includes(tab)) return undefined
  return { id: segment, kind: "detail", title: decode(segment) }
}

/** A page's own segment and a sub-screen's, as one address. */
export function botSubPath(botId: string, tab: BotTab, id: string): string {
  return `/settings/bots/${botId}/${tab}/${encodeURIComponent(id)}`
}

function decode(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
