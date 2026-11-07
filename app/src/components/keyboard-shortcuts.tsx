import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { DEFAULT_SETTINGS, getSettings, listEnabledProfiles, setActiveProfile } from "@/lib/db"
import { botShortcut, closesThread } from "@/lib/keys"
import { useNav } from "@/lib/nav"

/**
 * The keys the shell answers wherever the reader is: Escape putting the thread beside Main away —
 * the collapse chevron's twin — and Alt+1 to Alt+9 starting a new chat with the bot in that place,
 * while that switch is on. A key something else has already answered, or one a composition is
 * building, is that surface's, not the shell's.
 */
export function KeyboardShortcuts({ closeThread }: { closeThread?: () => void }) {
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
