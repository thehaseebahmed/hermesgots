import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ArchiveXIcon,
  CheckIcon,
  CircleAlertIcon,
  CodeXmlIcon,
  FolderIcon,
  GitPullRequestArrowIcon,
  LockIcon,
  MenuIcon,
  PlusIcon,
} from "lucide-react"
import { Navigate, useNavigate } from "react-router"

import { prLabel, prLook } from "@/components/chat/pr-look"
import { useOpenDrawer } from "@/components/drawer-context"
import { ItemGroup, ItemRow, ItemSearch } from "@/components/item-list"
import { NewSessionPopup, type SessionTarget } from "@/components/new-session"
import { SortMenu } from "@/components/sort-menu"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { projectKey, startBlocked, useProjectSessions, useSessionFollowUps } from "@/lib/code"
import { connectionKey } from "@/lib/connection"
import {
  createConversation,
  db,
  getSettings,
  prIsLive,
  saveSettings,
  type CodeSort,
  type Conversation,
  type Profile,
} from "@/lib/db"
import { useDraft } from "@/lib/drafts"
import { formatRelative } from "@/lib/format"
import type { HermesProject } from "@/lib/hermes"
import { codeGroupOf, codeGroups, codeOrder } from "@/lib/item-groups"
import { useAnyChange } from "@/lib/live"
import { useNav } from "@/lib/nav"
import { itemToOpen, useCodePane, type FeaturePane } from "@/lib/pane"
import { readProjects, useAllProjects } from "@/lib/projects"
import { quietly } from "@/lib/report"
import { createSignal } from "@/lib/store"
import { cn } from "@/lib/utils"
import {
  reasonText,
  useAllLiveRuns,
  useLiveSubagents,
  useWaiting,
  type WaitingReason,
} from "@/lib/waiting"
import {
  isUnread,
  lastActivityAt,
  rowTone,
  sessionGroup,
  type SessionClaim,
  type SessionState,
} from "@/lib/session-work"
import { useReadMarks } from "@/lib/read-marks"

const DAY_MS = 86_400_000
const LAST_PROJECT = "memento:last-session-project"

/** Asks the list to open the New session sheet, from the empty pane beside it. */
const newSessionAsked = createSignal()

/**
 * Code: every coding session across projects and bots. Beside the list (see `useCodePane`) this
 * screen is the session pane: the session opened last, else the newest, else a way to start one.
 */
export function CodePage() {
  const pane = useCodePane()
  // Open sessions newest first, then closed ones, so a resolved session opens only when it's all
  // there is.
  const ids = useLiveQuery(async () => {
    if (!pane) return []
    const enabled = new Set(
      (await db.profiles.toArray()).filter((p) => !p.disabled).map((p) => p.id),
    )
    const rows = (await db.conversations.where("projectId").above("").toArray())
      .filter((c) => enabled.has(c.profileId) && (c.draftAt || c.updatedAt > c.createdAt))
      .sort(
        (a, b) =>
          Number(Boolean(a.resolvedAt || a.discardedAt)) -
            Number(Boolean(b.resolvedAt || b.discardedAt)) || b.updatedAt - a.updatedAt,
      )
    return rows.map((c) => c.id)
  }, [Boolean(pane)])
  if (!pane) return <CodeList />
  if (!ids) return null
  const open = itemToOpen("code", ids)
  if (open) return <Navigate to={`/c/${open}`} replace state={{ code: true }} />
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
        <CodeXmlIcon className="size-8" aria-hidden />
      </span>
      <h2 className="text-lg font-semibold tracking-tight">No sessions yet</h2>
      <Button size="lg" className="h-12 rounded-full px-5" onClick={() => newSessionAsked.notify()}>
        <PlusIcon /> New session
      </Button>
    </div>
  )
}

/** The list kept on screen beside the open session (see `useCodePane`). */
export function CodePane({ pane }: { pane: FeaturePane }) {
  return <CodeList pane={pane} />
}

interface Row extends SessionClaim {
  c: Conversation
  project?: HermesProject
  key: string
}

