import { useLiveQuery } from "dexie-react-hooks"
import type { ReactNode } from "react"
import { Navigate } from "react-router"

import { getSettings } from "@/lib/db"

/**
 * Whether this device turned Developer on, or `undefined` until its settings have been read. Every
 * reader of the switch needs that first frame to be a wait rather than an off: a row drawn there
 * would flicker in later, and a door decided there would bounce the visit that had just arrived.
 */
export function useDeveloper(): boolean | undefined {
  return useLiveQuery(getSettings, [])?.developer
}

/**
 * A screen behind Developer's switch: nothing is drawn until this device's settings have been read,
 * since a live query answers `undefined` for the first frame and a redirect there would bounce the
 * visit that had just arrived. Whether a screen is also offered as a row is its own business; this
 * decides the door.
 */
export function DeveloperOnly({ children }: { children: ReactNode }) {
  const developer = useDeveloper()
  if (developer === undefined) return null
  return developer ? children : <Navigate to="/settings" replace />
}
