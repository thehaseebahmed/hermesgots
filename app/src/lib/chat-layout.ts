/**
 * The layout a bot's screens draw, by name: `sides` is the new UX — a bot opens on its **Main**, and
 * its other chats stand on a **Side Chat List** one press away — and `flat` is the single list of
 * every chat a bot has, with a routine's delivery among its rows (ADR 0162). Developer's switch
 * chooses between them, off being `sides`.
 *
 * The two are named rather than read as a stored boolean so that the day the switch changes which
 * layout it turns on is a compile error at every reader still comparing it, instead of a silent
 * inversion of the switch.
 *
 * `chatLayout` is the rule, over the settings row alone and no React, so anything that has to decide
 * a layout without a screen can ask it too; `useChatLayout` is the same rule kept live from the row.
 */
import { useLiveQuery } from "dexie-react-hooks"

import { getSettings, type Settings } from "@/lib/db"

export type ChatLayout = "sides" | "flat"

/** The stored switch's layout: on is `flat`, off — or no settings row — is `sides`. */
export function chatLayout(settings: Pick<Settings, "legacyChat"> | undefined): ChatLayout {
  return settings?.legacyChat ? "flat" : "sides"
}

/** `chatLayout`, kept live from the settings row. `undefined` until settings answer. */
export function useChatLayout(): ChatLayout | undefined {
  return useLiveQuery(async () => chatLayout(await getSettings()), [])
}
