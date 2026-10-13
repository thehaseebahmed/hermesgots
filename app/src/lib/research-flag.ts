import { useLiveQuery } from "dexie-react-hooks"

import { getSettings } from "@/lib/db"

/**
 * Whether Research is on: experimental, so only behind the Developer switch. Apart from the
 * missions, so the sidebar can check it without loading the mock.
 */
export function useResearchEnabled() {
  return useLiveQuery(async () => {
    const settings = await getSettings()
    return Boolean(settings.developer && settings.research)
  }, [])
}
