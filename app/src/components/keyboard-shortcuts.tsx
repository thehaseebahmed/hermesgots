import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { DEFAULT_SETTINGS, getSettings, listEnabledProfiles, setActiveProfile } from "@/lib/db"
import { botShortcut } from "@/lib/keys"
import { useNav } from "@/lib/nav"

/** Alt+1 to Alt+9 start a new chat with the bot added in that place, while the switch is on. */
export function KeyboardShortcuts() {
  const { root } = useNav()
  const on = useLiveQuery(
    async () => (await getSettings()).navShortcuts ?? DEFAULT_SETTINGS.navShortcuts,
    [],
  )
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
