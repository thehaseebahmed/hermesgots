import { useCallback, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { getActiveProfile, type Profile } from "@/lib/db"
import {
  getAppPage,
  HermesError,
  listApps,
  undoAppPage,
  type HostApp,
  type HostAppPage,
} from "@/lib/hermes"
import { usePoll } from "@/lib/poll"
import { createStore } from "@/lib/store"

/** How often a screen holding apps reads them again, so a page written elsewhere draws. */
const LIST_MS = 30_000

type Listed = { profileId: string; apps?: HostApp[]; error?: string }

const listed = createStore<Listed | undefined>(undefined)
const reading = new Map<string, Promise<void>>()

/** The active bot: undefined until it is read, null where there is none. */
const useActiveProfile = () => useLiveQuery(async () => (await getActiveProfile()) ?? null, [])

const wordsOf = (error: unknown) =>
  error instanceof Error ? error.message : "Couldn't reach the bot."

/** Reads the bot's apps once however many screens ask at the same time. */
function refreshApps(profile: Profile) {
  const joined = reading.get(profile.id)
  if (joined) return joined
  const read = listApps(profile)
    .then((apps) => listed.set({ profileId: profile.id, apps }))
    .catch((failure) => {
      const kept = listed.get()
      const apps = kept?.profileId === profile.id ? kept.apps : undefined
      listed.set({ profileId: profile.id, apps, error: wordsOf(failure) })
    })
    .finally(() => reading.delete(profile.id))
  reading.set(profile.id, read)
  return read
}

/** The active bot's apps, newest first, read from its host and kept fresh while a screen holds them. */
export function useApps() {
  const profile = useActiveProfile()
  const state = listed.use()
  usePoll(() => profile && void refreshApps(profile), LIST_MS, [profile?.id])
  const mine = state && state.profileId === profile?.id ? state : undefined
  return { apps: mine?.apps, error: mine?.error, loaded: Boolean(mine) }
}

export function useAppPage(appId: string, pageId: string | undefined) {
  const profile = useActiveProfile()
  const key = `${appId}/${pageId ?? ""}`
  const [read, setRead] = useState<{
    key: string
    page?: HostAppPage
    error?: string
    missing?: boolean
  }>()
  usePoll(
    (signal) => {
      if (!profile || !pageId) return
      getAppPage(profile, appId, pageId, signal)
        .then((page) => setRead({ key, page }))
        .catch((failure) => {
          if (signal.aborted) return
          const missing = failure instanceof HermesError && failure.status === 404
          setRead({ key, error: wordsOf(failure), missing })
        })
    },
    LIST_MS,
    [profile?.id, appId, pageId],
  )
  const current = read?.key === key ? read : undefined
  const undo = useCallback(async () => {
    if (!profile || !pageId) return
    setRead({ key, page: await undoAppPage(profile, appId, pageId) })
  }, [profile, appId, pageId, key])
  return { page: current?.page, error: current?.error, missing: current?.missing, undo }
}
