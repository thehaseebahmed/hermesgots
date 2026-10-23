import { useLiveQuery } from "dexie-react-hooks"
import { Navigate, useParams } from "react-router"

import { db, mainThreadId } from "@/lib/db"
import { useBotThreads } from "@/lib/threads"

export function BotThreadsPage() {
  const { profileId } = useParams()
  const enabled = useBotThreads()
  const profile = useLiveQuery(
    async () => (profileId ? ((await db.profiles.get(profileId)) ?? null) : null),
    [profileId],
  )
  if (enabled === undefined || profile === undefined) return null
  if (!enabled || profile === null) return <Navigate to="/" replace />
  return <Navigate to={`/c/${mainThreadId(profile.id)}`} replace />
}
