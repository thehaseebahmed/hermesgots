import { useLiveQuery } from "dexie-react-hooks"
import type { ReactNode } from "react"
import { Navigate } from "react-router"

import { getSettings } from "@/lib/db"

/**
 * A screen behind Developer's switch: nothing is drawn until this device's settings have been read,
 * since a live query answers `undefined` for the first frame and a redirect there would bounce the
 * visit that had just arrived. Whether a screen is also offered as a row is its own business; this
 * decides the door.
 */
export function DeveloperOnly({ children }: { children: ReactNode }) {
  const settings = useLiveQuery(getSettings, [])
  if (!settings) return null
  return settings.developer ? children : <Navigate to="/settings" replace />
}
