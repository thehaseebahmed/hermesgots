import { useCallback, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { changeOf, changePrompt, pagesOf, streamedSource } from "@/lib/app-build"
import { connectionKey } from "@/lib/connection"
import { db, getActiveProfile, type Profile } from "@/lib/db"
import {
  createApp,
  followRun,
  getAppPage,
  HermesError,
  listApps,
  markAppBuild,
  queryApp,
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

type Listed = { profileId: string; apps?: HostApp[]; error?: string; offline?: boolean }

const listKey = (profile: Profile) => `${connectionKey(profile)}\napps`
const pageKey = (profile: Profile, appId: string, pageId: string) =>
  `${connectionKey(profile)}\n${appId}/${pageId}`

const warn = (what: string) => (failure: unknown) =>
  console.warn(`[memento] Couldn't ${what}:`, failure)

/** Keeps a page the host answered; a device whose storage refuses it still draws what it just read. */
const keepPage = (profile: Profile, appId: string, page: HostAppPage) =>
  void db.appCache
    .put({ key: pageKey(profile, appId, page.id), connection: connectionKey(profile), page })
    .catch(warn("cache the page"))

/**
 * Keeps the list the host answered, and drops the cached pages it no longer names, so an app or
 * page deleted on the host isn't drawn offline from this device's copy.
 */
const keepList = (profile: Profile, apps: HostApp[]) => {
  const connection = connectionKey(profile)
  const named = new Set([
    listKey(profile),
    ...apps.flatMap((app) => app.pages.map((page) => pageKey(profile, app.id, page))),
  ])
  void db
    .transaction("rw", db.appCache, async () => {
      await db.appCache.put({ key: listKey(profile), connection, apps })
      await db.appCache
        .where("connection")
        .equals(connection)
        .filter((row) => !named.has(row.key))
        .delete()
    })
    .catch(warn("cache the apps"))
}

const listed = createStore<Listed | undefined>(undefined)
const reading = new Map<string, Promise<void>>()

/** The active bot: undefined until it is read, null where there is none. */
export const useActiveProfile = () =>
  useLiveQuery(async () => (await getActiveProfile()) ?? null, [])

const wordsOf = (error: unknown) =>
  error instanceof Error ? error.message : "Couldn't reach the bot."

/** Reads the bot's apps once however many screens ask at the same time. */
function refreshApps(profile: Profile) {
  const joined = reading.get(profile.id)
  if (joined) return joined
  const read = listApps(profile)
    .then((apps) => {
      keepList(profile, apps)
      listed.set({ profileId: profile.id, apps })
    })
    .catch(async (failure) => {
      const kept = listed.get()
      const held = kept?.profileId === profile.id ? kept.apps : undefined
      const apps = held ?? (await db.appCache.get(listKey(profile)))?.apps
      listed.set({ profileId: profile.id, apps, error: wordsOf(failure), offline: Boolean(apps) })
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
  const next = [app, ...apps.filter((one) => one.id !== app.id)]
  keepList(profile, next)
  listed.set({ profileId: profile.id, apps: next })
  return app
}

/** The active bot's apps, newest first, read from its host and kept fresh while a screen holds them. */
export function useApps() {
  const profile = useActiveProfile()
  const state = listed.use()
  usePoll(() => profile && void refreshApps(profile), LIST_MS, [profile?.id])
  const mine = state && state.profileId === profile?.id ? state : undefined
  return { apps: mine?.apps, error: mine?.error, offline: mine?.offline, loaded: Boolean(mine) }
}

/**
 * The tools a page's `Query` calls, answered by the host's query route. A read the host refused or
 * failed answers `{ error }`, which the page draws; a host that cannot be reached throws, so the
 * page keeps the defaults it declared.
 */
export function appTools(profile: Profile, read: typeof queryApp = queryApp) {
  return {
    async callTool({
      name,
      arguments: args,
    }: {
      name: string
      arguments?: Record<string, unknown>
    }) {
      try {
        return { content: [], structuredContent: (await read(profile, name, args ?? {})) ?? null }
      } catch (failure) {
        if (failure instanceof HermesError && failure.status !== undefined)
          return { content: [], structuredContent: { error: failure.message } }
        throw failure
      }
    },
  }
}

export function useAppPage(appId: string, pageId: string | undefined) {
  const profile = useActiveProfile()
  const key = `${appId}/${pageId ?? ""}`
  const [read, setRead] = useState<{
    key: string
    page?: HostAppPage
    error?: string
    missing?: boolean
    offline?: boolean
  }>()
  usePoll(
    (signal) => {
      if (!profile || !pageId) return
      getAppPage(profile, appId, pageId, signal)
        .then((page) => {
          keepPage(profile, appId, page)
          setRead({ key, page })
        })
        .catch(async (failure) => {
          if (signal.aborted) return
          const missing = failure instanceof HermesError && failure.status === 404
          const cached = pageKey(profile, appId, pageId)
          if (missing) void db.appCache.delete(cached).catch(warn("forget the page"))
          const page = missing ? undefined : (await db.appCache.get(cached))?.page
          if (signal.aborted) return
          setRead({ key, page, offline: Boolean(page), error: wordsOf(failure), missing })
        })
    },
    LIST_MS,
    [profile?.id, appId, pageId],
  )
  const current = read?.key === key ? read : undefined
  const undo = useCallback(async () => {
    if (!profile || !pageId) return
    const page = await undoAppPage(profile, appId, pageId)
    keepPage(profile, appId, page)
    setRead({ key, page })
  }, [profile, appId, pageId, key])
  const [draft, setDraft] = useState<string>()
  const change = useCallback(
    async (request: string, source: string, signal?: AbortSignal) => {
      if (!profile || !pageId) return
      try {
        const page = await changePage(profile, appId, pageId, source, request, setDraft, signal)
        keepPage(profile, appId, page)
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
    offline: current?.offline,
    undo,
    change,
    draft,
  }
}
