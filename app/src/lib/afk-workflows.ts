import { useLiveQuery } from "dexie-react-hooks"

import { getSettings } from "@/lib/db"

/**
 * Whether AFK Workflows is on: the device's own switch under Developer, which the plugin has no
 * part in. Everything the switch holds back reads it here, so none of it can drift from another.
 */
export function useAfkWorkflowsOn() {
  return Boolean(
    useLiveQuery(async () => {
      const settings = await getSettings()
      return Boolean(settings.developer && settings.afkWorkflows)
    }, []),
  )
}
