// Sidebar fold state is a per-device convenience: localStorage is enough, and it must
// never travel through account settings or sync.
export type SidebarStorage = Pick<Storage, "getItem" | "setItem">

export const SIDEBAR_COLLAPSED_KEY = "memento:sidebar:collapsed"

/** True means the sidebar is folded away. Defaults to expanded (false). */
export function loadSidebarCollapsed(storage: SidebarStorage): boolean {
  try {
    return storage.getItem(SIDEBAR_COLLAPSED_KEY) === "true"
  } catch {
    // Private mode or blocked storage: it just won't be remembered.
    return false
  }
}

/** Persist the fold choice; best-effort and device-local only. */
export function saveSidebarCollapsed(collapsed: boolean, storage: SidebarStorage): void {
  try {
    storage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false")
  } catch {
    // Private mode or blocked storage: it just won't be remembered.
  }
}
