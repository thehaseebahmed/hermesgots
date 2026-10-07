import { useEffect, useRef, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { Link, useLocation, useNavigate, useParams } from "react-router"
import { toast } from "sonner"

import { ChatHeader } from "@/components/chat/chat-header"
import { PrRow } from "@/components/chat/pr-pill"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { stopMessage } from "@/lib/chat"
import {
  createConversation,
  db,
  deleteConversation,
  type Conversation,
  type Profile,
  type PullRequestRef,
} from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import {
  deleteProject,
  listLiveRuns,
  listProjects,
  updateProject,
  type HermesProject,
  type LiveRunStatus,
} from "@/lib/hermes"
import { refreshPrs, refreshWorkspace, sessionState, type SessionState } from "@/lib/workspace"

/** How often the plugin is asked which sessions have a run in flight, while the screen is on. */
const LIVE_MS = 10_000
const DAY_MS = 86_400_000
const GROUPS: { state: SessionState; label: string }[] = [
  { state: "working", label: "Working" },
  { state: "waiting", label: "Waiting on you" },
  { state: "idle", label: "Idle" },
  { state: "resolved", label: "Resolved" },
]
/** A finished group longer than this starts collapsed. */
const FOLD_OVER = 5

function serverKey(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
}

/** Sessions with a run in flight on the bot's server, by Hermes session id. */
function useLiveRuns(profile: Profile | undefined) {
  const [live, setLive] = useState<Record<string, LiveRunStatus>>({})
  const connection = profile && `${profile.baseUrl}\n${profile.apiKey}`
  useEffect(() => {
    if (!connection) return
    const [baseUrl, apiKey] = connection.split("\n")
    let cancelled = false
    const poll = () => {
      if (document.visibilityState !== "visible") return
      listLiveRuns({ baseUrl, apiKey })
        .then((next) => !cancelled && setLive(next))
        .catch(() => undefined)
    }
    poll()
    const timer = window.setInterval(poll, LIVE_MS)
    document.addEventListener("visibilitychange", poll)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", poll)
    }
  }, [connection])
  return live
}

