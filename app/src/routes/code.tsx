import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ChevronUpIcon,
  FolderGit2Icon,
  FolderIcon,
  MenuIcon,
  PinIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { Link } from "react-router"
import { toast } from "sonner"

import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { useOpenDrawer } from "@/components/drawer-context"
import { NewProjectPopup } from "@/components/new-project"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { listEnabledProfiles, type Profile } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { SAFETY_MS, useAllLive, useAnyChange } from "@/lib/live"
import { readProjects } from "@/lib/projects"
import { usePoll } from "@/lib/poll"
import {
  HermesError,
  deleteProject,
  retryProject,
  type HermesConfig,
  type HermesProject,
} from "@/lib/hermes"
import { folderName } from "@/lib/workspace"

const REFRESH_MS = 60_000
// While a project is being cloned: the plugin does the work, this just watches for it to finish.
const CLONING_REFRESH_MS = 3_000
// Above the floating New project button: its bottom padding, its height and a gap.
const DAY_MS = 86_400_000

interface ProjectRow {
  key: string
  profile: Profile
  project: HermesProject
  at: number
}

interface Target extends HermesConfig {
  id: string
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
  // Pinned first, the most recently pinned on top.
  return [...rows.values()].sort(
    (a, b) => (b.project.pinnedAt ?? 0) - (a.project.pinnedAt ?? 0) || b.at - a.at,
  )
}

function describeError(error: unknown) {
  if (error instanceof HermesError) {
    if (error.status === 501) return "This Hermes version has no Projects."
    return error.message
  }
  return error instanceof Error ? error.message : "Couldn't load projects."
}

async function loadBot({ id: profileId, ...config }: Target): Promise<BotResult> {
  try {
    return { profileId, projects: await readProjects(config) }
  } catch (reason) {
    // Hermes's 404 for an unknown route has no CORS headers, so a missing plugin can also fail with
    // no status at all.
    const pluginMissing = reason instanceof HermesError && (reason.status === 404 || !reason.status)
    return { profileId, error: describeError(reason), pluginMissing }
  }
}

