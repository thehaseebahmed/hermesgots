// Sidebar fold state is a per-device convenience: localStorage is enough, and it must
// never travel through account settings or sync.
export type SidebarStorage = Pick<Storage, "getItem" | "setItem">
type SidebarStorageSource = SidebarStorage | (() => SidebarStorage)

export const SIDEBAR_COLLAPSED_KEY = "memento:sidebar:collapsed"

function resolveStorage(source: SidebarStorageSource): SidebarStorage {
  return typeof source === "function" ? source() : source
}

/** True means the sidebar is folded away. Defaults to expanded (false). */
export function loadSidebarCollapsed(storage: SidebarStorageSource): boolean {
  try {
    return resolveStorage(storage).getItem(SIDEBAR_COLLAPSED_KEY) === "true"
  } catch {
    // Private mode or blocked storage: it just won't be remembered.
    return false
  }
}

/** Persist the fold choice; best-effort and device-local only. */
export function saveSidebarCollapsed(collapsed: boolean, storage: SidebarStorageSource): void {
  try {
    resolveStorage(storage).setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false")
  } catch {
    // Private mode or blocked storage: it just won't be remembered.
  }
}

/**
 * The sidebar's width: the collapsed rail is 68px everywhere, while expanded keeps the existing
 * 18rem at md and grows to 20rem from lg.
 */
export function sidebarWidth(collapsed: boolean, large: boolean): string {
  if (collapsed) return "68px"
  return large ? "20rem" : "18rem"
}

/**
 * Half the sidebar's width: the margin that keeps a toast centred on the main pane rather than the
 * window, at md and up where the sidebar is shown.
 */
export function toastMargin(collapsed: boolean, large: boolean): string {
  return `calc(${sidebarWidth(collapsed, large)} / 2)`
}
