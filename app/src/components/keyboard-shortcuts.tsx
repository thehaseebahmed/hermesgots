import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { DEFAULT_SETTINGS, getSettings, listEnabledProfiles, setActiveProfile } from "@/lib/db"
import { botShortcut, closesThread, reopensThread } from "@/lib/keys"
import { useNav } from "@/lib/nav"

/**
 * Whether the keyboard in front of the reader is a Mac's, whose reopen chord is ⌘\ rather than
 * Ctrl+\: the two are different keys, and each belongs to the device it is pressed on.
 */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * The keys the shell answers wherever the reader is: Escape putting the thread beside Main away —
 * the close cross's twin — ⌘\ (Ctrl+\ elsewhere) asking for the thread this bot's lane just
 * closed, and Alt+1 to Alt+9 starting a new chat with the bot in that place, while that switch is
 * on. A move is handed down only where the lane can make it, so a key with nothing behind it is no
 * key at all. A key something else has already answered, or one a composition is building, is that
 * surface's, not the shell's — and that is read once, before any of the three is tried.
 */
export function KeyboardShortcuts({
  closeThread,
  reopenThread,
}: {
  closeThread?: () => void
  reopenThread?: () => void
}) {
  const { root } = useNav()
  const on = useLiveQuery(
    async () => (await getSettings()).navShortcuts ?? DEFAULT_SETTINGS.navShortcuts,
    [],
  )
  useEffect(() => {
    const onKey = async (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      /** Whether the press was the move's: claimed before the next one is tried, so nothing stands in. */
      const take = (move: (() => void) | undefined, matches: () => boolean) => {
        if (!move || !matches()) return false
        event.preventDefault()
        move()
        return true
      }
      if (take(closeThread, () => closesThread(event))) return
      if (take(reopenThread, () => reopensThread(event, MAC))) return
      if (!on) return
      const index = botShortcut(event)
      if (index === null) return
      event.preventDefault()
      const bot = (await listEnabledProfiles())[index]
      if (!bot) return
      await setActiveProfile(bot.id)
      root("/")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [closeThread, reopenThread, on, root])
  return null
}