/** Hermes Projects from every bot, pinned ones and then the most recently worked on first. */
export function CodePage() {
  const openDrawer = useOpenDrawer()
  const profiles = useLiveQuery(listEnabledProfiles, [])
  const [results, setResults] = useState<BotResult[]>()
  const [now, setNow] = useState(() => Date.now())
  const [tick, setTick] = useState(0)
  const [loading, setLoading] = useState(false)
  const refresh = useCallback(() => {
    setLoading(true)
    setTick((n) => n + 1)
  }, [])

  const streaming = useAllLive(profiles)
  const changes = useAnyChange("projects")

  usePoll(refresh, streaming ? SAFETY_MS : REFRESH_MS, [], { immediate: false })

  const cloning = results?.some(
    (result) =>
      "projects" in result &&
      result.projects.some(
        (p) =>
          p.status === "cloning" ||
          p.folders.some((f) => f.status === "cloning" || f.status === "removing"),
      ),
  )
  usePoll(() => setTick((n) => n + 1), CLONING_REFRESH_MS, [], {
    active: Boolean(cloning && !streaming),
    immediate: false,
    onShow: false,
  })

  // Sync rewrites profile rows often; only a change to what's fetched should fetch again.
  const targetsKey = JSON.stringify(
    profiles?.map(({ id, baseUrl, apiKey }): Target => ({ id, baseUrl, apiKey })) ?? null,
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
  }, [targetsKey, tick, changes])

  const byId = new Map(profiles?.map((profile) => [profile.id, profile]))
  const all = results ? toRows(results, byId) : []
  const rows = all.filter((row) => !row.project.archived)
  const archived = all.filter((row) => row.project.archived)
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
                <ProjectItem row={row} now={now} onChanged={refresh} />
              </li>
            ))}
          </ul>
        ) : failed.length < results.length ? (
          <p className="px-1 text-sm text-muted-foreground">No projects yet.</p>
        ) : null}
        {archived.length > 0 && (
          <Collapsible render={<section aria-label="Archived" />}>
            <h2>
              <CollapsibleTrigger className="group -mx-1 flex min-h-11 items-center gap-1.5 rounded-xl px-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                Archived ({archived.length})
                <ChevronUpIcon className="size-4 rotate-180 transition-transform group-data-panel-open:rotate-0 motion-reduce:transition-none" />
              </CollapsibleTrigger>
            </h2>
            <CollapsibleContent>
              <ul className="flex flex-col">
                {archived.map((row) => (
                  <li key={row.key}>
                    <ProjectItem row={row} now={now} onChanged={refresh} />
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>

      {withPlugin.length > 0 && (
        <div className="pointer-events-none sticky bottom-0 mt-auto flex justify-end px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex w-full max-w-2xl justify-end">
            <Button
              data-toast-above
              size="lg"
              className="pointer-events-auto h-12 rounded-full px-5 shadow-lg"
              onClick={() => setCreating(true)}
            >
              <PlusIcon /> New project
            </Button>
          </div>
        </div>
      )}
      <NewProjectPopup
        open={creating}
        onOpenChange={setCreating}
        profiles={withPlugin}
        onCreated={(profile, name) => {
          toast.success(`Creating ${name} on ${profile.name}`)
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

/** The project's git repos (its folders when none is a repo). */
function repoLine(project: HermesProject) {
  const repos = project.folders.filter((folder) => folder.git)
  return {
    git: repos.length > 0,
    names: (repos.length ? repos : project.folders).map(folderName).join(", "),
  }
}

function formatWhen(at: number, now: number) {
  if (now - at < DAY_MS) return formatRelative(at, now)
  return new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })
}

function ProjectAvatar({ profile }: { profile: Profile }) {
  return (
    <span
      className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted"
      title={profile.name}
    >
      <Bot id={profile.botId} className="size-8" />
    </span>
  )
}

/** A project the plugin is still cloning, or one whose clone failed. It has no page until it's ready. */
function PendingItem({ row, onChanged }: { row: ProjectRow; onChanged: () => void }) {
  const { profile, project } = row
  const [busy, setBusy] = useState(false)
  const failed = project.status === "failed"
  const total = project.folders.length
  const done = project.folders.filter((folder) => folder.status === "done").length
  const act = async (action: typeof retryProject) => {
    setBusy(true)
    try {
      await action(profile, project.id)
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Couldn't update the project.")
    }
    setBusy(false)
    onChanged()
  }
  return (
    <div className="-mx-2 flex min-h-16 items-center gap-4 rounded-2xl px-2 py-3">
      <ProjectAvatar profile={profile} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{project.name}</span>
        {failed ? (
          <span className="block truncate text-sm text-destructive">
            {project.error ?? "Couldn't clone."}
          </span>
        ) : (
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-3.5" />
            {total > 0 ? `Cloning ${Math.min(done + 1, total)} of ${total}` : "Creating…"}
          </span>
        )}
      </span>
      {failed && (
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-11 rounded-full"
          disabled={busy}
          onClick={() => void act(retryProject)}
          aria-label={`Retry ${project.name}`}
        >
          <RotateCcwIcon />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-lg"
        className="size-11 rounded-full"
        disabled={busy}
        onClick={() => void act(deleteProject)}
        aria-label={failed ? `Remove ${project.name}` : `Cancel ${project.name}`}
      >
        {failed ? <Trash2Icon /> : <XIcon />}
      </Button>
    </div>
  )
}

function ProjectItem({
  row,
  now,
  onChanged,
}: {
  row: ProjectRow
  now: number
  onChanged: () => void
}) {
  const { profile, project, at } = row
  if (project.status !== "ready") return <PendingItem row={row} onChanged={onChanged} />
  const repos = repoLine(project)
  return (
    <Link
      to={`/code/${profile.id}/${project.id}`}
      state={{ project }}
      className="-mx-2 flex min-h-16 items-center gap-4 rounded-2xl px-2 py-3 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ProjectAvatar profile={profile} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
          {project.pinnedAt && (
            <PinIcon
              className="size-3.5 shrink-0 self-center text-muted-foreground"
              aria-label="Pinned"
            />
          )}
          {at > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground">{formatWhen(at, now)}</span>
          )}
        </span>
        {project.description && (
          <span className="block truncate text-sm text-muted-foreground">
            {project.description}
          </span>
        )}
        {repos.names && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {repos.git ? (
              <FolderGit2Icon className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <FolderIcon className="size-3.5 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 truncate">{repos.names}</span>
          </span>
        )}
      </span>
    </Link>
  )
}
