import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ArrowLeftIcon, CheckIcon, CircleAlertIcon, PlusIcon } from "lucide-react"
import { Link, useLocation, useNavigate, useParams } from "react-router"

import { ChatHeader } from "@/components/chat/chat-header"
import { NewSessionPopup } from "@/components/new-session"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { createConversation, db, type Conversation, type Profile } from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { listLiveRuns, listProjects, type HermesProject, type LiveRunStatus } from "@/lib/hermes"
import { sessionState, type SessionState } from "@/lib/workspace"

/** How often the plugin is asked which sessions have a run in flight, while the screen is on. */
const LIVE_MS = 10_000
const DAY_MS = 86_400_000
const GROUPS: { state: SessionState; label: string }[] = [
  { state: "working", label: "Working" },
  { state: "waiting", label: "Waiting on you" },
  { state: "idle", label: "Idle" },
  { state: "resolved", label: "Resolved" },
]

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
  const passed = (useLocation().state as { project?: HermesProject } | null)?.project
  const profile = useLiveQuery(() => db.profiles.get(profileId), [profileId])
  const [fetched, setFetched] = useState<HermesProject>()
  const [picking, setPicking] = useState(false)
  const project = passed?.id === projectId ? passed : fetched
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
  const sessions = listed?.rows
  const now = listed?.now ?? 0

  // What this device sees of its own turns: a reply streaming, an approval waiting.
  const ids = sessions?.map((c) => c.id) ?? []
  const local = useLiveQuery(async () => {
    const signals: Record<string, { streaming?: boolean; approval?: boolean }> = {}
    if (ids.length === 0) return signals
    const messages = await db.messages.where("conversationId").anyOf(ids).toArray()
    for (const m of messages) {
      const signal = (signals[m.conversationId] ??= {})
      if (m.status === "streaming") signal.streaming = true
      if (m.approval && !m.approval.resolved) signal.approval = true
    }
    return signals
  }, [ids.join("\n")])

  const repos = project?.folders.filter((folder) => folder.git) ?? []
  const canStart = Boolean(profile?.apiKey && project && repos.length > 0)

  const start = async (repoRoot: string) => {
    if (!profile) return
    const conversation = await createConversation(profile.id, {
      title: "New session",
      projectId,
      repoRoot,
    })
    navigate(`/c/${conversation.id}`)
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
            render={<Link to="/code" />}
            nativeButton={false}
            aria-label="Back"
          >
            <ArrowLeftIcon />
          </Button>
        }
      />
      <Tabs defaultValue="sessions" className="flex-1">
        <div className="px-4">
          <TabsList className="mx-auto max-w-2xl">
            <TabsTrigger value="sessions">Sessions</TabsTrigger>
            <TabsTrigger value="library">Library</TabsTrigger>
            <TabsTrigger value="prs">PRs</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="sessions" className="flex flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl flex-1 px-4 py-6">
            {sessions && sessions.length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">No sessions yet.</p>
            ) : (
              <div className="flex flex-col gap-6">
                {grouped.map((group) => (
                  <section key={group.state} aria-label={group.label}>
                    <h2 className="flex items-center gap-3 px-1 pb-1 text-sm text-muted-foreground">
                      <span>
                        {group.label} ({group.sessions.length})
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </h2>
                    <ul>
                      {group.sessions.map((c) => (
                        <li key={c.id}>
                          <SessionItem session={c} state={group.state} now={now} />
                        </li>
                      ))}
                    </ul>
                  </section>
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
                  onClick={() =>
                    repos.length === 1 ? void start(repos[0].path) : setPicking(true)
                  }
                >
                  <PlusIcon /> New session
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
        <TabsContent value="library" />
        <TabsContent value="prs" />
      </Tabs>
      {project && (
        <NewSessionPopup
          open={picking}
          onOpenChange={setPicking}
          project={project}
          onPick={(repoRoot) => {
            setPicking(false)
            void start(repoRoot)
          }}
        />
      )}
    </div>
  )
}

function formatWhen(at: number, now: number) {
  if (now - at < DAY_MS) return formatRelative(at, now)
  return new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })
}

const PR_LABELS = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }

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
  const line2 = session.pr
    ? `PR #${session.pr.number} · ${PR_LABELS[session.pr.state]}`
    : session.worktree?.branch
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
