/**
 * The layout a bot's screens draw, as a leaf: Developer's switch chooses the legacy Recents sidebar
 * the app had before a bot's screen became the list of its chats (ADR 0120, superseded). Types
 * only, no React and no database, so anything that has to decide a layout without a screen can ask
 * it too; `useLegacyChat` is the live reading of the same answer.
 */
import { useLiveQuery } from "dexie-react-hooks"

import { getSettings, type Settings } from "@/lib/db"

export function legacyChatOn(settings: Pick<Settings, "legacyChat"> | undefined) {
  return Boolean(settings?.legacyChat)
}

/** `legacyChatOn`, kept live from the settings row. `undefined` until settings answer. */
export function useLegacyChat(): boolean | undefined {
  return useLiveQuery(async () => legacyChatOn(await getSettings()), [])
}
