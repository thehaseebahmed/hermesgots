import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Link, useLocation, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import {
  ArchiveXIcon,
  ArrowLeftIcon,
  BellIcon,
  BellOffIcon,
  CheckIcon,
  EllipsisIcon,
  PencilIcon,
  RotateCcwIcon,
  SettingsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import {
  CATCH_UP_MS,
  HOST_QUEUE_MS,
  PR_PENDING_MS,
  RUNS_MS,
  SAFETY_MS,
  SEND_CAUGHT_UP_MS,
} from "@/lib/freshness"
import { quietly } from "@/lib/report"
import { useBreakReminderEligibility } from "@/components/break-reminder-context"
import { ApprovalCard } from "@/components/chat/approval-card"
import { BotPicker } from "@/components/chat/bot-picker"
import { ChatHeader } from "@/components/chat/chat-header"
import { Composer } from "@/components/chat/composer"
import { MessageItem } from "@/components/chat/message-item"
import { ModelChange } from "@/components/chat/model-change"
import { prLabel } from "@/components/chat/pr-look"
import { PipelinePill, PipelineSheet } from "@/components/chat/pipeline"
import { PrPill } from "@/components/chat/pr-pill"
import { LibraryPill } from "@/components/chat/library-pill"
import { OutputsDrawer } from "@/components/chat/outputs-drawer"
import { QuestionCard } from "@/components/chat/question-card"
import {
  BlockedCard,
  DiscardedCard,
  PlanReadyCard,
  ResolvedCard,
} from "@/components/chat/session-cards"
import { TodosPill, TodosSheet } from "@/components/chat/todos"
import { ModelMenu } from "@/components/chat/model-picker"
import {
  LimitBanner,
  ContextIcon,
  ContextPercent,
  ContextRing,
  UsageSheet,
  type ContextUsage,
} from "@/components/chat/usage-sheet"
import { Bot } from "@/components/bot"
import { RepoChips } from "@/components/repos"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import {
  queueMessage,
  refreshQueue,
  reattachRun,
  sendMessage,
  steerText,
  stopMessage,
} from "@/lib/chat"
import {
  DEFAULT_SETTINGS,
  type Attachment,
  type ModelChoice,
  createConversation,
  db,
  deleteConversation,
  getActiveProfile,
  getMessages,
  updateConversation,
} from "@/lib/db"
import { serverConfig } from "@/lib/connection"
import { describeActivity } from "@/lib/format"
import { supportsSteer, type HermesProject } from "@/lib/hermes"
import { readProjects, useProjects } from "@/lib/projects"
import { caughtUpWithin, loadEarlierHistory, reconcileHistory } from "@/lib/history"
import { contextWindow } from "@/lib/context"
import { useLive, watchChat } from "@/lib/live"
import { useSessionRunning } from "@/lib/waiting"
import { usePoll } from "@/lib/poll"
import { useXLarge, useWide } from "@/lib/media"
import { useCodePane, useRememberOpened } from "@/lib/pane"
import { isBackgroundSafeRunActive } from "@/lib/break-reminders"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { setThreadMuted } from "@/lib/push"
import { useStagedPipeline } from "@/lib/afk-workflows"
import { modelChanges } from "@/lib/model-changes"
import { fullModel, hostChoice, useModelInfo } from "@/lib/model-info"
import { syncContextWindow, useModelCatalog } from "@/lib/models"
import {
  effectiveProvider,
  limitNotice,
  limitNoticeKey,
  refreshProviderUsage,
} from "@/lib/provider-usage"
import {
  planApprovalMessage,
  projectRepos,
  prChecksPending,
  refreshLibrary,
  refreshPrs,
  refreshWorkspace,
  closeSessionWork,
  setSessionMode,
  type RepoRef,
} from "@/lib/workspace"
import { useReadyLine } from "@/lib/greeting"
import { DEFAULT_BOT_ID } from "@/components/bots"
import { useBotThreads } from "@/lib/threads"
import { draftKey } from "@/lib/drafts"
import { AgentsContext, DELEGATE_TOOL, useSessionAgents } from "@/lib/agents"

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/** What a chat or session not started yet says: the greeting, then one of the bot's lines. */
function ReadyLine({ botId, id }: { botId?: string; id?: string }) {
  const { greeting, line } = useReadyLine(botId ?? DEFAULT_BOT_ID, id)
  return (
    <div className="flex max-w-xs flex-col gap-0.5 text-lg font-medium tracking-tight">
      {greeting && <p>{greeting}</p>}
      <p>{line}</p>
    </div>
  )
}

function EmptyState({
  botId,
  configured,
  session,
  id,
}: {
  botId?: string
  configured: boolean
  /** A project session not started yet: the repos it will work in. */
  session?: { repos: RepoRef[] }
  /** The chat or session on screen, none for a new chat. */
  id?: string
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pt-24 pb-8 text-center">
      <Bot id={botId} animate className="size-24" />
      {configured ? (
        <div className="flex max-w-md flex-col items-center gap-3">
          <ReadyLine botId={botId} id={id} />
          {session && <RepoChips repos={session.repos} />}
        </div>
      ) : (
        <>
          <p className="max-w-sm text-sm text-muted-foreground">
            Point Gots at your Hermes Agent API server to start chatting.
          </p>
          <Button nativeButton={false} render={<Link to="/settings" replace />} size="lg">
            <SettingsIcon data-icon="inline-start" />
            Open settings
          </Button>
        </>
      )}
    </div>
  )
}

/** An approval or question card temporarily replaces the composer; once answered, follow the reply again. */
function FollowAfterApproval({ pending }: { pending: boolean }) {
  const { scrollToEnd } = useMessageScroller()
  const wasPending = useRef(pending)
  useEffect(() => {
    if (wasPending.current && !pending) scrollToEnd({ behavior: "smooth" })
    wasPending.current = pending
  }, [pending, scrollToEnd])
  return null
}

/** Sending jumps back to the end, even if you'd scrolled up to read. */
function FollowOnSend({ lastUserId }: { lastUserId?: string }) {
  const { scrollToEnd } = useMessageScroller()
  const previous = useRef(lastUserId)
  useEffect(() => {
    if (lastUserId !== previous.current) scrollToEnd({ behavior: "smooth" })
    previous.current = lastUserId
  }, [lastUserId, scrollToEnd])
  return null
}

export function ChatPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { root, up } = useNav()
  const settings = useLiveQuery(() => db.settings.get("settings"), [])
  const found = useLiveQuery(
    async () => (id ? ((await db.conversations.get(id)) ?? null) : undefined),
    [id],
  )
  // The route is the chat on screen. The live query keeps its last result until the next one is in,
  // so a session swapped in place beside Code's list can still hand back the one before it: nothing
  // of that session may render or be acted on here — its plan card's Approve would send its plan.
  const conversation = found && found.id !== id ? undefined : found
  // A chat talks to its own bot; a new chat goes to the selected one. Same rule as the row above:
  // the query answers with the id it ran for, so a stale answer can't pass for this route's.
  const owners = useLiveQuery(async () => {
    const owner = id ? (await db.conversations.get(id))?.profileId : undefined
    return {
      id,
      profile: ((owner && (await db.profiles.get(owner))) || (await getActiveProfile())) ?? null,
    }
  }, [id])
  const profile = owners && owners.id === id ? owners.profile : undefined
  const threads = useLiveQuery(async () => ({ id, rows: id ? await getMessages(id) : [] }), [id])
  const messages = threads && threads.id === id ? threads.rows : undefined
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [title, setTitle] = useState("")
  const [usageOpen, setUsageOpen] = useState(false)
  // A new chat's pick, held until its first message makes the chat; it follows the chosen bot.
  const [pendingModel, setPendingModel] = useState<{ profileId?: string; choice?: ModelChoice }>()
  const [todosOpen, setTodosOpen] = useState(false)
  const [pipelineOpen, setPipelineOpen] = useState(false)
  const [outputsOpen, setOutputsOpen] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [historyMissing, setHistoryMissing] = useState<string>()

  const resolved = { ...DEFAULT_SETTINGS, ...settings }
  const configured = Boolean(profile?.baseUrl.trim())
  const streaming = messages?.find((m) => m.status === "streaming")
  const busy = Boolean(streaming)
  // Queued messages sit faded at the end of the thread until their turn, whichever clock stamped
  // the turns before them.
  const thread = useMemo(
    () =>
      messages && [
        ...messages.filter((m) => m.status !== "queued"),
        ...messages.filter((m) => m.status === "queued"),
      ],
    [messages],
  )
  // Where this chat's model changed, as the host recorded it: the divider each turn below carries.
  const changes = useMemo(
    () => modelChanges(thread ?? [], conversation?.modelChanges),
    [thread, conversation?.modelChanges],
  )
  // Only a run can be steered, and only on a Hermes that has the route.
  const [steerRoute, setSteerRoute] = useState<{ baseUrl: string; ok: boolean }>()
  const runId = streaming?.runId
  const baseUrl = profile?.baseUrl
  const apiKey = profile?.apiKey
  useEffect(() => {
    if (!runId || baseUrl === undefined) return
    let current = true
    void supportsSteer({ baseUrl, apiKey: apiKey ?? "" }).then(
      (ok) => current && setSteerRoute({ baseUrl, ok }),
    )
    return () => {
      current = false
    }
  }, [runId, baseUrl, apiKey])
  const steerable = Boolean(runId && steerRoute?.baseUrl === baseUrl && steerRoute?.ok)
  // The plugin starts what it holds once nothing runs: follow it in as soon as it does.
  const hostWaiting =
    !busy && Boolean(messages?.some((m) => m.hostQueued && m.status === "queued" && !m.queuePaused))
  useEffect(() => {
    if (!id || !hostWaiting) return
    const timer = window.setInterval(() => void refreshQueue(id), HOST_QUEUE_MS)
    return () => window.clearInterval(timer)
  }, [id, hostWaiting])
  const awaitingApproval = messages?.find((m) => m.approval && !m.approval.resolved)
  const awaitingClarify = messages?.find((m) => m.clarify && !m.clarify.resolved)
  const activity = streaming && describeActivity(streaming)
  // Only the plugin sees each model call; Hermes's API sums a turn's calls, so nothing else is exact.
  const tracked = Boolean(profile?.apiKey && !profile.disabled)
  const live = conversation?.liveContext
  const todos = (tracked && conversation?.todos?.items) || []
  const todoProgress = tracked ? conversation?.todos?.progress : undefined
  // A session of a Hermes Project: works in its worktree, with a mode, a PR and a resolved state.
  const session = conversation?.projectId ? conversation : undefined
  // The files the session filed in its library, as the pill above the composer counts them.
  const outputs = session?.library?.count ?? 0
  // Every pull request the session has, the ones it already finished included, as the drawer lists.
  const prs = session?.prs ?? []
  const firstPrLabel = prs.length ? prLabel(prs[0], prs) : undefined
  // The pipeline a staged task ran in, as its session recorded it. Where the bot's Host stages tasks
  // and this session holds a record the pill marks them; a chat with no record asks it nothing.
  const pipeline = session?.pipeline
  const stagedPipeline = useStagedPipeline(profile, pipeline)
  // A sheet put away because the pipeline went (the switch turned off) stays closed when it returns.
  if (!stagedPipeline && pipelineOpen) setPipelineOpen(false)
  // While a pull request's checks run, read them again every few seconds so the pill turns
  // green (or orange) as soon as they do. Forced, so the freshness gate doesn't skip a tick that
  // lands just inside its window.
  const checksRunning = prChecksPending(session?.prs)
  useEffect(() => {
    if (!id || !checksRunning) return
    const read = () => {
      if (document.visibilityState === "visible") void refreshPrs(id, { force: true })
    }
    read()
    const timer = window.setInterval(read, PR_PENDING_MS)
    return () => window.clearInterval(timer)
  }, [id, checksRunning])
  const modelChoice = conversation
    ? conversation.modelChoice
    : pendingModel?.profileId === profile?.id
      ? pendingModel?.choice
      : undefined
  const chooseModel = (choice: ModelChoice | undefined) => {
    if (conversation) void updateConversation(conversation.id, { modelChoice: choice })
    else setPendingModel({ profileId: profile?.id, choice })
  }
  // The chat's model pill: the composer's, and the plan-ready card's while a plan waits on it.
  const modelPill = (extra: { display?: "pill" | "block"; disabled?: boolean }) =>
    configured && (
      <ModelMenu profile={profile} choice={modelChoice} onChoose={chooseModel} {...extra} />
    )
  // What this chat runs next: its own pick, the bot's default, else what the host last reported.
  const hostInfo = useModelInfo(profile)
  const catalog = useModelCatalog()
  const currentModel =
    modelChoice ?? profile?.modelChoice ?? hostChoice(hostInfo) ?? profile?.hostModel
  const usage: ContextUsage = {
    tracked,
    tokens: tracked ? live?.tokens : undefined,
    // The window belongs to the model the next turn runs, not the one the last call did: a switch
    // shows at once, rather than after the new model's first call.
    window: contextWindow(live, profile ?? undefined, currentModel, catalog),
    model: currentModel ? fullModel(currentModel) : undefined,
  }
  const provider = effectiveProvider(conversation ?? undefined, profile ?? undefined)
  const providerUsage =
    profile?.providerUsage && profile.providerUsage.provider === provider
      ? profile.providerUsage
      : undefined
  const notice = limitNotice(providerUsage)
  const noticeDismissed =
    Boolean(notice && provider) && profile?.limitDismissed === limitNoticeKey(provider!, notice!)

  // Picks up a model changed on the server (only when the connection does, not on every write);
  // the ring follows via the live query.
  const profileId = profile?.id
  useEffect(() => {
    if (!profileId) return
    void db.profiles.get(profileId).then((current) => current && syncContextWindow(current))
  }, [profileId, baseUrl, apiKey])

  // The provider's limits are read when the chat opens and when its provider changes; after that,
  // with the chat's other details at the end of a turn and when it catches up (`followUps`).
  useEffect(() => {
    if (!profileId) return
    void refreshProviderUsage(profileId, provider).catch(quietly("Reading provider limits"))
  }, [profileId, baseUrl, apiKey, provider])

  // The plugin holds a session's mode and pending plan; an empty session never catches up below.
  const sessionId = session?.id
  useEffect(() => {
    if (sessionId) {
      void refreshWorkspace(sessionId)
      void refreshLibrary(sessionId)
    }
  }, [sessionId])

  // A chat synced from another device arrives empty; its transcript is on Hermes.
  const needsHistory =
    Boolean(conversation && conversation.updatedAt > conversation.createdAt) &&
    messages?.length === 0
  const loadingHistory = needsHistory && historyMissing !== id
  useEffect(() => {
    if (!id || !needsHistory) return
    reconcileHistory(id)
      .then((count) => count || setHistoryMissing(id))
      .catch((error) => {
        setHistoryMissing(id)
        toast.error(error instanceof Error ? error.message : "Couldn't load this chat.")
      })
  }, [id, needsHistory])

  // Other devices add turns on Hermes. Catch up when the chat opens, when sync brings news of it,
  // when this tab comes back, and now and then while it's on screen.
  const updatedAt = conversation?.updatedAt
  const hasMessages = (messages?.length ?? 0) > 0
  const unstarted = configured && !hasMessages && !loadingHistory
  // The agents this chat's agent delegated to, for their cards in the thread.
  const delegations = messages
    ?.flatMap((m) => m.tools ?? [])
    .filter((t) => t.tool === DELEGATE_TOOL)
  const agents = useSessionAgents(
    conversation ?? undefined,
    profile,
    Boolean(delegations?.length),
    Boolean(delegations?.some((t) => t.status === "running")),
  )
  const agentsSource = useMemo(
    () => (agents && baseUrl && apiKey ? { agents, server: { baseUrl, apiKey } } : null),
    [agents, baseUrl, apiKey],
  )
  // Only persistent /v1/runs work survives losing the app's connection; legacy streams do not.
  useBreakReminderEligibility(
    isBackgroundSafeRunActive({
      busy,
      runId,
      awaitingApproval: Boolean(awaitingApproval),
      awaitingClarify: Boolean(awaitingClarify),
      resolved: Boolean(conversation?.resolvedAt),
      discarded: Boolean(conversation?.discardedAt),
      blocked: Boolean(conversation?.blocked),
    }),
  )
  // A server that streams its changes says when this chat's session moves; the timer is a net.
  const streamOpen = useLive(profile)
  useEffect(() => (id ? watchChat(id) : undefined), [id])
  // The host's shared answer says at once when a run started elsewhere, which the timer would find
  // only at its next round.
  const hostRuns = useSessionRunning(
    tracked && baseUrl && apiKey ? { baseUrl, apiKey } : undefined,
    conversation?.hermesSessionId,
  )
  // Until the host has written the running turn to its transcript there is nothing to show yet.
  usePoll(() => id && void reattachRun(id).catch(quietly("Following a run")), RUNS_MS, [id], {
    active: Boolean(id && hasMessages && hostRuns && !busy),
    immediate: false,
  })
  usePoll(
    () => {
      if (!id) return
      reattachRun(id).catch(quietly("Reattaching a run"))
      reconcileHistory(id).catch(quietly("Catching up a chat"))
    },
    streamOpen ? SAFETY_MS : CATCH_UP_MS,
    [id, updatedAt, hostRuns, hostRuns && messages?.length],
    { active: Boolean(id && hasMessages) },
  )

  // A session not started yet names the repos it will work in; the project screen hands its project
  // over, and it's read again here regardless.
  const handed = (useLocation().state as { project?: HermesProject } | null)?.project
  const projectId = session?.projectId
  const projects = useProjects(
    projectId && baseUrl && apiKey !== undefined ? { baseUrl, apiKey } : undefined,
  )
  const fetchedProject = projects?.find((p) => p.id === projectId)
  useEffect(() => {
    if (!projectId || hasMessages || !baseUrl || apiKey === undefined) return
    readProjects({ baseUrl, apiKey }).catch(quietly("Reading projects"))
  }, [projectId, hasMessages, baseUrl, apiKey])
  const project = [fetchedProject, handed].find((p) => p && p.id === projectId)
  const sessionRepos: RepoRef[] = session?.worktree?.repos.length
    ? session.worktree.repos
    : project
      ? projectRepos(project)
      : []

  // A deleted (or unknown) conversation id falls back to a fresh chat.
  useEffect(() => {
    if (id && conversation === null) root("/")
  }, [id, conversation, root])

  // A session that was never sent anything isn't kept; typed text is the user's to keep or drop.
  const draftRef = useRef("")
  // Each chat's own, since the chat can change under the composer.
  const drafts = useRef(new Map<string, string>())
  const onDraft = useCallback(
    (text: string) => {
      draftRef.current = text
      if (id) drafts.current.set(id, text)
    },
    [id],
  )
  const [leavingWithDraft, setLeavingWithDraft] = useState(false)
  const unsent =
    session !== undefined && messages?.length === 0 && !(session.updatedAt > session.createdAt)
  const codePath = session && "/code"
  const leave = () => {
    if (!session || !codePath) return
    if (!unsent) return up(codePath)
    if (draftRef.current.trim()) return setLeavingWithDraft(true)
    void deleteConversation(session.id)
    up(codePath)
  }
  const leaveRef = useRef(leave)
  useEffect(() => {
    leaveRef.current = leave
  })
  // Beside Code's list another session can be picked straight away, with no chance to ask, so a
  // session left unsent goes, or is kept as a draft when something was typed.
  const shown = useRef(id)
  useEffect(() => {
    const left = shown.current
    shown.current = id
    if (!left || left === id) return
    const text = drafts.current.get(left)?.trim()
    drafts.current.delete(left)
    void (async () => {
      const row = await db.conversations.get(left)
      if (!row?.projectId || row.draftAt || row.updatedAt > row.createdAt) return
      if (await db.messages.where("conversationId").equals(left).count()) return
      if (text) await updateConversation(left, { draftAt: Date.now() })
      else await deleteConversation(left)
    })()
  }, [id])
  // With bot threads on, a chat is a thread of its bot, which it goes back to.
  const botThreads = useBotThreads()
  const botPath =
    botThreads && conversation && !session ? `/b/${conversation.profileId}` : undefined
  // From `xl` a thread opens beside its bot, which it closes to. A session opens beside Code's list
  // where there's room, and is then a top-level screen with nothing to go back to.
  const xl = useXLarge()
  const wide = useWide()
  const beside = Boolean(useCodePane()) && Boolean(session)
  useRememberOpened("code", session?.id)
  // Beside its bot the header drops the picture, so the reply count sits under the title instead.
  const replyCount = messages?.filter((m) => m.role === "assistant").length ?? 0
  const repliesLine =
    botPath && xl && replyCount
      ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`
      : undefined
  useEffect(() => {
    if (!botPath) return
    return setBackGuard(() => {
      up(botPath)
      return true
    })
  }, [botPath, up])
  // A session sits under Code, unless it's beside it; a plain chat is top-level, so back leaves the
  // app.
  useEffect(() => {
    if (!codePath || beside) return
    return setBackGuard(() => {
      leaveRef.current()
      return true
    })
  }, [codePath, beside])

  /** Before a session is deleted or discarded: its run, worktrees, pull requests and branches. */
  const closeSession = async () => {
    if (!session) return
    stopMessage(session.id)
    const { kept, errors } = await closeSessionWork(session.id)
    for (const tree of kept)
      toast.info(
        `Kept ${tree.name}: it has ${tree.reason === "dirty" ? "uncommitted" : "unpushed"} changes.`,
      )
    for (const error of errors) toast.error(error)
  }

  const send = async (text: string, attachments: Attachment[] = []) => {
    try {
      let conversationId = id
      if (conversationId) {
        // So a reply that builds on another device's latest turn shows after it, not before; a chat
        // that caught up a moment ago doesn't wait again.
        if (!caughtUpWithin(conversationId, SEND_CAUGHT_UP_MS))
          await Promise.race([reconcileHistory(conversationId).catch(() => undefined), wait(1500)])
      } else {
        if (!profile) return
        conversationId = (await createConversation(profile.id, { modelChoice: modelChoice })).id
        navigate(`/c/${conversationId}`, { replace: true, state: { quiet: true } })
      }
      if (session?.draftAt) void updateConversation(conversationId, { draftAt: undefined })
      await sendMessage(conversationId, text, { attachments })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send your message.")
      throw error
    }
  }

  const actions = conversation && (
    <div className="flex items-center gap-2">
      {wide && configured && <ContextRing usage={usage} onClick={() => setUsageOpen(true)} />}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon-lg"
              className="size-11 rounded-full bg-background/80 backdrop-blur"
              aria-label="Chat options"
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {configured && !wide && (
            <>
              <DropdownMenuItem onClick={() => setUsageOpen(true)}>
                <ContextIcon usage={usage} />
                Context
                <ContextPercent usage={usage} />
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            onClick={() => {
              setTitle(conversation.title)
              setRenaming(true)
            }}
          >
            <PencilIcon />
            {session ? "Edit" : "Rename"}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => void setThreadMuted(conversation.id, !conversation.muted)}
          >
            {conversation.muted ? <BellIcon /> : <BellOffIcon />}
            {conversation.muted ? "Unmute notifications" : "Mute notifications"}
          </DropdownMenuItem>
          {session &&
            !session.discardedAt &&
            (session.resolvedAt ? (
              <DropdownMenuItem
                onClick={() => updateConversation(session.id, { resolvedAt: undefined })}
              >
                <RotateCcwIcon />
                Reopen
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onClick={() => updateConversation(session.id, { resolvedAt: Date.now() })}
              >
                <CheckIcon />
                Resolve
              </DropdownMenuItem>
            ))}
          <DropdownMenuSeparator />
          {session && !session.discardedAt && (
            <DropdownMenuItem onClick={() => setDiscarding(true)}>
              <ArchiveXIcon />
              Discard
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ChatHeader
        // Nothing started has no title yet, and its bot is the big one in the middle.
        title={unstarted ? "" : (conversation?.title ?? "New chat")}
        subtitle={unstarted ? undefined : activity || repliesLine || session?.worktree?.branch}
        botId={profile?.botId}
        muted={Boolean(conversation?.muted || profile?.muted)}
        // Beside its bot, which already shows the bot's picture.
        showBot={!(botPath && xl) && !unstarted}
        actions={actions}
        leading={
          botPath ? (
            <Button
              variant="outline"
              size="icon-lg"
              className="size-11 rounded-full bg-background/80 backdrop-blur"
              onClick={() => up(botPath)}
              aria-label={xl ? "Close thread" : `Back to ${profile?.name ?? "bot"}`}
            >
              {xl ? <XIcon /> : <ArrowLeftIcon />}
            </Button>
          ) : (
            session &&
            !beside && (
              <Button
                variant="outline"
                size="icon-lg"
                className="size-11 rounded-full bg-background/80 backdrop-blur"
                onClick={leave}
                aria-label="Back to Code"
              >
                <ArrowLeftIcon />
              </Button>
            )
          )
        }
      />

      {hasMessages ? (
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller className="flex-1">
            <MessageScrollerViewport aria-label="Messages">
              <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-32 pb-6">
                {conversation?.olderThan && (
                  <Button
                    variant="outline"
                    className="min-h-11 self-center rounded-full"
                    disabled={loadingEarlier}
                    onClick={() => {
                      setLoadingEarlier(true)
                      loadEarlierHistory(conversation.id)
                        .catch((error) =>
                          toast.error(
                            error instanceof Error ? error.message : "Couldn't load more.",
                          ),
                        )
                        .finally(() => setLoadingEarlier(false))
                    }}
                  >
                    Load earlier messages
                  </Button>
                )}
                <AgentsContext.Provider value={agentsSource}>
                  {thread!.map((message) => {
                    const change = changes.get(message.id)
                    return (
                      <MessageScrollerItem key={message.id} messageId={message.id}>
                        {change && <ModelChange model={change} />}
                        <MessageItem
                          message={message}
                          showStats
                          busy={busy}
                          showThinking={!session}
                        />
                      </MessageScrollerItem>
                    )
                  })}
                </AgentsContext.Provider>
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
            <FollowAfterApproval pending={Boolean(awaitingApproval || awaitingClarify)} />
            <FollowOnSend lastUserId={thread!.findLast((m) => m.role === "user")?.id} />
          </MessageScroller>
        </MessageScrollerProvider>
      ) : loadingHistory ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-6" />
        </div>
      ) : (
        <EmptyState
          botId={profile?.botId}
          configured={configured}
          session={session && { repos: sessionRepos }}
          id={conversation?.id}
        />
      )}

      <div data-toast-above className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
        {(stagedPipeline || todos.length > 0 || prs.length > 0 || outputs > 0) && (
          // One line, centred; wider than the screen it scrolls, from the first pill.
          <div className="-mx-3 flex [scrollbar-width:none] overflow-x-auto px-3 pb-2 sm:-mx-4 sm:px-4 [&::-webkit-scrollbar]:hidden">
            <div className="mx-auto flex w-max max-w-none min-w-full shrink-0 justify-center gap-2">
              {stagedPipeline && (
                <PipelinePill pipeline={stagedPipeline} onClick={() => setPipelineOpen(true)} />
              )}
              {todos.length > 0 && (
                <TodosPill
                  items={todos}
                  progress={todoProgress}
                  live={busy}
                  onClick={() => setTodosOpen(true)}
                />
              )}
              {outputs === 0 && prs.length === 1 && firstPrLabel ? (
                // One pull request and nothing filed: the pill itself, opening it on GitHub.
                <PrPill pr={prs[0]} label={firstPrLabel} />
              ) : (
                // Anything else there opens the session's outputs drawer, counting both.
                (outputs > 0 || prs.length > 1) && (
                  <LibraryPill count={outputs + prs.length} onClick={() => setOutputsOpen(true)} />
                )
              )}
            </div>
          </div>
        )}
        {!id && profile && !botThreads && (
          <div className="mx-auto flex w-full max-w-3xl pb-2">
            <BotPicker profile={profile} />
          </div>
        )}
        {notice && provider && !noticeDismissed && (
          <div className="mx-auto w-full max-w-3xl pb-2" data-toast-above>
            <LimitBanner
              notice={notice}
              onDismiss={() =>
                profileId &&
                void db.profiles
                  .update(profileId, { limitDismissed: limitNoticeKey(provider, notice) })
                  .catch(() => undefined)
              }
              onView={() => setUsageOpen(true)}
            />
          </div>
        )}
        {session?.discardedAt ? (
          <div className="mx-auto w-full max-w-3xl">
            <DiscardedCard />
          </div>
        ) : session?.resolvedAt ? (
          <div className="mx-auto w-full max-w-3xl">
            <ResolvedCard
              onReopen={() => updateConversation(session.id, { resolvedAt: undefined })}
            />
          </div>
        ) : awaitingApproval ? (
          <div className="mx-auto w-full max-w-3xl">
            <ApprovalCard message={awaitingApproval} />
          </div>
        ) : awaitingClarify ? (
          <div className="mx-auto w-full max-w-3xl">
            <QuestionCard key={awaitingClarify.clarify!.clarifyId} message={awaitingClarify} />
          </div>
        ) : session?.blocked && !busy ? (
          <div className="mx-auto w-full max-w-3xl">
            <BlockedCard reason={session.blocked} />
          </div>
        ) : session?.planPending && session.mode === "plan" && !busy ? (
          <div className="mx-auto w-full max-w-3xl">
            <PlanReadyCard
              autoAvailable={tracked}
              model={modelPill({ display: "block" })}
              onApprove={async (mode) => {
                await setSessionMode(session.id, mode)
                await send(planApprovalMessage(session.planFile))
              }}
              onKeepPlanning={() => setSessionMode(session.id, "plan")}
            />
          </div>
        ) : (
          <Composer
            // Sessions are swapped in place beside Code's list; each keeps its own text.
            key={session?.id}
            busy={busy}
            disabled={!configured}
            draftKey={draftKey(id)}
            onDraft={onDraft}
            onSend={send}
            onQueue={(text, attachments) =>
              id ? queueMessage(id, text, attachments) : send(text, attachments)
            }
            steerByDefault={resolved.steerByDefault}
            canSteer={steerable}
            onSteer={(text) => (id ? steerText(id, text) : send(text))}
            filesAvailable={Boolean(profile?.apiKey)}
            imagesAvailable={profile?.imageInput !== false}
            onStop={() => id && stopMessage(id)}
            onCommand={(command) => root(command === "new" ? (botPath ?? "/") : "/settings")}
            connection={serverConfig(profile)}
            botName={profile?.name}
            dictationHint={[
              conversation?.title,
              project?.name,
              ...sessionRepos.map((repo) => repo.name.split("/").pop()),
            ]
              .filter(Boolean)
              .join(", ")}
            session={
              session && {
                // Without the plugin nothing answers for Auto, so the session runs as Accept edits.
                mode:
                  session.mode === "auto" && !tracked
                    ? "accept_edits"
                    : (session.mode ?? "accept_edits"),
                autoAvailable: tracked,
                onMode: (mode) =>
                  setSessionMode(session.id, mode).catch((error) =>
                    toast.error(
                      error instanceof Error ? error.message : "Couldn't change the mode.",
                    ),
                  ),
              }
            }
            model={modelPill({ disabled: busy })}
          />
        )}
      </div>

      <UsageSheet
        open={usageOpen}
        onOpenChange={setUsageOpen}
        usage={usage}
        providerUsage={providerUsage}
      />
      {stagedPipeline && (
        <PipelineSheet
          open={pipelineOpen}
          onOpenChange={setPipelineOpen}
          pipeline={stagedPipeline}
          prLabel={firstPrLabel}
        />
      )}
      <TodosSheet
        open={todosOpen}
        onOpenChange={setTodosOpen}
        items={todos}
        progress={todoProgress}
        live={busy}
      />
      {session && (
        <OutputsDrawer
          open={outputsOpen}
          onOpenChange={setOutputsOpen}
          session={session}
          config={serverConfig(profile)}
        />
      )}

      <AlertDialog open={renaming} onOpenChange={setRenaming}>
        <AlertDialogContent>
          <form
            className="contents"
            onSubmit={async (event) => {
              event.preventDefault()
              if (id && title.trim())
                await updateConversation(id, { title: title.trim(), titleEdited: true })
              setRenaming(false)
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>{session ? "Edit session" : "Rename chat"}</AlertDialogTitle>
            </AlertDialogHeader>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              aria-label="Chat title"
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction type="submit">Save</AlertDialogAction>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={leavingWithDraft} onOpenChange={setLeavingWithDraft}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Save your draft?</AlertDialogTitle>
            <AlertDialogDescription>
              This session hasn't started. Save the draft to pick it up later, or delete the
              session.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              variant="outline"
              onClick={async () => {
                if (!session || !codePath) return
                await deleteConversation(session.id)
                up(codePath)
              }}
            >
              Delete
            </AlertDialogAction>
            <AlertDialogAction
              onClick={async () => {
                if (!session || !codePath) return
                await updateConversation(session.id, { draftAt: Date.now() })
                up(codePath)
              }}
            >
              Save draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {session ? "Delete this session?" : "Delete this chat?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {session
                ? "Its pull request is closed and its branch deleted on GitHub, and it's removed from the app. Hermes keeps its own copy of the session."
                : "It's removed from this device. Hermes keeps its own copy of the session."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (id) {
                  if (session) await closeSession()
                  else stopMessage(id)
                  await deleteConversation(id)
                }
                setDeleting(false)
                if (codePath) up(codePath)
                else root(botPath ?? "/")
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discarding} onOpenChange={setDiscarding}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this session?</AlertDialogTitle>
            <AlertDialogDescription>
              Its pull request is closed and its branch deleted on GitHub. The session moves to
              Discarded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                if (session) {
                  await closeSession()
                  await updateConversation(session.id, { discardedAt: Date.now() })
                }
                setDiscarding(false)
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
