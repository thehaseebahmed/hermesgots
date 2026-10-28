import type { BotTab } from "@/lib/bot-tabs"
import { botTabPath } from "@/lib/bot-tabs"
import { providerLabel } from "@/lib/stt-settings"

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
  /**
   * Whether the page lists things that each have a page of their own, so its address carries one
   * more segment than the page's own — the providers card's rows, and the page behind any one.
   */
  holds?: "items"
  /** The item this address names, where it names one of that list's. */
  item?: string
}

/** The sub-screens whose ids the pages themselves name. */
const FIXED: Partial<Record<BotTab, BotSub[]>> = {
  general: [
    { id: "name", kind: "edit", title: "Name" },
    { id: "base-url", kind: "edit", title: "API base URL" },
    { id: "server-key", kind: "edit", title: "Server key" },
  ],
  models: [{ id: "fallbacks", kind: "detail", title: "Fallback providers" }],
  "speech-to-text": [
    { id: "vocabulary", kind: "detail", title: "Vocabulary" },
    // Every provider but local, and one page behind it for each the host declares (ADR 0063).
    { id: "providers", kind: "detail", title: "Providers", holds: "items" },
  ],
}

/** The pages whose sub-screens are named by an item they hold. */
const ITEM_PAGES: BotTab[] = ["mcps", "skills"]

/**
 * The sub-screen a URL's fourth and fifth segments name, or nothing where the page has none by that
 * name. A fifth segment is only ever an item of a list, so a deeper address is that list's page for
 * an item rather than an unknown id. The list itself is no screen — its rows are drawn on the page
 * they belong to — so its bare address names nothing and the page draws.
 */
export function botSubOf(
  tab: BotTab,
  segment: string | undefined,
  leaf?: string,
): BotSub | undefined {
  if (!segment) return undefined
  const fixed = FIXED[tab]?.find((sub) => sub.id === segment)
  if (fixed) {
    if (fixed.holds !== "items") return fixed
    if (!leaf) return undefined
    const name = decode(leaf)
    return { ...fixed, title: providerLabel(name), item: name }
  }
  if (!ITEM_PAGES.includes(tab)) return undefined
  return { id: segment, kind: "detail", title: decode(segment) }
}

/**
 * A page's own segment, a sub-screen's, and — where that sub-screen is one of a list's items — the
 * item's: each escaped on its own, so an id that holds a slash stays one segment.
 */
export function botSubPath(botId: string, tab: BotTab, id: string, item?: string): string {
  const base = `${botTabPath(botId, tab)}/${encodeURIComponent(id)}`
  return item ? `${base}/${encodeURIComponent(item)}` : base
}

function decode(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