/** One Hermes Project: its sessions, library and PRs. */
export function ProjectPage() {
  const { profileId = "", projectId = "" } = useParams()
  const navigate = useNavigate()
  const { up } = useNav()
  // A project sits under Code.
  useEffect(() => {
    return setBackGuard(() => {
      up("/code")
      return true
    })
  }, [up])
  const passed = (useLocation().state as { project?: HermesProject } | null)?.project
  const profile = useLiveQuery(() => db.profiles.get(profileId), [profileId])
  const [fetched, setFetched] = useState<HermesProject>()
  const [edits, setEdits] = useState<Pick<HermesProject, "name" | "description">>()
  const base = passed?.id === projectId ? passed : fetched
  const project = base && { ...base, ...edits }
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [busy, setBusy] = useState(false)
  const live = useLiveRuns(profile)

  // Opened from a link or a reload, with no project handed over by the Code screen.
  useEffect(() => {
    if (!profile || passed?.id === projectId) return
    let cancelled = false
    listProjects(profile)
      .then((all) => !cancelled && setFetched(all.find((p) => p.id === projectId)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [profile, passed, projectId])

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

  // A session nothing was sent in (or typed for) isn't one yet. Synced ones carry their activity in
  // `updatedAt`, since their messages load only when opened.
  const sessions = rows?.filter((c) => c.draftAt || c.updatedAt > c.createdAt || local?.[c.id]?.any)

  // A session's PRs are read when it's open; this reads them for every session once per visit, its
  // worktree first when this device hasn't seen it (a session started elsewhere).
  const read = useRef(new Set<string>())
  useEffect(() => {
    for (const c of sessions ?? []) {
      if (read.current.has(c.id)) continue
      read.current.add(c.id)
      void (c.worktree ? Promise.resolve() : refreshWorkspace(c.id)).then(() => refreshPrs(c.id))
    }
  }, [sessions])

  const prs = projectPrs(sessions ?? [])

  // A session spans every repo of the project; without one there's nowhere for it to work.
  const canStart = Boolean(
    profile?.apiKey && project?.status === "ready" && project.folders.some((folder) => folder.git),
  )

  const start = async () => {
    if (!profile) return
    const conversation = await createConversation(profile.id, { title: "Draft session", projectId })
    navigate(`/c/${conversation.id}`)
  }

  const save = async () => {
    if (!profile || !name.trim()) return
    setBusy(true)
    try {
      await updateProject(profile, projectId, {
        name: name.trim(),
        description: description.trim(),
      })
      setEdits({ name: name.trim(), description: description.trim() || null })
      setEditing(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save the project.")
    } finally {
      setBusy(false)
    }
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
      up("/code")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't delete the project.")
      setBusy(false)
      setDeleting(false)
    }
  }

  const grouped = GROUPS.map((group) => ({
    ...group,
    sessions: (sessions ?? []).filter(
      (c) => sessionState(c, live[c.hermesSessionId], local?.[c.id]) === group.state,
    ),
  })).filter((group) => group.sessions.length > 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        className="relative pb-2"
        title={project?.name ?? ""}
        subtitle={profile?.name}
        showBot={false}
        leading={
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full"
            onClick={() => up("/code")}
            aria-label="Back"
          >
            <ArrowLeftIcon />
          </Button>
        }
        actions={
          project?.status === "ready" && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-lg"
                    className="size-11 rounded-full bg-background/80 backdrop-blur"
                    aria-label="Project options"
                  />
                }
              >
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem
                  onClick={() => {
                    setName(project.name)
                    setDescription(project.description ?? "")
                    setEditing(true)
                  }}
                >
                  <PencilIcon />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
                    fold={group.state === "resolved"}
                  >
                    {group.sessions.map((c) => (
                      <li key={c.id}>
                        <SessionItem session={c} state={group.state} now={now} />
                      </li>
                    ))}
                  </Group>
                ))}
              </div>
            )}
          </div>
          {canStart && (
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

      <AlertDialog open={editing} onOpenChange={setEditing}>
        <AlertDialogContent>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Edit project</AlertDialogTitle>
            </AlertDialogHeader>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              aria-label="Project name"
            />
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Description (optional)"
              aria-label="Project description"
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction type="submit" disabled={busy || !name.trim()}>
                Save
              </AlertDialogAction>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>

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

function formatWhen(at: number, now: number) {
  if (now - at < DAY_MS) return formatRelative(at, now)
  return new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })
}

const PR_LABELS = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }

/** `user/repo #27 · Open`, naming the repo when the session spans more than one. */
function prLine(session: Conversation) {
  const prs = session.prs ?? []
  if (!prs.length) return undefined
  const named = (session.worktree?.repos.length ?? 0) > 1
  return prs
    .map((pr) => {
      const state =
        pr.checks === "failure" && pr.state !== "merged" ? "Checks failing" : PR_LABELS[pr.state]
      return `${named ? `${pr.repo} ` : "PR "}#${pr.number} · ${state}`
    })
    .join(", ")
}

function StateIcon({ state }: { state: SessionState }) {
  if (state === "working") return <Spinner className="size-4" />
  if (state === "waiting") return <CircleAlertIcon className="size-4 text-warning" />
  if (state === "resolved") return <CheckIcon className="size-4 text-success" />
  return null
}

function SessionItem({
  session,
  state,
  now,
}: {
  session: Conversation
  state: SessionState
  now: number
}) {
  const line2 = prLine(session) ?? session.worktree?.branch ?? session.draft
  return (
    <Link
      to={`/c/${session.id}`}
      className="-mx-2 flex min-h-14 items-center gap-3 rounded-2xl px-2 py-3 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex w-5 shrink-0 items-center justify-center">
        <StateIcon state={state} />
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
 * A titled list that folds away; a finished one (`fold`) longer than `FOLD_OVER` starts folded.
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
  fold?: boolean
  children: ReactNode
}) {
  return (
    <Collapsible defaultOpen={!fold || count <= FOLD_OVER} render={<section aria-label={label} />}>
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
