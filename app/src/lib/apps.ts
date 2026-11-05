import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { getActiveProfile } from "@/lib/db"
import {
  getAppPage,
  listApps,
  undoAppPage,
  type HostApp,
  type HostAppPage,
} from "@/lib/hermes"
import { usePoll } from "@/lib/poll"

const LIST_MS = 30_000

const wordsOf = (error: unknown) =>
  error instanceof Error ? error.message : "Couldn't reach the bot."

/** The active bot's apps, newest first, read from its host and kept fresh while the screen is open. */
export function useApps() {
  const profile = useLiveQuery(async () => (await getActiveProfile()) ?? null, [])
  const [apps, setApps] = useState<HostApp[]>()
  const [error, setError] = useState<string>()
  usePoll(
    (signal) => {
      if (!profile) return
      listApps(profile, signal)
        .then((next) => {
          setApps(next)
          setError(undefined)
        })
        .catch((failure) => {
          if (signal.aborted) return
          setError(wordsOf(failure))
        })
    },
    LIST_MS,
    [profile?.id],
  )
  return { apps, error, loaded: profile !== undefined && (apps !== undefined || error !== undefined) }
}

/** One page of an app, from the host, and the undo that answers its last change. */
export function useAppPage(appId: string, pageId: string | undefined) {
  const profile = useLiveQuery(async () => (await getActiveProfile()) ?? null, [])
  const [read, setRead] = useState<{ key: string; page?: HostAppPage; error?: string; missing?: boolean }>()
  const key = `${appId}/${pageId ?? ""}`
  useEffect(() => {
    if (!profile || !pageId) return
    const controller = new AbortController()
    getAppPage(profile, appId, pageId, controller.signal)
      .then((page) => setRead({ key, page }))
      .catch((failure) => {
        if (controller.signal.aborted) return
        const missing = (failure as { status?: number }).status === 404
        setRead({ key, error: wordsOf(failure), missing })
      })
    return () => controller.abort()
  }, [profile, appId, pageId, key])
  const current = read?.key === key ? read : undefined
  const undo = useCallback(async () => {
    if (!profile || !pageId) return
    const page = await undoAppPage(profile, appId, pageId)
    setRead({ key, page })
  }, [profile, appId, pageId, key])
  return { page: current?.page, error: current?.error, missing: current?.missing, undo }
}