const CODE_SORTS: Record<CodeSort, string> = {
  created: "Created",
  activity: "Last activity",
  title: "Title A–Z",
}

/** The Code list's order over each group, kept on this device (unset: created). */
function useCodeSort(): [CodeSort, (sort: CodeSort) => void] {
  const sort = useLiveQuery(async () => (await getSettings()).codeSort, []) ?? "created"
  return [sort, (codeSort) => void saveSettings({ codeSort }).catch(quietly("Saving the sort order"))]
}

function CodeList({ pane }: { pane?: FeaturePane }) {
  const openDrawer = useOpenDrawer()
  const navigate = useNavigate()
  const { root } = useNav()
  const listed = useProjectSessions()
  const live = useAllLiveRuns()
  const subagents = useLiveSubagents()
  const waits = useWaiting()
  const lists = useAllProjects()
  const changes = useAnyChange("projects")
  // This device's read marks: the rows' dots redraw the moment one moves (the thread rendered
  // in the pane beside).
  const marks = useReadMarks()
  const [query, setQuery] = useState("")
  const [chip, setChip] = useState<string>()
  const [starting, setStarting] = useState(false)
  const [sort, setSort] = useCodeSort()

  const sessions = listed?.sessions
  const profiles = listed?.profiles
  useSessionFollowUps(sessions, pane?.selected)

  // Each server once, by the first bot on it, which keeps its projects as the Projects list does.
  const servers = useMemo(() => {
    const unique = new Map<string, Profile>()
    for (const profile of profiles?.values() ?? [])
      if (profile.apiKey && !unique.has(connectionKey(profile)))
        unique.set(connectionKey(profile), profile)
    return unique
  }, [profiles])
  // The servers, not the bots: their rows change far more often than which server they're on.
  const toRead = JSON.stringify(
    [...servers.values()].map(({ baseUrl, apiKey }) => ({ baseUrl, apiKey })),
  )
  useEffect(() => {
    for (const server of JSON.parse(toRead) as { baseUrl: string; apiKey: string }[])
      readProjects(server).catch(quietly("Reading projects"))
  }, [toRead, changes])

  const projects = useMemo(() => {
    const byKey = new Map<string, { profile: Profile; project: HermesProject }>()
    for (const [key, profile] of servers)
      for (const project of lists.get(key) ?? [])
        if (project.status === "ready")
          byKey.set(projectKey(profile, project.id), { profile, project })
    return byKey
  }, [servers, lists])

  const serverWaits = (c: Conversation) => Boolean(waits[c.hermesSessionId])
  const rows: Row[] = (sessions ?? []).flatMap((c) => {
    const profile = profiles?.get(c.profileId)
    if (!profile) return []
    const key = projectKey(profile, c.projectId!)
    return [
      {
        c,
        key,
        project: projects.get(key)?.project,
        ...sessionGroup(
          c,
          live[c.hermesSessionId],
          {
            ...listed?.local[c.id],
            waiting: listed?.local[c.id]?.waiting || serverWaits(c),
          },
          subagents[c.hermesSessionId],
        ),
      },
    ]
  })

  // A chip for each project that has a session, or could start one.
  const chips = [...projects.entries()]
    .filter(([key, { project }]) => !project.archived || rows.some((r) => r.key === key))
    .sort((a, b) => a[1].project.name.localeCompare(b[1].project.name))
  const shown = rows.filter((r) => (!chip || r.key === chip) && matches(r, query))
  const filtering = Boolean(query.trim() || chip)
  // The chosen order runs inside every group, and over all rows flat while a search or chip
  // filters — filtering is this list with its headers removed, one order either way.
  const order = codeOrder<Row>(sort, {
    created: (row) => row.c.createdAt,
    activity: (row) => lastActivityAt(row.c),
    title: (row) => row.c.title,
  })
  // What waits on the user first, then working, idle and closed — deterministic, not a live
  // timestamp chasing itself. Only the grouped view needs it: a filtered list is flat.
  const grouped = filtering ? undefined : codeGroups(shown, (r) => codeGroupOf(r.state), order)
  const flat = filtering ? [...shown].sort(order) : undefined

  const targets: SessionTarget[] = [...projects.entries()]
    // A project with no repository has nowhere for a session to work, so it isn't offered.
    .filter(([, { project }]) => !project.archived && project.folders.some((f) => f.git))
    .map(([key, { profile, project }]) => ({
      key,
      profile,
      project,
      blocked: profile.apiKey ? startBlocked(project) : "No API key",
    }))
    .sort((a, b) => a.project.name.localeCompare(b.project.name))
  const initial = chip ?? lastProject()

  useEffect(() => newSessionAsked.subscribe(() => setStarting(true)), [])

  const start = async ({ key, profile, project }: SessionTarget) => {
    const conversation = await createConversation(profile.id, {
      title: "Draft session",
      projectId: project.id,
    })
    try {
      localStorage.setItem(LAST_PROJECT, key)
    } catch {
      // Storage can be blocked; the first project is the fallback.
    }
    setStarting(false)
    // So the new session can name its repos at once. Beside a session, it takes that one's place.
    navigate(`/c/${conversation.id}`, {
      replace: Boolean(pane?.open),
      state: { project, code: true },
    })
  }

  // One row, drawn in its group or in the flat filtered list.
  const draw = (row: Row) => (
    <li key={row.c.id}>
      <SessionItem
        row={row}
        botId={profiles?.get(row.c.profileId)?.botId}
        showProject={!chip}
        pane={pane}
        now={listed?.now ?? 0}
        waiting={waits[row.c.hermesSessionId]}
        mark={marks[row.c.id]}
      />
    </li>
  )

  // The scroll container carries the header's height for the group headings to tuck under (its
  // row over its padding over any safe-area top — the header spells the same `max(0.75rem, …)`
  // for its own padding below): one value, read by `ItemGroup`'s sticky headings.
  const headerHeight =
    "calc(max(0.75rem, env(safe-area-inset-top)) + 3.5rem)"
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      style={{ "--list-header-h": headerHeight } as CSSProperties}
    >
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
          <SortMenu by="sessions" options={CODE_SORTS} value={sort} onSort={setSort} />
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 pt-2 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {(rows.length > 0 || chips.length > 1) && (
          <div className="flex flex-col gap-3">
            <ItemSearch value={query} onChange={setQuery} label="Search sessions" />
            {chips.length > 1 && (
              <div
                className="-mx-4 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4"
                role="group"
                aria-label="Projects"
              >
                <Chip active={!chip} onClick={() => setChip(undefined)}>
                  All
                </Chip>
                {chips.map(([key, { project }]) => (
                  <Chip
                    key={key}
                    active={chip === key}
                    onClick={() => setChip(chip === key ? undefined : key)}
                  >
                    <FolderIcon className="size-4" />
                    {project.name}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        )}

        {sessions && rows.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">No sessions yet.</p>
        )}
        {rows.length > 0 && shown.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-sm text-muted-foreground">No sessions match.</p>
            {filtering && (
              <Button
                variant="outline"
                className="h-11 rounded-full"
                onClick={() => {
                  setQuery("")
                  setChip(undefined)
                }}
              >
                Show all
              </Button>
            )}
          </div>
        )}

        {flat ? (
          // Filtering drops the headers: one flat list, the chosen order over everything shown.
          <ul className="flex flex-col">{flat.map(draw)}</ul>
        ) : (
          grouped?.map((group) => (
            <ItemGroup key={group.key} group={group} sticky>
              {group.items.map(draw)}
            </ItemGroup>
          ))
        )}
      </div>

      <div className="pointer-events-none sticky bottom-0 mt-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto flex w-full max-w-2xl justify-end">
          <Button
            data-toast-above
            size="lg"
            className="pointer-events-auto h-12 rounded-full px-5 shadow-lg"
            onClick={() => setStarting(true)}
          >
            <PlusIcon /> New session
          </Button>
        </div>
      </div>
      <NewSessionPopup
        open={starting}
        onOpenChange={setStarting}
        targets={targets}
        initial={initial}
        onStart={start}
        onNewProject={() => {
          setStarting(false)
          root("/projects")
        }}
      />
    </div>
  )
}

function lastProject() {
  try {
    return localStorage.getItem(LAST_PROJECT) ?? undefined
  } catch {
    return undefined
  }
}

function matches({ c, project }: Row, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const text = [c.title, project?.name, c.worktree?.branch].join(" ").toLowerCase()
  return words.every((word) => text.includes(word))
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-4 text-sm font-medium transition-colors",
        active
          ? "border-foreground bg-foreground text-background"
          : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  )
}

const names = new Intl.ListFormat(undefined, { type: "conjunction" })

function formatWhen(at: number, now: number) {
  if (now - at < DAY_MS) return formatRelative(at, now)
  return new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })
}

