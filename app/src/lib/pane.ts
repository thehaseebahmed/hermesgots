import { useLiveQuery } from "dexie-react-hooks"
import { matchPath, useLocation } from "react-router"

import { db } from "@/lib/db"
import { useXLarge } from "@/lib/media"

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

export interface MeetingsPane {
  /** A meeting (or the recorder) is open beside the list. */
  open: boolean
  /** The meeting open beside the list. */
  selected?: string
}

/**
 * From `xl` the Meetings list stays on screen as a pane to the left of the meeting, a topic or the
 * recorder it opened, the way a project stays beside its session.
 */
export function useMeetingsPane(): MeetingsPane | undefined {
  const large = useXLarge()
  const { pathname } = useLocation()
  if (!large) return undefined
  if (matchPath("/meetings", pathname)) return { open: false }
  if (matchPath("/meetings/record", pathname)) return { open: true }
  const id = matchPath("/meetings/:id/*", pathname)?.params.id
  return id ? { open: true, selected: id } : undefined
}
