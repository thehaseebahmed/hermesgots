import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { matchPath, useLocation } from "react-router"

import { db } from "@/lib/db"
import { useLarge, useXLarge } from "@/lib/media"
import { useSidebarCollapsed } from "@/lib/sidebar"

export interface ProjectPane {
  profileId: string
  projectId: string
  /** The session open beside the project. */
  session?: string
}

/**
 * From `xl` a project stays on screen while one of its sessions is open, as a pane to its left.
 * Links from the project pass it as `state.pane`, so the layout holds until the session loads.
 */
export function useProjectPane(): ProjectPane | undefined {
  const large = useXLarge()
  const { pathname, state } = useLocation()
  const project = matchPath("/code/:profileId/:projectId", pathname)?.params
  const chat = matchPath("/c/:id", pathname)?.params.id
  // Tagged with the id it's for, since a new id still sees the last answer for a moment.
  const read = useLiveQuery(
    async () => ({ chat, found: chat ? ((await db.conversations.get(chat)) ?? null) : null }),
    [chat],
  )
  const hint = (state as { pane?: Omit<ProjectPane, "session"> } | null)?.pane

  let pane: ProjectPane | undefined
  if (project?.profileId && project.projectId)
    pane = { profileId: project.profileId, projectId: project.projectId }
  else if (chat) {
    const found = read?.chat === chat ? read.found : undefined
    if (found?.projectId)
      pane = { profileId: found.profileId, projectId: found.projectId, session: chat }
    else if (found === undefined) {
      // Still loading: go by what the link said.
      if (hint) pane = { profileId: hint.profileId, projectId: hint.projectId, session: chat }
    }
  }
  return large ? pane : undefined
}

/**
 * Whether a list and what it opened fit side by side: the list pane is 412px and the item needs
 * about 520px more, so that's 1024px with the sidebar as a rail (a tablet in landscape) and 1280px
 * with it open (a laptop, where the sidebar is the third pane).
 */
export function useSplit() {
  const [collapsed] = useSidebarCollapsed()
  const large = useLarge()
  const xlarge = useXLarge()
  return collapsed ? large : xlarge
}

export interface FeaturePane {
  /** Something is open beside the list. */
  open: boolean
  /** The item open beside the list. */
  selected?: string
}

/**
 * Where there's room (`useSplit`), a feature's list stays on screen as a pane to the left of the
 * item it opened, the way a project stays beside its session: two panes on a tablet with the
 * sidebar as a rail, three with the sidebar open on a laptop. The feature's own screen is then the
 * item pane, never empty: the item opened last, else the top one, else a way to make one.
 */
function useFeaturePane(base: string): FeaturePane | undefined {
  const split = useSplit()
  const { pathname } = useLocation()
  if (!split) return undefined
  if (matchPath(base, pathname)) return { open: true }
  const id = matchPath(`${base}/:id/*`, pathname)?.params.id
  return id ? { open: true, selected: id } : undefined
}

export const useMeetingsPane = () => useFeaturePane("/meetings")
export const useResearchPane = () => useFeaturePane("/research")

/** The features whose item pane opens on the one opened last, per device. */
type Feature = "meetings" | "research"

const lastKey = (feature: Feature) => `memento:last-${feature}`

/** Notes the item open in a feature, for its pane to open again. */
export function useRememberOpened(feature: Feature, id: string | undefined) {
  useEffect(() => {
    if (!id) return
    try {
      localStorage.setItem(lastKey(feature), id)
    } catch {
      // Storage can be blocked; the top item is the fallback.
    }
  }, [feature, id])
}

/** Which of `ids` (top first) a feature's item pane opens: the one opened last, else the top one. */
export function itemToOpen(feature: Feature, ids: string[]) {
  let last: string | null = null
  try {
    last = localStorage.getItem(lastKey(feature))
  } catch {
    // As above.
  }
  return last && ids.includes(last) ? last : ids[0]
}
