import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ArchiveIcon,
  ArchiveXIcon,
  ArrowLeftIcon,
  CheckIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  GitPullRequestArrowIcon,
  LockIcon,
  PlusIcon,
  Settings2Icon,
} from "lucide-react"
import { Link, useLocation, useNavigate, useParams } from "react-router"
import { toast } from "sonner"

import { ChatHeader } from "@/components/chat/chat-header"
import { prLabel, prLook } from "@/components/chat/pr-look"
import { PrRow } from "@/components/chat/pr-pill"
import { ProjectSettings } from "@/components/project-settings"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { stopMessage } from "@/lib/chat"
import {
  createConversation,
  db,
  deleteConversation,
  type Conversation,
  type PullRequestRef,
} from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { useDraft } from "@/lib/drafts"
import { SAFETY_MS, useChanges, useLive } from "@/lib/live"
import { usePoll } from "@/lib/poll"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { cn } from "@/lib/utils"
import { reasonText, useLiveRuns, useWaiting, type WaitingReason } from "@/lib/waiting"
import { deleteProject, listProjects, type HermesProject } from "@/lib/hermes"
import {
  projectRepos,
  PR_PENDING_MS,
  prChecksPending,
  refreshPrs,
  refreshWorkspace,
  sessionState,
  type SessionState,
} from "@/lib/workspace"

/** While a repo is being added or removed: the plugin does the work, this watches for it to finish. */
const CHANGING_MS = 3_000
/** How soon the screen reads a session's worktree and pull requests again while it stays open. */
const REREAD_MS = 60_000
const DAY_MS = 86_400_000
const GROUPS: { state: SessionState; label: string }[] = [
  { state: "working", label: "Working" },
  { state: "waiting", label: "Waiting on you" },
  { state: "idle", label: "Idle" },
  { state: "resolved", label: "Resolved" },
  { state: "discarded", label: "Discarded" },
]
/** A finished group longer than this starts collapsed. */
const FOLD_OVER = 5

