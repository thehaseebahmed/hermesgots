import { useLiveQuery } from "dexie-react-hooks"

import { getSettings, saveAppearance, saveSettings } from "@/lib/db"
import type { SidebarLayoutRecord } from "@/lib/sidebar-layout"

/** Whether the sidebar is collapsed on this device, and a toggle that persists the choice. */
export function useSidebarCollapsed(): [boolean, () => void] {
  const collapsed = useLiveQuery(async () => (await getSettings()).sidebarCollapsed, []) ?? false
  return [collapsed, () => void saveSettings({ sidebarCollapsed: !collapsed })]
}

/**
 * The account's sidebar arrangement, live, and the write that changes it: `undefined` until settings
 * answer, which draws today's sidebar, since a record nobody wrote is today's list.
 *
 * The write is `saveAppearance`'s rather than `saveSettings`'s so the appearance clock moves with the
 * record and sync carries the arrangement to the account's other devices (a Decision: the layout is
 * one of the appearance fields). It answers the write's own promise, so a confirmation that writes
 * through it can close on the answer rather than on the press.
 */
export function useSidebarLayout(): [
  SidebarLayoutRecord | undefined,
  (layout: SidebarLayoutRecord) => Promise<void>,
] {
  const layout = useLiveQuery(async () => (await getSettings()).sidebarLayout, [])
  return [layout, (next) => saveAppearance({ sidebarLayout: next })]
}
