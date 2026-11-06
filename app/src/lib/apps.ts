import { useCallback, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { getActiveProfile, type Profile } from "@/lib/db"
import { changeOf, changePrompt, pagesOf, streamedSource } from "@/lib/app-build"
import {
  createApp,
  followRun,
  getAppPage,
  HermesError,
  listApps,
  markAppBuild,
  startRun,
  undoAppPage,
  writeAppPage,
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

/**
 * Runs a request in a session marked an app's, so the model is told the app's rules, and answers
 * the finished text. A run that ended any way but finished throws, naming what wasn't kept.
 */
async function runForApp(
  profile: Profile,
  content: string,
  unfinished: string,
  signal?: AbortSignal,
  onText?: (text: string) => void,
) {
  const sessionId = crypto.randomUUID()
  await markAppBuild(profile, sessionId)
  const runId = await startRun(profile, {
    sessionId,
    idempotencyKey: sessionId,
    messages: [{ role: "user", content }],
  })
  let streamed = ""
  const outcome = await followRun(
    profile,
    runId,
    { lastSeq: -1, signal },
    {
      onContent: (delta) => {
        streamed += delta
        onText?.(streamed)
      },
    },
  )
  if (outcome?.status !== "completed") throw new Error(outcome?.error ?? unfinished)
  return outcome.output ?? streamed
}

/**
 * Runs a build and answers the pages it came to, writing nothing. A run that ended any way but
 * finished, or whose answer isn't whole blocks, throws and leaves nothing behind.
 */
export async function buildPages(profile: Profile, prompt: string, signal?: AbortSignal) {
  const output = await runForApp(
    profile,
    `Build this app:\n\n${prompt.trim()}`,
    "The build didn't finish, so nothing was saved.",
    signal,
  )
  const built = pagesOf(output)
  if ("error" in built) throw new Error(`${built.error} Nothing was saved.`)
  return built.pages
}

/**
 * Asks for one page to be changed: sends its current source, streams the one block that comes back
 * to `onSource`, and only when the answer is whole, one block and parses is the page written. Any
 * other end throws and writes nothing, so the page stays as it was.
 */
export async function changePage(
  profile: Profile,
  appId: string,
  pageId: string,
  current: string,
  request: string,
  onSource: (source: string) => void,
  signal?: AbortSignal,
) {
  const output = await runForApp(
    profile,
    changePrompt(request, current),
    "The change didn't finish, so nothing was saved.",
    signal,
    (text) => {
      const source = streamedSource(text)
      if (source !== undefined) onSource(source)
    },
  )
  const changed = changeOf(output)
  if ("error" in changed) throw new Error(`${changed.error} Nothing was saved.`)
  const { blockProblem } = await import("@/components/openui/openui-block")
  const problem = blockProblem(changed.source)
  if (problem) throw new Error(`The change doesn't draw: ${problem} Nothing was saved.`)
  return writeAppPage(profile, appId, pageId, changed.source)
}

/** Writes the built pages as a new app and lists it, so it opens on its root page at once. */
export async function saveApp(profile: Profile, title: string, pages: string[]) {
  const app = await createApp(profile, title, pages)
  const kept = listed.get()
  const apps = kept?.profileId === profile.id ? (kept.apps ?? []) : []
  listed.set({ profileId: profile.id, apps: [app, ...apps.filter((one) => one.id !== app.id)] })
  return app
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
  const [draft, setDraft] = useState<string>()
  const change = useCallback(
    async (request: string, source: string, signal?: AbortSignal) => {
      if (!profile || !pageId) return
      try {
        const page = await changePage(profile, appId, pageId, source, request, setDraft, signal)
        setRead({ key, page })
      } finally {
        setDraft(undefined)
      }
    },
    [profile, appId, pageId, key],
  )
  return {
    page: current?.page,
    error: current?.error,
    missing: current?.missing,
    undo,
    change,
    draft,
  }
}
