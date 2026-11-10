import type { BotTab } from "@/lib/bot-tabs"
import { botTabPath } from "@/lib/bot-tabs"
import { fieldLabel } from "@/lib/general-settings"
import { customEndpointId } from "@/lib/llm-providers"
import { providerLabel, providerHasPage } from "@/lib/stt-settings"

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
   * Which of them have a page is the entry's own test (`SubEntry`), never another page's.
   */
  holds?: "items"
  /** The item this address names, where it names one of that list's. */
  item?: string
  /**
   * The field's own name, where the screen's title says what the screen does instead ("Edit Name"
   * over a field labelled *Name*). Left off, the field is labelled with the title.
   */
  label?: string
}

/**
 * An entry in the table: the sub-screen a segment names, and — where that sub-screen is a list whose
 * items each have a page of their own — the list's own test of one of them and the title that page
 * wears. A page that holds items states both, so no page can inherit another's idea of what it
 * holds: which names are pages is the list's to know, and a second such page says its own.
 */
type SubEntry =
  | (BotSub & { holds?: undefined })
  | (BotSub & {
      holds: "items"
      /** Whether this list has a page behind that name; one it doesn't hold names nothing. */
      hasPage: (name: string) => boolean
      /** What the page behind that name is titled. */
      titleOf: (name: string) => string
    })

/** The sub-screens whose ids the pages themselves name. */
const FIXED: Partial<Record<BotTab, SubEntry[]>> = {
  // The bot's own page: its profile, and how it connects to its Hermes.
  bot: [
    // The screen is named for what it does and the field for the setting it holds, so a form's
    // title and its label are never the same two words.
    { id: "name", kind: "edit", title: "Edit Name", label: "Name" },
    { id: "base-url", kind: "edit", title: "Edit API base URL", label: "API base URL" },
    { id: "server-key", kind: "edit", title: "Edit Server key", label: "Server key" },
  ],
  // General reads its rows from the host, so its edits are keyed below; the chain after the main
  // model is the one it holds a page of its own for.
  general: [{ id: "fallback_providers", kind: "detail", title: "Fallback providers" }],
  "speech-to-text": [
    { id: "vocabulary", kind: "detail", title: "Vocabulary" },
    // Every provider but local, and one page behind it for each the host declares (ADR 0063). This
    // page draws the rows, so it is the one that knows which are cards and which are screens.
    {
      id: "providers",
      kind: "detail",
      title: "Providers",
      holds: "items",
      hasPage: providerHasPage,
      titleOf: providerLabel,
    },
  ],
  // The LLM Providers page's rows are the host's catalog, which this table can't read: any slug is
  // an address, and the page says in its own words where the host lists no such provider. Every
  // slot's screen carries a verb — the screen names the provider itself once the block it reads has
  // landed, since a slug is not a name a reader knows.
  "llm-providers": [
    // The page's own `+`, which adds an endpoint: a fixed id, since it is no endpoint of the host's
    // and so has no slug to be named by. FIXED is matched before the page's items, so this can never
    // be mistaken for one.
    { id: "add", kind: "detail", title: "Add Custom Provider" },
    {
      id: "key",
      kind: "detail",
      title: "Edit Provider",
      holds: "items",
      hasPage: (name) => name.trim().length > 0,
      titleOf: (name) => (customEndpointId(name) ? "Edit Custom Provider" : "Edit Provider"),
    },
  ],
}

/** The pages whose sub-screens are named by an item they hold. */
const ITEM_PAGES: BotTab[] = ["mcps", "skills"]

/**
 * The pages whose edits are named by the host's own keys: General's rows come from the bot's Hermes,
 * so its edit ids are whatever that host spells, and the page titles the one it was asked for.
 */
const KEYED_PAGES: BotTab[] = ["general", "delegation"]

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
    // The list's own test of its leaves: a name this page doesn't hold names nothing, and the
    // address falls back as it did before.
    if (!fixed.hasPage(name)) return undefined
    return {
      id: fixed.id,
      kind: fixed.kind,
      title: fixed.titleOf(name),
      holds: "items",
      item: name,
    }
  }
  if (ITEM_PAGES.includes(tab)) return { id: segment, kind: "detail", title: decode(segment) }
  // A keyed page's edit is titled from the key itself, which is all a URL knows before the host has
  // answered: the page draws the row's own label once the block lands.
  if (KEYED_PAGES.includes(tab)) {
    const label = fieldLabel(decode(segment))
    // Every drill-in form says what it does; its field says which setting it holds.
    return { id: decode(segment), kind: "edit", title: `Edit ${label}`, label }
  }
  return undefined
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