/**
 * `user/repo #27 · Open`, naming the repo when the session spans more than one. Only the live
 * pull requests show: a session keeps the ones it already finished, and its row is for what it
 * still has open — a session left with only finished ones shows its newest.
 */
function prLine(session: Conversation) {
  const all = session.prs ?? []
  if (!all.length) return undefined
  const live = all.filter(prIsLive)
  const shown = live.length
    ? live
    : [all.reduce((newest, pr) => (pr.number > newest.number ? pr : newest))]
  return shown
    .map((pr) => {
      const state = prLook(pr).label
      return `${prLabel(pr, all)} · ${state[0].toUpperCase() + state.slice(1)}`
    })
    .join(", ")
}

function StateIcon({ state }: { state: SessionState }) {
  if (state === "working") return <Spinner />
  if (state === "waiting") return <CircleAlertIcon />
  if (state === "resolved") return <CheckIcon />
  if (state === "discarded") return <ArchiveXIcon />
  return <CodeXmlIcon />
}

/** The repos a session works in that were removed from its project, which makes it read-only. */
function removedRepos(c: Conversation, project: HermesProject | undefined) {
  if (project?.status !== "ready") return []
  // Named as the plugin names a session's repos: by GitHub origin, else by folder.
  const current = new Set(
    project.folders.filter((f) => f.git).map((f) => f.repo ?? f.path.split(/[\\/]/).at(-1)),
  )
  return (c.worktree?.repos ?? []).map((r) => r.name).filter((name) => !current.has(name))
}

