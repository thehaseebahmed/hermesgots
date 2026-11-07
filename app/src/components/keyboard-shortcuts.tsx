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
 * the collapse chevron's twin — ⌘\ (Ctrl+\ elsewhere) asking for the thread this bot's lane just
 * closed, and Alt+1 to Alt+9 starting a new chat with the bot in that place, while that switch is
 * on. A move is handed down only where the lane can make it, so a key with nothing behind it is no
 * key at all. A key something else has already answered, or one a composition is building, is that
 * surface's, not the shell's.
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
    if (!closeThread) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (!closesThread(event)) return
      event.preventDefault()
      closeThread()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [closeThread])
  useEffect(() => {
    if (!reopenThread) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (!reopensThread(event, MAC)) return
      event.preventDefault()
      reopenThread()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [reopenThread])
  useEffect(() => {
    if (!on) return
    const onKey = async (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
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
  }, [on, root])
  return null
}
