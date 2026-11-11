import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { DEFAULT_SETTINGS, getSettings, listEnabledProfiles, setActiveProfile } from "@/lib/db"
import { botShortcut } from "@/lib/keys"
import { useNav } from "@/lib/nav"

/**
 * The keys the shell answers wherever the reader is: Alt+1 to Alt+9 start a new chat with the bot in
 * that place, while that switch is on. A key something else has already answered, or one a
 * composition is building, is that surface's, not the shell's — and that is read once, before the
 * bot switcher is tried.
 */
export function KeyboardShortcuts() {
  const { root } = useNav()
  const on = useLiveQuery(
    async () => (await getSettings()).navShortcuts ?? DEFAULT_SETTINGS.navShortcuts,
    [],
  )
  useEffect(() => {
    const onKey = async (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
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
  }, [on, root])
  return null
}
