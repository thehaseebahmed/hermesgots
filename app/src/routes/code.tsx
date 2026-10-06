import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { MenuIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react"
import { Link } from "react-router"
import { toast } from "sonner"

import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { useOpenDrawer } from "@/components/drawer-context"
import { NewProjectPopup } from "@/components/new-project"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"
import { Spinner } from "@/components/ui/spinner"
import { listProfiles, type Profile } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { useWide } from "@/lib/media"
import {
  HermesError,
  listProjects,
  type HermesConfig,
  type HermesProject,
  type HermesProjectFolder,
} from "@/lib/hermes"

const REFRESH_MS = 60_000
const TOASTER = "code"
// Above the floating New project button: its bottom padding, its height and a gap.
const ABOVE_BUTTON = { bottom: "calc(max(1rem, env(safe-area-inset-bottom)) + 3.75rem)" }
const DAY_MS = 86_400_000

interface ProjectRow {
  key: string
  profile: Profile
  project: HermesProject
  at: number
}

interface Target extends HermesConfig {
  id: string
  /** The bot's Plugin setting is off. */
  pluginOff: boolean
}

type BotResult =
  | { profileId: string; projects: HermesProject[] }
  | { profileId: string; error: string; pluginMissing: boolean }

/** Bots that share a server see the same projects; the first bot keeps them. */
function serverKey(profile: Profile) {
  return profile.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

function toRows(results: BotResult[], profiles: Map<string, Profile>) {
  const rows = new Map<string, ProjectRow>()
  for (const result of results) {
    const profile = profiles.get(result.profileId)
    if (!profile || !("projects" in result)) continue
    for (const project of result.projects) {
      const key = `${serverKey(profile)}\n${project.id}`
      if (rows.has(key)) continue
      rows.set(key, { key, profile, project, at: project.lastActiveAt ?? project.createdAt })
    }
  }
  return [...rows.values()].sort((a, b) => b.at - a.at)
}

function describeError(error: unknown) {
  if (error instanceof HermesError) {
    if (error.status === 501) return "This Hermes version has no Projects."
    return error.message
  }
  return error instanceof Error ? error.message : "Couldn't load projects."
}

async function loadBot({ id: profileId, pluginOff, ...config }: Target): Promise<BotResult> {
  if (pluginOff) return { profileId, error: "The Memento plugin is off.", pluginMissing: true }
  try {
    return { profileId, projects: await listProjects(config) }
  } catch (reason) {
    // Hermes's 404 for an unknown route has no CORS headers, so a missing plugin can also fail with
    // no status at all.
    const pluginMissing = reason instanceof HermesError && (reason.status === 404 || !reason.status)
    return { profileId, error: describeError(reason), pluginMissing }
  }
}

/** Hermes Projects from every bot, most recently worked on first. */
export function CodePage() {
  const openDrawer = useOpenDrawer()
  const wide = useWide()
  const profiles = useLiveQuery(listProfiles, [])
  const [results, setResults] = useState<BotResult[]>()
  const [now, setNow] = useState(() => Date.now())
  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const refresh = useCallback(() => {
    setLoading(true)
    setTick((n) => n + 1)
  }, [])

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh()
    }, REFRESH_MS)
    const onVisible = () => document.visibilityState === "visible" && refresh()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [refresh])

  // Sync rewrites profile rows often; only a change to what's fetched should fetch again.
  const targetsKey = JSON.stringify(
    profiles?.map(({ id, baseUrl, apiKey, pluginChats }): Target => ({
      id,
      baseUrl,
      apiKey,
      pluginOff: pluginChats === false,
    })) ?? null,
  )

  useEffect(() => {
    const targets: Target[] | null = JSON.parse(targetsKey)
    if (!targets) return
    let cancelled = false
    Promise.all(targets.map(loadBot)).then((next) => {
      if (cancelled) return
      setResults(next)
      setNow(Date.now())
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [targetsKey, tick])

  const byId = new Map(profiles?.map((profile) => [profile.id, profile]))
  const rows = results ? toRows(results, byId) : []
  const failed = (results ?? []).flatMap((result) => {
    const profile = byId.get(result.profileId)
    return profile && "error" in result ? [{ ...result, profile }] : []
  })
  const missing = failed.filter((result) => result.pluginMissing)
  const unreachable = failed.filter((result) => !result.pluginMissing)
  const [dismissed, dismiss] = useDismissedBots()
  const unseen = missing.some((result) => !dismissed.has(result.profileId))
  const [creating, setCreating] = useState(false)
  const withPlugin = (results ?? []).flatMap((result) => {
    const profile = byId.get(result.profileId)
    return profile && "projects" in result ? [profile] : []
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full md:hidden"
            onClick={openDrawer}
            aria-label="Open conversations"
          >
            <MenuIcon />
          </Button>
          <h1 className="flex-1 text-xl font-semibold tracking-tight">Code</h1>
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full"
            onClick={refresh}
            disabled={loading}
            aria-label="Refresh"
          >
            {loading ? <Spinner /> : <RefreshCwIcon />}
          </Button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {unreachable.map(({ profile, error }) => (
          <Banner key={profile.id} tone="error">
            {profile.name}: {error}
          </Banner>
        ))}
        {unseen && (
          <PluginNotice
            names={missing.map((result) => result.profile.name)}
            onDismiss={() => dismiss(missing.map((result) => result.profileId))}
          />
        )}

        {!results ? (
          <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <Spinner className="size-4" /> Loading projects…
          </p>
        ) : rows.length > 0 ? (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li key={row.key}>
                <ProjectItem row={row} now={now} />
              </li>
            ))}
          </ul>
        ) : failed.length < results.length ? (
          <p className="px-1 text-sm text-muted-foreground">No projects yet.</p>
        ) : null}
      </div>

      {withPlugin.length > 0 && (
        <div className="pointer-events-none sticky bottom-0 mt-auto flex justify-end px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-2xl justify-end">
            <Button
              size="lg"
              className="pointer-events-auto h-12 rounded-full px-5 shadow-lg"
              onClick={() => setCreating(true)}
            >
              <PlusIcon /> New project
            </Button>
          </div>
        </div>
      )}
      {/* The app's toaster sits at the top, over this screen's header. */}
      <Toaster
        id={TOASTER}
        position={wide ? "bottom-center" : "bottom-right"}
        // Raised on tablets too: from 768px up to about 900px a centred toast reaches the button.
        offset={ABOVE_BUTTON}
        mobileOffset={ABOVE_BUTTON}
        // Centred on this screen rather than the window, past the sidebar (w-72, lg:w-80). Important,
        // as sonner's own unlayered styles zero the margin.
        className="toaster group md:ml-36! lg:ml-40!"
      />
      <NewProjectPopup
        open={creating}
        onOpenChange={setCreating}
        profiles={withPlugin}
        onCreated={(profile, name) => {
          toast.success(`Created ${name} on ${profile.name}`, { toasterId: TOASTER })
          refresh()
        }}
      />
    </div>
  )
}