/** One Code row's body, exported so a component test can draw it over a seeded device. */
export function SessionItem({
  row: { c: session, state, prTick, project },
  botId,
  showProject,
  pane,
  now,
  waiting,
  mark,
}: {
  row: Row
  botId?: string
  /** Every project's sessions are listed, so each says which it belongs to. */
  showProject: boolean
  pane?: FeaturePane
  now: number
  /** Why the server says the session waits on the user, if it does. */
  waiting?: WaitingReason
  /** This device's read mark for the session, if it has one; newer activity dots the row. */
  mark?: number
}) {
  const removed = removedRepos(session, project)
  const draft = useDraft(session.id)
  const wait = waiting ? reasonText(waiting) : undefined
  const detail = removed.length
    ? `${names.format(removed)} removed`
    : (wait ?? prLine(session) ?? session.worktree?.branch ?? draft)
  const line = [showProject ? project?.name : undefined, detail].filter(Boolean).join(" · ")
  return (
    <ItemRow
      icon={
        removed.length && state !== "working" ? (
          <LockIcon />
        ) : prTick ? (
          <GitPullRequestArrowIcon />
        ) : (
          <StateIcon state={state} />
        )
      }
      tone={rowTone(session, { state, prTick })}
      unread={isUnread(session, mark)}
      botId={botId}
      title={session.title}
      badge={
        session.afk ? (
          <Badge data-afk className="bg-primary/10 text-primary">
            AFK
          </Badge>
        ) : undefined
      }
      when={formatWhen(lastActivityAt(session), now)}
      line={line && <span className="truncate">{line}</span>}
      selected={session.id === pane?.selected}
      link={{ to: `/c/${session.id}`, replace: Boolean(pane?.open), state: { code: true } }}
    />
  )
}
