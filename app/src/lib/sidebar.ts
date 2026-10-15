import { useLiveQuery } from "dexie-react-hooks"

import { getSettings, saveSettings } from "@/lib/db"

/** Whether the sidebar is collapsed on this device, and a toggle that persists the choice. */
export function useSidebarCollapsed(): [boolean, () => void] {
  const collapsed = useLiveQuery(async () => (await getSettings()).sidebarCollapsed, []) ?? false
  return [collapsed, () => void saveSettings({ sidebarCollapsed: !collapsed })]
}
