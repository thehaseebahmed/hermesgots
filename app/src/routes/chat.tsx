import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { Link, useLocation, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import {
  ArchiveXIcon,
  ArrowLeftIcon,
  CheckIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SettingsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { ApprovalCard } from "@/components/chat/approval-card"
import { BotPicker } from "@/components/chat/bot-picker"
import { ChatHeader } from "@/components/chat/chat-header"
import { Composer } from "@/components/chat/composer"
import { MessageItem } from "@/components/chat/message-item"
import { PrPill } from "@/components/chat/pr-pill"
import { QuestionCard } from "@/components/chat/question-card"
import {
  BlockedCard,
  DiscardedCard,
  PlanReadyCard,
  ResolvedCard,
} from "@/components/chat/session-cards"
import { TheseusCard, TheseusPill, TheseusSheet, type SheetView } from "@/components/chat/theseus"
import { TodosPill, TodosSheet } from "@/components/chat/todos"
import { ModelMenu } from "@/components/chat/model-picker"
import {
  ContextIcon,
  ContextPercent,
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
import { describeActivity } from "@/lib/format"
import { listProjects, supportsSteer, type HermesProject } from "@/lib/hermes"
import { loadEarlierHistory, reconcileHistory } from "@/lib/history"
import { SAFETY_MS, useLive, watchChat } from "@/lib/live"
import { useXLarge } from "@/lib/media"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { syncContextWindow } from "@/lib/models"
import {
  planApprovalMessage,
  projectRepos,
  refreshWorkspace,
  closeSessionWork,
  setSessionMode,
  type RepoRef,
} from "@/lib/workspace"
import { SESSION_SUGGESTIONS, SUGGESTIONS } from "@/lib/suggestions"
import { useBotThreads } from "@/lib/threads"
import { useTheseusInfo, useTheseusRun, waitsOnUser } from "@/lib/theseus"
import { AgentsContext, DELEGATE_TOOL, useSessionAgents } from "@/lib/agents"

/** How often an open chat checks Hermes for turns sent from another device. */
const CATCH_UP_MS = 30_000
/** How often an open chat looks for a turn the plugin started from its queue. */
const HOST_QUEUE_POLL_MS = 3000

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

function EmptyState({
  name,
  botId,
  configured,
  session,
  onPick,
}: {
  name: string
  botId?: string
  configured: boolean
  /** A project session: its project's name and the repos it will work in. */
  session?: { title?: string; repos: RepoRef[] }
  onPick: (text: string) => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pt-24 pb-8 text-center">
      <Bot id={botId} animate className="size-24" />
      {session ? (
        <div className="flex max-w-md flex-col items-center gap-3">
          {session.title && (
            <h1 className="text-2xl font-semibold tracking-tight">{session.title}</h1>
          )}
          <RepoChips repos={session.repos} />
        </div>
      ) : (
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">Hey, I'm {name}</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            {configured
              ? "Ask me anything. I can run tools on your machine and I'll ask before doing anything risky."
              : "Point Memento at your Hermes Agent API server to start chatting."}
          </p>
        </div>
      )}
      {configured ? (
        <div className="flex max-w-md flex-wrap justify-center gap-2">
          {(session ? SESSION_SUGGESTIONS : SUGGESTIONS).map((text) => (
            <Button
              key={text}
              variant="outline"
              className="h-auto min-h-10 rounded-full whitespace-normal"
              onClick={() => onPick(text)}
            >
              {text}
            </Button>
          ))}
        </div>
      ) : (
        <Button nativeButton={false} render={<Link to="/settings" replace />} size="lg">
          <SettingsIcon data-icon="inline-start" />
          Open settings
        </Button>
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
  const conversation = useLiveQuery(
    async () => (id ? ((await db.conversations.get(id)) ?? null) : undefined),
    [id],
  )
  // A chat talks to its own bot; a new chat goes to the selected one.
  const profile = useLiveQuery(async () => {
    const owner = id ? (await db.conversations.get(id))?.profileId : undefined
    return ((owner && (await db.profiles.get(owner))) || (await getActiveProfile())) ?? null
  }, [id])
  const messages = useLiveQuery(() => (id ? getMessages(id) : []), [id])
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const [title, setTitle] = useState("")
  const [usageOpen, setUsageOpen] = useState(false)
  // A new chat's pick, held until its first message makes the chat; it follows the chosen bot.
  const [pendingModel, setPendingModel] = useState<{ profileId?: string; choice?: ModelChoice }>()
  const [todosOpen, setTodosOpen] = useState(false)
  const [theseusView, setTheseusView] = useState<SheetView | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [historyMissing, setHistoryMissing] = useState<string>()

  const resolved = { ...DEFAULT_SETTINGS, ...settings }
  const configured = Boolean(profile?.baseUrl.trim())
  const streaming = messages?.find((m) => m.status === "streaming")
  const busy = Boolean(streaming)
  // Queued messages sit faded at the end of the thread until their turn.
  const thread = messages
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
    const timer = window.setInterval(() => void refreshQueue(id), HOST_QUEUE_POLL_MS)
    return () => window.clearInterval(timer)
  }, [id, hostWaiting])
  const awaitingApproval = messages?.find((m) => m.approval && !m.approval.resolved)
  const awaitingClarify = messages?.find((m) => m.clarify && !m.clarify.resolved)
  const activity = streaming && describeActivity(streaming)
  // Only the plugin sees each model call; Hermes's API sums a turn's calls, so nothing else is exact.
  const tracked = Boolean(profile?.apiKey && !profile.disabled)
  const live = conversation?.liveContext
  const todos = (tracked && conversation?.todos?.items) || []
  // A session of a Hermes Project: works in its worktree, with a mode, a PR and a resolved state.
  const session = conversation?.projectId ? conversation : undefined
  // Plain chats hide context use, stats and tool calls unless the user turned that off.
  const simple = !session && resolved.simplifiedChats
  const modelChoice = conversation
    ? conversation.modelChoice
    : pendingModel?.profileId === profile?.id
      ? pendingModel?.choice
      : undefined
  const chooseModel = (choice: ModelChoice | undefined) => {
    if (conversation) void updateConversation(conversation.id, { modelChoice: choice })
    else setPendingModel({ profileId: profile?.id, choice })
  }
  const usage: ContextUsage = {
    tracked,
    tokens: tracked ? live?.tokens : undefined,
    window:
      live?.window ?? (profile?.contextSource === "models.dev" ? profile.contextWindow : undefined),
  }

  // Picks up a model changed on the server (only when the connection does, not on every write);
  // the ring follows via the live query.
  const profileId = profile?.id
  const connection = profile && `${profile.baseUrl}\n${profile.apiKey}`
  useEffect(() => {
    if (!profileId) return
    void db.profiles.get(profileId).then((current) => current && syncContextWindow(current))
  }, [profileId, connection])

  // The plugin holds a session's mode and pending plan; an empty session never catches up below.
  const sessionId = session?.id
  useEffect(() => {
    if (sessionId) void refreshWorkspace(sessionId)
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
  // A Theseus session's run, once its first turn has started it.
  const theseus = useTheseusRun(session, profile, session?.mode === "theseus" && hasMessages)
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
  const theseusInfo = useTheseusInfo(profile)
  // The agent sits in `theseus wait` while it waits, so the turn is still running: busy or not.
  const theseusWaits = theseus && waitsOnUser(theseus)
  // A server that streams its changes says when this chat's session moves; the timer is a net.
  const streamOpen = useLive(profile)
  useEffect(() => (id ? watchChat(id) : undefined), [id])
  useEffect(() => {
    if (!id || !hasMessages) return
    const catchUp = () => {
      if (document.visibilityState !== "visible") return
      reattachRun(id).catch(() => undefined)
      reconcileHistory(id).catch(() => undefined)
    }
    catchUp()
    const timer = window.setInterval(catchUp, streamOpen ? SAFETY_MS : CATCH_UP_MS)
    document.addEventListener("visibilitychange", catchUp)
    window.addEventListener("online", catchUp)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", catchUp)
      window.removeEventListener("online", catchUp)
    }
  }, [id, hasMessages, updatedAt, streamOpen])

  // A session not started yet names the repos it will work in; the project screen hands its project
  // over, and it's read again here regardless.
  const handed = (useLocation().state as { project?: HermesProject } | null)?.project
  const [fetchedProject, setFetchedProject] = useState<HermesProject>()
  const projectId = session?.projectId
  useEffect(() => {
    if (!projectId || hasMessages || !connection) return
    const [baseUrl, apiKey] = connection.split("\n")
    let cancelled = false
    listProjects({ baseUrl, apiKey })
      .then((all) => !cancelled && setFetchedProject(all.find((p) => p.id === projectId)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId, hasMessages, connection])
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
  const projectPath = session && `/code/${session.profileId}/${session.projectId}`
  const leave = () => {
    if (!session || !projectPath) return
    if (!unsent) return up(projectPath)
    if (draftRef.current.trim()) return setLeavingWithDraft(true)
    void deleteConversation(session.id)
    up(projectPath)
  }
  const leaveRef = useRef(leave)
  useEffect(() => {
    leaveRef.current = leave
  })
  // Beside its project another session can be picked straight away, with no chance to ask, so a
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
      if (text) await updateConversation(left, { draft: text, draftAt: Date.now() })
      else await deleteConversation(left)
    })()
  }, [id])
  // With bot threads on, a chat is a thread of its bot, which it goes back to.
  const botThreads = useBotThreads()
  const botPath =
    botThreads && conversation && !session ? `/b/${conversation.profileId}` : undefined
  // From `xl` a session opens beside its project, and a thread beside its bot, which they close to.
  const xl = useXLarge()
  const beside = xl && Boolean(session)
  useEffect(() => {
    if (!botPath) return
    return setBackGuard(() => {
      up(botPath)
      return true
    })
  }, [botPath, up])
  // A session sits under its project; a plain chat is top-level, so back leaves the app.
  useEffect(() => {
    if (!projectPath) return
    return setBackGuard(() => {
      leaveRef.current()
      return true
    })
  }, [projectPath])

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
        // So a reply that builds on another device's latest turn shows after it, not before.
        await Promise.race([reconcileHistory(conversationId).catch(() => undefined), wait(1500)])
      } else {
        if (!profile) return
        conversationId = (await createConversation(profile.id, { modelChoice: modelChoice })).id
        navigate(`/c/${conversationId}`, { replace: true, state: { quiet: true } })
      }
      if (session?.draftAt)
        void updateConversation(conversationId, { draft: undefined, draftAt: undefined })
      await sendMessage(conversationId, text, { attachments })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send your message.")
      throw error
    }
  }

  const actions = conversation && (
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
        {botPath && (
          <DropdownMenuItem onClick={() => root(botPath)}>
            <PlusIcon />
            New thread
          </DropdownMenuItem>
        )}
        {configured && !simple && (
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
  )

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ChatHeader
        title={conversation?.title ?? "New chat"}
        subtitle={(!simple && activity) || session?.worktree?.branch}
        botId={profile?.botId}
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
            session && (
              <Button
                variant="outline"
                size="icon-lg"
                className="size-11 rounded-full bg-background/80 backdrop-blur"
                onClick={leave}
                aria-label={beside ? "Close session" : "Back to project"}
              >
                {beside ? <XIcon /> : <ArrowLeftIcon />}
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
                  {thread!.map((message) => (
                    <MessageScrollerItem key={message.id} messageId={message.id}>
                      <MessageItem
                        message={message}
                        showStats={!simple}
                        simple={simple}
                        botId={profile?.botId}
                        busy={busy}
                        plain={Boolean(session)}
                      />
                    </MessageScrollerItem>
                  ))}
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
          name={profile?.name ?? "Hermes"}
          botId={profile?.botId}
          configured={configured}
          session={session && { title: project?.name, repos: sessionRepos }}
          onPick={(text) => void send(text).catch(() => {})}
        />
      )}

      <div data-toast-above className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
        {(todos.length > 0 || theseus || (session?.prs?.length ?? 0) > 0) && (
          // One line, centred; wider than the screen it scrolls, from the first pill.
          <div className="-mx-3 flex [scrollbar-width:none] overflow-x-auto px-3 pb-2 sm:-mx-4 sm:px-4 [&::-webkit-scrollbar]:hidden">
            <div className="mx-auto flex w-max max-w-none min-w-full shrink-0 justify-center gap-2">
              {theseus ? (
                <TheseusPill run={theseus} onClick={() => setTheseusView({ kind: "run" })} />
              ) : (
                todos.length > 0 && (
                  <TodosPill items={todos} live={busy} onClick={() => setTodosOpen(true)} />
                )
              )}
              {session?.prs?.map((pr) => (
                <PrPill
                  key={pr.repo}
                  pr={pr}
                  named={(session.worktree?.repos.length ?? 0) > 1}
                  className="shrink-0"
                />
              ))}
            </div>
          </div>
        )}
        {!id && profile && !botThreads && (
          <div className="mx-auto flex w-full max-w-3xl pb-2">
            <BotPicker profile={profile} />
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
        ) : theseusWaits ? (
          <div className="mx-auto w-full max-w-3xl">
            <TheseusCard run={theseus} onOpen={setTheseusView} />
          </div>
        ) : session?.planPending && session.mode === "plan" && !busy ? (
          <div className="mx-auto w-full max-w-3xl">
            <PlanReadyCard
              autoAvailable={tracked}
              onApprove={async (mode) => {
                await setSessionMode(session.id, mode)
                await send(planApprovalMessage(session.planFile))
              }}
              onKeepPlanning={() => setSessionMode(session.id, "plan")}
            />
          </div>
        ) : (
          <Composer
            // Sessions are swapped in place beside their project; each keeps its own text.
            key={session?.id}
            busy={busy}
            disabled={!configured}
            draft={session?.draft}
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
            connection={{ baseUrl: profile?.baseUrl ?? "", apiKey: profile?.apiKey ?? "" }}
            botName={profile?.name}
            session={
              session && {
                // Without the plugin nothing answers for Auto, so the session runs as Accept edits.
                mode:
                  session.mode === "auto" && !tracked
                    ? "accept_edits"
                    : (session.mode ?? "accept_edits"),
                autoAvailable: tracked,
                theseus: theseusInfo,
                started: hasMessages,
                onMode: (mode) =>
                  setSessionMode(session.id, mode).catch((error) =>
                    toast.error(
                      error instanceof Error ? error.message : "Couldn't change the mode.",
                    ),
                  ),
              }
            }
            model={
              configured && (
                <ModelMenu
                  profile={profile}
                  choice={modelChoice}
                  onChoose={chooseModel}
                  disabled={busy}
                />
              )
            }
          />
        )}
      </div>

      <UsageSheet open={usageOpen} onOpenChange={setUsageOpen} usage={usage} />
      <TodosSheet open={todosOpen} onOpenChange={setTodosOpen} items={todos} live={busy} />
      {theseus && (
        <TheseusSheet run={theseus} info={theseusInfo} view={theseusView} onView={setTheseusView} />
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
                if (!session || !projectPath) return
                await deleteConversation(session.id)
                up(projectPath)
              }}
            >
              Delete
            </AlertDialogAction>
            <AlertDialogAction
              onClick={async () => {
                if (!session || !projectPath) return
                await updateConversation(session.id, {
                  draft: draftRef.current.trim(),
                  draftAt: Date.now(),
                })
                up(projectPath)
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
                if (projectPath) up(projectPath)
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
