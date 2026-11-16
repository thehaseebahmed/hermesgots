/**
 * The layout a bot's screens draw, by name: `flat` is a bot's chats in one list at the bot's own
 * address, and `recents` is the Recents sidebar those screens had before they became that list
 * (ADR 0136). Developer's switch chooses between them.
 *
 * The two are named rather than read as a stored boolean so that the day they change meaning is a
 * compile error at every reader instead of a silent inversion of the switch.
 *
 * `chatLayout` is the rule, over the settings row alone and no React, so anything that has to decide
 * a layout without a screen can ask it too; `useChatLayout` is the same rule kept live from the row.
 */
import { useLiveQuery } from "dexie-react-hooks"

import { getSettings, type Settings } from "@/lib/db"

export type ChatLayout = "flat" | "recents"

/** The stored switch's layout: on is `recents`, off — or no settings row — is `flat`. */
export function chatLayout(settings: Pick<Settings, "legacyChat"> | undefined): ChatLayout {
  return settings?.legacyChat ? "recents" : "flat"
}

/** `chatLayout`, kept live from the settings row. `undefined` until settings answer. */
export function useChatLayout(): ChatLayout | undefined {
  return useLiveQuery(async () => chatLayout(await getSettings()), [])
}