function serverKey(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

/**
 * One Hermes Project: its sessions, library and PRs. From `xl` the app shell keeps it beside the
 * open session (`session`), so picking another one swaps it in place.
 */
export function ProjectPage({
  pane,
  session: openSession,
}: {
  pane?: { profileId: string; projectId: string }
  session?: string
}) {
  const params = useParams()
  const { profileId = "", projectId = "" } = pane ?? params
  const navigate = useNavigate()
  const { root, up } = useNav()
  // A project sits under Code, and a session open beside it under the project.
  const back = useCallback(
    () => (openSession ? root("/code") : up("/code")),
    [openSession, root, up],
  )
  useEffect(() => {
    return setBackGuard(() => {
      back()
      return true
    })
  }, [back])
  const passed = (useLocation().state as { project?: HermesProject } | null)?.project
  const profile = useLiveQuery(() => db.profiles.get(profileId), [profileId])
  const [fetched, setFetched] = useState<HermesProject>()
  // The Code screen hands the project over, so it shows at once; it's read again here regardless.
  const project = fetched ?? (passed?.id === projectId ? passed : undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reads, setReads] = useState(0)
  const reload = () => setReads((n) => n + 1)
  const live = useLiveRuns(profile)
  const streaming = useLive(profile)
  const projectChanges = useChanges("projects", profile)
  const changing = project?.folders.some((f) => f.status === "cloning" || f.status === "removing")

  useEffect(() => {
    if (!profile) return
    let cancelled = false
    listProjects(profile)
      .then((all) => {
        const found = all.find((p) => p.id === projectId)
        if (!cancelled && found) setFetched(found)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [profile, projectId, reads, projectChanges])

  usePoll(() => setReads((n) => n + 1), streaming ? SAFETY_MS : CHANGING_MS, [], {
    active: Boolean(changing),
    immediate: false,
    onShow: false,
  })

  // Bots on one server share its projects, so their sessions all belong here.
  const listed = useLiveQuery(async () => {
    if (!profile) return { rows: [] as Conversation[], now: Date.now() }
    const server = serverKey(profile.baseUrl)
    const bots = new Set(
      (await db.profiles.toArray()).filter((p) => serverKey(p.baseUrl) === server).map((p) => p.id),
    )
    const rows = await db.conversations.where("projectId").equals(projectId).toArray()
    return {
      rows: rows.filter((c) => bots.has(c.profileId)).sort((a, b) => b.updatedAt - a.updatedAt),
      now: Date.now(),
    }
  }, [profile, projectId])
  const rows = listed?.rows
  const now = listed?.now ?? 0

  // What this device sees of its own turns: a reply streaming, an approval or a question waiting.
  const ids = rows?.map((c) => c.id) ?? []
  const local = useLiveQuery(async () => {
    const signals: Record<string, { any?: boolean; streaming?: boolean; waiting?: boolean }> = {}
    if (ids.length === 0) return signals
    const messages = await db.messages.where("conversationId").anyOf(ids).toArray()
    for (const m of messages) {
      const signal = (signals[m.conversationId] ??= {})
      signal.any = true
      if (m.status === "streaming") signal.streaming = true
      if ((m.approval && !m.approval.resolved) || (m.clarify && !m.clarify.resolved))
        signal.waiting = true
    }
    return signals
  }, [ids.join("\n")])
  // What the server says waits on the user, including a Theseus run's plan, checkpoints or approval.
  const waits = useWaiting()

  // A session nothing was sent in (or typed for) isn't one yet. Synced ones carry their activity in
  // `updatedAt`, since their messages load only when opened.
  const sessions = rows?.filter((c) => c.draftAt || c.updatedAt > c.createdAt || local?.[c.id]?.any)

  // A session's PRs are read when it's open; this reads them for every session as the screen opens,
  // its worktree first when this device hasn't seen it (a session started elsewhere). While the
  // screen stays open it reads both again, at most every minute, as the sessions change, so a plan
  // approved or a pull request opened on another device shows here too.
  const read = useRef(new Map<string, number>())
  useEffect(() => {
    const now = Date.now()
    for (const c of sessions ?? []) {
      const last = read.current.get(c.id)
      if (last !== undefined && now - last < REREAD_MS) continue
      read.current.set(c.id, now)
      const workspace = !c.worktree || last !== undefined
      void (workspace ? refreshWorkspace(c.id) : Promise.resolve()).then(() => refreshPrs(c.id))
    }
  }, [sessions])
  // The open session's chat pane polls its own PR; exclude it here to avoid duplicate reads.
  const runningChecks = (sessions ?? []).filter(
    (c) => c.id !== openSession && prChecksPending(c.prs),
  )
  // While any does, read its pull requests again every few seconds, so the rows here keep up with
  // the pill. Forced, so the freshness gate doesn't skip a tick that lands just inside its window.
  usePoll(
    () => {
      for (const c of runningChecks) void refreshPrs(c.id, { force: true })
    },
    PR_PENDING_MS,
    [],
    { active: runningChecks.length > 0, immediate: false, onShow: false },
  )

  const prs = projectPrs(sessions ?? [])
  // The header names the repos, like the chips under it do: the one repo's name, or a count.
  const repos = project ? projectRepos(project) : []
  const subtitle = [
    profile?.name,
    repos.length > 1 ? `${repos.length} repositories` : repos[0]?.name,
  ]
    .filter(Boolean)
    .join(" - ")

  // A session spans every repo of the project; without one there's nowhere for it to work, and
  // while one is still being cloned it would start without it.
  const adding = project?.folders.flatMap((f) => (f.status === "cloning" && f.repo ? [f.repo] : []))
  const canStart = Boolean(
    profile?.apiKey &&
    project?.status === "ready" &&
    !project.archived &&
    !adding?.length &&
    project.folders.some((folder) => folder.git),
  )
  // The repos a session works in that are no longer in the project.
  // Named as the plugin names a session's repos: by GitHub origin, else by folder.
  const current = new Set(
    project?.folders.filter((f) => f.git).map((f) => f.repo ?? f.path.split(/[\\/]/).at(-1)),
  )
  const removedRepos = (c: Conversation) =>
    project?.status === "ready"
      ? (c.worktree?.repos ?? []).map((r) => r.name).filter((name) => !current.has(name))
      : []

  const start = async () => {
    if (!profile) return
    const conversation = await createConversation(profile.id, { title: "Draft session", projectId })
    // So the new session can name its repos at once. Beside a session, it takes that one's place.
    navigate(`/c/${conversation.id}`, {
      replace: Boolean(openSession),
      state: { project, pane: { profileId, projectId } },
    })
  }

  const remove = async () => {
    if (!profile) return
    setBusy(true)
    try {
      await deleteProject(profile, projectId)
      for (const c of sessions ?? []) {
        stopMessage(c.id)
        await deleteConversation(c.id)
      }
      back()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't delete the project.")
      setBusy(false)
      setDeleting(false)
    }
  }

  // A Theseus run sits in `theseus wait` (a running turn) while it waits on the user.
  const theseusWaits = (c: Conversation) => waits[c.hermesSessionId]?.kind === "theseus"
  // A session left with an open pull request is waiting to be reviewed and merged, not idle —
  // unless its checks are still running, which is work it has left to do.
  const groupState = (c: Conversation) => {
    const state = sessionState(c, live[c.hermesSessionId], {
      ...local?.[c.id],
      waiting: local?.[c.id]?.waiting || theseusWaits(c),
    })
    if (state !== "idle" || !hasOpenPr(c)) return { state, prTick: false }
    return prChecksPending(c.prs)
      ? { state: "working" as const, prTick: false }
      : { state: "waiting" as const, prTick: true }
  }
  const grouped = GROUPS.map((group) => ({
    ...group,
    sessions: (sessions ?? [])
      .map((c) => ({ c, ...groupState(c) }))
      .filter((s) => s.state === group.state),
  })).filter((group) => group.sessions.length > 0)

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
      <ChatHeader
        className="relative pb-2"
        title={project?.name ?? ""}
        subtitle={subtitle}
        showBot={false}
        leading={
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full"
            onClick={back}
            aria-label="Back"
          >
            <ArrowLeftIcon />
          </Button>
        }
        actions={
          project?.status === "ready" && (
            <Button
              variant="outline"
              size="icon-lg"
              className="size-11 rounded-full bg-background/80 backdrop-blur"
              onClick={() => setSettingsOpen(true)}
              aria-label="Project settings"
            >
              <Settings2Icon />
            </Button>
          )
        }
      />
      <Tabs defaultValue="sessions" className="flex-1">
        <TabsList>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="prs">PRs</TabsTrigger>
        </TabsList>
        <TabsContent value="sessions" className="flex flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
            {sessions && sessions.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">No sessions yet.</p>
            ) : (
              <div className="flex flex-col gap-6">
                {grouped.map((group) => (
                  <Group
                    key={group.state}
                    label={group.label}
                    count={group.sessions.length}
                    fold={group.state === "discarded" ? "always" : group.state === "resolved"}
                  >
                    {group.sessions.map(({ c, prTick }) => (
                      <li key={c.id}>
                        <SessionItem
                          session={c}
                          open={c.id === openSession}
                          pane={openSession ? { profileId, projectId } : undefined}
                          state={group.state}
                          prTick={prTick}
                          now={now}
                          removed={removedRepos(c)}
                          waiting={waits[c.hermesSessionId]}
                        />
                      </li>
                    ))}
                  </Group>
                ))}
              </div>
            )}
          </div>
          {project?.archived ? (
            <BottomNote icon={<ArchiveIcon className="size-4 shrink-0" />}>
              This project is archived. Unarchive it in settings to start a session.
            </BottomNote>
          ) : adding?.length ? (
            <BottomNote icon={<Spinner className="size-4 shrink-0" />}>
              Adding {names.format(adding)}. New sessions can start once{" "}
              {adding.length === 1 ? "it's" : "they're"} cloned.
            </BottomNote>
          ) : (
            canStart && (
              <div className="sticky bottom-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <div className="mx-auto flex w-full max-w-2xl justify-end">
                  <Button
                    size="lg"
                    className="h-12 rounded-full px-5 shadow-lg"
                    onClick={() => void start()}
                  >
                    <PlusIcon /> New session
                  </Button>
                </div>
              </div>
            )
          )}
        </TabsContent>
        <TabsContent value="library" />
        <TabsContent value="prs" className="overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-4 py-6">
            {sessions && prs.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">No pull requests yet.</p>
            ) : (
              <div className="flex flex-col gap-6">
                {PR_GROUPS.map((group) => {
                  const list = prs.filter((pr) => group.states.includes(pr.state))
                  if (!list.length) return null
                  return (
                    <Group
                      key={group.label}
                      label={group.label}
                      count={list.length}
                      fold={group.fold}
                    >
                      {list.map((pr) => (
                        <li key={`${pr.repo}#${pr.number}`}>
                          <PrRow pr={pr} />
                        </li>
                      ))}
                    </Group>
                  )
                })}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {profile && project?.status === "ready" && (
        <ProjectSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          profile={profile}
          project={project}
          onChanged={reload}
          onArchived={back}
          onDelete={() => setDeleting(true)}
        />
      )}

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              The project and its sessions are removed from this device. Its folders on the server
              stay where they are, and Hermes keeps its own copy of the sessions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const names = new Intl.ListFormat(undefined, { type: "conjunction" })

/** A pull request still open (a draft included) is a session waiting to be reviewed and merged. */
const hasOpenPr = (c: Conversation) =>
  (c.prs ?? []).some((pr) => pr.state === "open" || pr.state === "draft")

/** In place of the New session button: why there's none right now. */
function BottomNote({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div
        role="status"
        className="mx-auto flex w-full max-w-2xl items-center gap-3 rounded-3xl border bg-background/90 px-4 py-3 text-sm shadow-lg backdrop-blur"
      >
        {icon}
        <span className="min-w-0 flex-1">{children}</span>
      </div>
    </div>
  )
}

function formatWhen(at: number, now: number) {
  if (now - at < DAY_MS) return formatRelative(at, now)
  return new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })
}

/** `user/repo #27 · Open`, naming the repo when the session spans more than one. */
function prLine(session: Conversation) {
  const prs = session.prs ?? []
  if (!prs.length) return undefined
  return prs
    .map((pr) => {
      const state = prLook(pr).label
      return `${prLabel(pr, prs)} · ${state[0].toUpperCase() + state.slice(1)}`
    })
    .join(", ")
}

function StateIcon({ state }: { state: SessionState }) {
  if (state === "working") return <Spinner className="size-4" />
  if (state === "waiting") return <CircleAlertIcon className="size-4 text-warning" />
  if (state === "resolved") return <CheckIcon className="size-4 text-success" />
  if (state === "discarded") return <ArchiveXIcon className="size-4 text-muted-foreground" />
  return null
}

function SessionItem({
  session,
  open,
  pane,
  state,
  prTick,
  now,
  removed,
  waiting,
}: {
  session: Conversation
  /** Open beside the project. */
  open?: boolean
  /** The project, when a session is open beside it: another one takes its place. */
  pane?: { profileId: string; projectId: string }
  state: SessionState
  /** Waits on the user with an open pull request to review and merge. */
  prTick?: boolean
  now: number
  /** Why the server says the session waits on the user, if it does. */
  waiting?: WaitingReason
  /** Repos the session works in that were removed from the project, which makes it read-only. */
  removed: string[]
}) {
  const theseusLine =
    session.mode === "theseus"
      ? `Theseus · ${waiting?.kind === "theseus" ? reasonText(waiting) : "Run in progress"}`
      : undefined
  const draft = useDraft(session.id)
  const line2 = removed.length
    ? `${names.format(removed)} removed`
    : (theseusLine ?? prLine(session) ?? session.worktree?.branch ?? draft)
  return (
    <Link
      to={`/c/${session.id}`}
      replace={Boolean(pane)}
      state={{ pane: pane ?? { profileId: session.profileId, projectId: session.projectId } }}
      aria-current={open ? "page" : undefined}
      className={cn(
        "-mx-2 flex min-h-14 items-center gap-3 rounded-2xl px-2 py-3 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
        open && "bg-muted hover:bg-muted",
      )}
    >
      <span className="flex w-5 shrink-0 items-center justify-center">
        {removed.length && state !== "working" ? (
          <LockIcon className="size-4 text-muted-foreground" />
        ) : prTick ? (
          <GitPullRequestArrowIcon className="size-4 text-primary" />
        ) : (
          <StateIcon state={state} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-3">
          <span className="min-w-0 flex-1 truncate font-medium">{session.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatWhen(session.updatedAt, now)}
          </span>
        </span>
        {line2 && <span className="block truncate text-sm text-muted-foreground">{line2}</span>}
      </span>
    </Link>
  )
}

/**
 * A titled list that folds away; a finished one (`fold`) longer than `FOLD_OVER` starts folded,
 * and an `"always"` one always does.
 * It's mounted once its first item is known, so that count decides.
 */
function Group({
  label,
  count,
  fold,
  children,
}: {
  label: string
  count: number
  fold?: boolean | "always"
  children: ReactNode
}) {
  return (
    <Collapsible
      defaultOpen={!fold || (fold !== "always" && count <= FOLD_OVER)}
      render={<section aria-label={label} />}
    >
      <h2>
        <CollapsibleTrigger className="group -mx-1 flex min-h-11 items-center gap-1.5 rounded-xl px-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {label} ({count})
          <ChevronUpIcon className="size-4 rotate-180 transition-transform group-data-panel-open:rotate-0 motion-reduce:transition-none" />
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent>
        <ul>{children}</ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

const PR_GROUPS: { label: string; states: PullRequestRef["state"][]; fold?: boolean }[] = [
  { label: "Open", states: ["open", "draft"] },
  { label: "Done", states: ["merged", "closed"], fold: true },
]

/** Every session's pull requests, each once, newest number first. */
function projectPrs(sessions: Conversation[]) {
  const byKey = new Map<string, PullRequestRef>()
  for (const pr of sessions.flatMap((c) => c.prs ?? [])) {
    const key = `${pr.repo}#${pr.number}`
    const known = byKey.get(key)
    if (!known || pr.at > known.at) byKey.set(key, pr)
  }
  return [...byKey.values()].sort((a, b) => b.number - a.number || a.repo.localeCompare(b.repo))
}