const DISMISSED_KEY = "memento:code:plugin-notice"

/**
 * Bots whose missing plugin the user has already been told about; a bot missing it later brings the
 * notice back. A per-device convenience, so localStorage is enough.
 */
function useDismissedBots() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]")
      return new Set(Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [])
    } catch {
      return new Set<string>()
    }
  })
  const dismiss = useCallback((profileIds: string[]) => {
    setDismissed((current) => {
      const next = new Set([...current, ...profileIds])
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]))
      } catch {
        // Private mode or blocked storage: it just won't be remembered.
      }
      return next
    })
  }, [])
  return [dismissed, dismiss] as const
}

const names = new Intl.ListFormat(undefined, { type: "conjunction" })

function PluginNotice({ names: bots, onDismiss }: { names: string[]; onDismiss: () => void }) {
  return (
    <Banner
      action={
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-11 rounded-full"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <XIcon />
        </Button>
      }
    >
      Projects need the Memento plugin, installed on the bot's Hermes server and turned on in its
      settings. It's missing for {names.format(bots)}, so {bots.length === 1 ? "its" : "their"}{" "}
      projects aren't listed here.
    </Banner>
  )
}

/** A repo as `user/repo`; any other folder by its label or name, never its path. */
function folderName(folder: HermesProjectFolder) {
  return (
    folder.repo ?? folder.label ?? folder.path.split(/[\\/]/).filter(Boolean).at(-1) ?? folder.path
  )
}

/** The description, or else the project's git repos (its folders when none is a repo). */
function subtitle(project: HermesProject) {
  if (project.description) return project.description
  const repos = project.folders.filter((folder) => folder.git)
  return (repos.length ? repos : project.folders).map(folderName).join(", ")
}

function formatWhen(at: number, now: number) {
  if (now - at < DAY_MS) return formatRelative(at, now)
  return new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })
}

function ProjectItem({ row, now }: { row: ProjectRow; now: number }) {
  const { profile, project, at } = row
  const line2 = subtitle(project)
  return (
    <Link
      to={`/code/${profile.id}/${project.id}`}
      state={{ project }}
      className="-mx-2 flex min-h-16 items-center gap-4 rounded-2xl px-2 py-3 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted"
        title={profile.name}
      >
        <Bot id={profile.botId} className="size-8" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
          {at > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground">{formatWhen(at, now)}</span>
          )}
        </span>
        {line2 && <span className="block truncate text-sm text-muted-foreground">{line2}</span>}
      </span>
    </Link>
  )
}
