import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { matchPath, useLocation, useNavigate, useParams } from "react-router"
import { toast } from "sonner"

import {
  CATCH_UP_MS,
  HOST_QUEUE_MS,
  PR_PENDING_MS,
  RUNS_MS,
  SAFETY_MS,
  SEND_CAUGHT_UP_MS,
} from "@/lib/freshness"
import { COLUMN_BOX, REPLY_INSET } from "@/lib/layout"
import type { ComposerControls } from "@/chat-next/page"
import { opensOnChatNext } from "@/chat-next/route"
import { prepareTurn, queueTurn, startTurn, steerTurn, triageTurn } from "@/chat-next/turn"
import { quietly } from "@/lib/report"
import { threadCount, threadsLine } from "@/lib/bot-chrome"
import { repoCap, sessionSubtitle } from "@/lib/repo-line"
import { useBreakReminderEligibility } from "@/components/break-reminder-context"
import { ApprovalCard } from "@/components/chat/approval-card"
import { BotPicker } from "@/components/chat/bot-picker"
import { ChatHeader } from "@/components/chat/chat-header"
import { ChatActions, LimitNotice, useChatUsage } from "@/components/chat/chat-actions"
import { FollowAfterApproval, FollowOnSend } from "@/components/chat/follow"
import { useFirstRows } from "@/components/chat/first-rows"
import { Composer } from "@/components/chat/composer"
import { MessageItem } from "@/components/chat/message-item"
import { Compacted, ModelChange } from "@/components/chat/model-change"
import { DayHeading } from "@/components/chat/day-heading"
import { ThreadCard } from "@/components/chat/thread-card"
import { prLabel } from "@/components/chat/pr-look"
import { Cheatsheet } from "@/components/chat/cheatsheet"
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
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScrollerScrollable,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import {
  queueMessage,
  refreshQueue,
  reattachRun,
  sendFromMain,
  settleTriaging,
  sendMessage,
  steerText,
  stopMessage,
  readAfterTurn,
} from "@/lib/chat"
import { windowKey } from "@/lib/history-window"
import {
  DEFAULT_SETTINGS,
  type Attachment,
  type Conversation,
  type Message,
  type ModelChoice,
  createConversation,
  db,
  ensureMainThread,
  getActiveProfile,
  getMessages,
  getSettings,
  mainThreadId,
  mainThreadProfile,
  setActiveProfile,
  updateConversation,
} from "@/lib/db"
import { compactionMarks } from "@/lib/compactions"
import { serverConfig } from "@/lib/connection"
import { describeActivity } from "@/lib/format"
import { supportsSteer, type DelegatedAgent, type HermesProject } from "@/lib/hermes"
import { readProjects, useProjects } from "@/lib/projects"
import {
  caughtUpWithin,
  loadEarlierHistory,
  reconcileHistory,
  refreshChatDetails,
} from "@/lib/history"
import { useLive, watchChat } from "@/lib/live"
import { useLiveRun, useLiveSubagents } from "@/lib/waiting"
import { runFinished } from "@/lib/session-work"
import { usePoll } from "@/lib/poll"
import { useXLarge, useWide } from "@/lib/media"
import { useCodePane, useRememberOpened } from "@/lib/pane"
import { markRead } from "@/lib/read-marks"
import { isBackgroundSafeRunActive } from "@/lib/break-reminders"
import { setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { useStagedPipeline } from "@/lib/afk-workflows"
import { modelChanges } from "@/lib/model-changes"
import { chosenOf, samePick, storedPick } from "@/lib/model-pick"
import { useDraws } from "@/lib/openui-draws"
import {
  planApprovalMessage,
  projectRepos,
  prChecksPending,
  refreshLibrary,
  refreshPrs,
  refreshWorkspace,
  setSessionMode,
  type RepoRef,
} from "@/lib/workspace"
import { lastActivityAt } from "@/lib/session-work"
import { hold, type HoldSlot } from "@/lib/chat-hold"
import { useBotThreads, useThreads } from "@/lib/threads"
import { EmptyState, MainEmptyState } from "@/components/chat/empty-states"
import { isUnsent } from "@/chat-next/unsent"
import { HeaderBack } from "@/components/chat/header-back"
import { useSessionLeave } from "@/components/chat/session-leave"
import { announceMove } from "@/lib/triage"
import { useMainFlow } from "@/components/chat/main-flow"

export { SETUP_COPY } from "@/components/chat/empty-states"
import { dictationHint } from "@/lib/dictation-hint"
import { draftKey } from "@/lib/drafts"
import { AgentsContext, runningAgents, stopSubagents, useSessionAgents } from "@/lib/agents"
import { spawnInFlight } from "@/lib/spawn"
import { usePluginFeature, usePluginFeatureOn } from "@/lib/features"
import { AgentPopup } from "@/components/chat/agent-card"
import { SubagentLine } from "@/components/chat/subagent-line"
import { SubagentsSheet } from "@/components/chat/subagents"

const NO_ROWS: Message[] = []

/** Nothing was sent in a chat of this screen's own store: no turn and no message in its row. */
const hasNoMessages = async (chat: Conversation) =>
  !(chat.updatedAt > chat.createdAt) &&
  (await db.messages.where("conversationId").equals(chat.id).count()) === 0
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

function PendingChat() {
  return (
    <>
      <ChatHeader title="" showBot={false} />
      <div className="flex-1" />
    </>
  )
}

/** Steps one edge gets before the reader has to leave the top and come back. */
const REACH_TRIES = 2

/**
 * The thread's top is the request for its older rows: a compacted chat's live transcript starts at
 * the compaction's summary, and the rows it archived are only in the host's display read, so the
 * window grows there and nowhere else (ADR 0058). A chat whose whole thread fits its pane asks at
 * once, since its top is on screen; one taller than its pane asks when the reader reaches the top.
 */
function LoadOlderWindow({
  cursor,
  enabled,
  loading,
  onLoad,
}: {
  /** The window's edge, which moves as rows land: undefined once the chat's first row is in. */
  cursor?: string
  /** Nothing to ask while the chat's own window is still landing, or a step is already running. */
  enabled: boolean
  loading: boolean
  onLoad: () => void
}) {
  const { start, end } = useMessageScrollerScrollable()
  // The scroller reports its edges as what lies beyond them: `start` is true while anything sits
  // above the pane, `end` likewise below — so a thread that fits its pane is at its top already.
  const atTop = !start
  const fits = atTop && !end
  // Whether the thread has ever been away from its top: a chat's arrival, placed at its newest row,
  // is not the reader reaching for anything.
  const leftTop = useRef(false)
  // Steps asked for at one edge. A step that moved nothing isn't asked for again until the reader
  // leaves the top and returns; one that failed gets a second try, so a blip can't strand the
  // archive behind an edge that never moves.
  const tried = useRef<{ edge?: string; n: number }>({ n: 0 })
  useEffect(() => {
    if (!start) return
    leftTop.current = true
    tried.current = { n: 0 }
  }, [start])
  // The edges are reported as the scroller measures itself, and a chat too short to scroll never
  // reports them at all — so nothing is asked until the pane has been laid out once.
  const [measured, setMeasured] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMeasured(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  const reached = measured && (fits || (atTop && leftTop.current))
  useEffect(() => {
    if (!enabled || loading || !cursor || !reached) return
    if (tried.current.edge !== cursor) tried.current = { edge: cursor, n: 0 }
    if (tried.current.n >= REACH_TRIES) return
    tried.current.n += 1
    onLoad()
  }, [enabled, loading, cursor, reached, onLoad])
  return null
}

const loadChatNext = () => import("@/chat-next/app-view")
const ChatNextThread = lazy(() => loadChatNext().then((m) => ({ default: m.AppChatNextThread })))

interface ChatPageProps {
  chatId?: string
  paneThread?: string
  slot: HoldSlot
}

/**
 * The chat on screen, on chat-next where its Developer switch takes it (ADR 0065) and on the current
 * screen otherwise. The choice is one string, so a write to the chat that changes nothing about it
 * draws nothing again; with the switch off only the settings row is read.
 */
export function ChatPage(props: ChatPageProps) {
  const params = useParams()
  const id = props.chatId ?? params.id
  const verdict = useLiveQuery(async () => {
    const settings = await getSettings()
    const on = Boolean(settings.developer && settings.chatNext)
    if (!on || !id) return `current\n${id}`
    const chat = await db.conversations.get(id)
    const bot = chat ? await db.profiles.get(chat.profileId) : undefined
    const next = opensOnChatNext(on, chat, bot)
    // The chunk loads while the verdict settles, not after the screen is chosen.
    if (next) void loadChatNext()
    return `${next ? "next" : "current"}\n${id}`
  }, [id])
  // While the verdict for a chat just switched to is still out, the screen that drew the last one
  // keeps drawing: the current screen holds the chat it left until the new one is ready.
  const kind = verdict?.split("\n")[0]
  if (kind === "next" && verdict === `next\n${id}` && id)
    return (
      <NextChat
        id={id}
        slot={props.slot}
        pinned={Boolean(props.chatId)}
        paneThread={props.paneThread}
      />
    )
  if (kind === "current") return <CurrentChatPage {...props} />
  return (
    <div
      data-slot="chat-pane"
      data-pane={props.slot}
      className="relative flex min-h-0 flex-1 flex-col"
      inert
    >
      <PendingChat />
    </div>
  )
}

/**
 * A chat drawn by chat-next, under the chat's own header. A bot's Main is drawn as the current screen
 * draws it: under the bot's name and its count of threads, with its threads as cards in its flow,
 * and every message it sends triaged by the host first (ADR 0029); a thread of it leads back to it.
 */
function NextChat({
  id,
  slot,
  pinned,
  paneThread,
}: {
  id: string
  slot: HoldSlot
  /** This instance draws a chat the address may not name: a Main beside its thread. */
  pinned: boolean
  paneThread?: string
}) {
  const chat = useLiveQuery(() => db.conversations.get(id), [id])
  const bot = useLiveQuery(
    async () => (chat ? db.profiles.get(chat.profileId) : undefined),
    [chat?.profileId],
  )
  const ready = Boolean(chat && bot && chat.id === id)
  const botThreads = useBotThreads()
  const { pathname } = useLocation()
  const { root, up } = useNav()
  const routeChat = matchPath("/c/:id", pathname)?.params.id
  const isMain = Boolean(chat?.main)
  const mainOn = Boolean(botThreads && isMain)
  const threadList = useThreads(mainOn ? chat?.profileId : undefined)
  // The thread the address names when this instance is a Main drawn beside it.
  const routeThread =
    pinned && routeChat && routeChat !== id && !mainThreadProfile(routeChat) ? routeChat : undefined
  const mainPath =
    botThreads && chat && !chat.projectId && !isMain
      ? `/c/${mainThreadId(chat.profileId)}`
      : undefined
  const xl = useXLarge()
  const wide = useWide()
  const besideMain = Boolean(mainPath) && xl
  useEffect(() => {
    if (!mainPath) return
    return setBackGuard(() => {
      up(mainPath)
      return true
    })
  }, [mainPath, up])
  // A session is a place in a project: it sits under Code, unless it is drawn beside Code's list,
  // and a session nothing was sent in isn't kept.
  const session = chat?.projectId ? chat : undefined
  const beside = Boolean(useCodePane()) && Boolean(session)
  useRememberOpened("code", session?.id)
  const {
    leave,
    underCode,
    dialog: leaveDialog,
  } = useSessionLeave({
    id,
    session,
    beside,
    unsent: isUnsent,
  })
  // The repos a session not started yet will work in; the project screen hands its project over.
  const handed = (useLocation().state as { project?: HermesProject } | null)?.project
  const projectId = session?.projectId
  const projects = useProjects(
    projectId && bot?.baseUrl && bot.apiKey !== undefined
      ? { baseUrl: bot.baseUrl, apiKey: bot.apiKey }
      : undefined,
  )
  const project = [projects?.find((p) => p.id === projectId), handed].find(
    (p) => p && p.id === projectId,
  )
  const sessionRepos: RepoRef[] = session?.worktree?.repos.length
    ? session.worktree.repos
    : project
      ? projectRepos(project)
      : []
  const unstarted = Boolean(session) && !(session!.updatedAt > session!.createdAt)
  const botBase = bot?.baseUrl
  const botKeyOf = bot?.apiKey
  useEffect(() => {
    if (!projectId || !unstarted || !botBase || botKeyOf === undefined) return
    readProjects({ baseUrl: botBase, apiKey: botKeyOf }).catch(quietly("Reading projects"))
  }, [projectId, unstarted, botBase, botKeyOf])
  const mainOf = isMain ? chat?.profileId : undefined
  useEffect(() => {
    if (mainOf) void setActiveProfile(mainOf)
  }, [mainOf])
  // One component per chat and bot, so the composer keeps its text across the thread's renders:
  // a write to the bot's row hands back a new object, which mustn't remount it.
  const botKey = bot?.id
  const composer = useMemo(
    () =>
      botKey
        ? function ChatNextComposer({ controls }: { controls: ComposerControls }) {
            return (
              <NextComposer
                controls={controls}
                chatId={id}
                botId={botKey}
                main={mainOn}
                home={mainPath}
              />
            )
          }
        : undefined,
    [id, botKey, mainOn, mainPath],
  )
  useLayoutEffect(() => {
    if (ready) hold(slot, id)
  })
  const { usage, providerUsage, notice, provider, noticeDismissed } = useChatUsage(
    chat,
    bot,
    chosenOf(chat?.modelChoice),
  )
  const [usageOpen, setUsageOpen] = useState(false)
  const limit = useMemo(
    () => ({ usage: { notice, provider, noticeDismissed }, onView: () => setUsageOpen(true) }),
    [notice, provider, noticeDismissed],
  )
  const actions = chat && bot && (
    <ChatActions
      chat={chat}
      profile={bot}
      session={session}
      mainChrome={mainOn}
      wide={wide}
      usage={usage}
      providerUsage={providerUsage}
      usageOpen={usageOpen}
      onUsageOpenChange={setUsageOpen}
      onDeleted={() => (session ? up("/code") : root(mainPath ?? "/"))}
    />
  )
  return (
    <LimitContext.Provider value={limit}>
      <div
        data-slot="chat-pane"
        data-pane={slot}
        data-chat-next
        data-code-session={chat?.projectId ? "" : undefined}
        className="relative flex min-h-0 flex-1 flex-col"
        inert={!ready}
      >
        {chat && bot && ready ? (
          <>
            <ChatHeader
              // Main is the bot's face, so its title is the bot's name, which Bot settings edits.
              // A session not started has no title yet, and its bot is the big one in the middle.
              title={unstarted ? "" : mainOn ? bot.name || chat.title : chat.title}
              // The header never follows the reply: what the thread is doing is drawn in the thread.
              subtitle={
                mainOn && threadList
                  ? threadsLine(threadCount(threadList))
                  : session && !unstarted
                    ? sessionSubtitle({
                        botName: bot.name,
                        names: sessionRepos.map((repo) => repo.name),
                        cap: repoCap({ wide, xlarge: xl }),
                      })
                    : undefined
              }
              botId={bot.botId}
              muted={Boolean(chat.muted || bot.muted)}
              centered={Boolean(session) || besideMain}
              showBot={!session && !besideMain}
              actions={actions}
              leading={
                // Beside Main the bot is on screen with the thread; below `xl` the thread leads back.
                // A session leads back to Code, unless it is drawn beside Code's list.
                mainPath && !besideMain ? (
                  <HeaderBack label={`Back to ${bot.name || "bot"}`} onClick={() => up(mainPath)} />
                ) : (
                  underCode && <HeaderBack label="Back to Code" onClick={() => void leave()} />
                )
              }
            />
            <Suspense fallback={null}>
              <ChatNextThread
                key={chat.hermesSessionId}
                chatId={id}
                code={Boolean(chat.projectId)}
                blank={unstarted ? { botId: bot.botId, repos: sessionRepos } : undefined}
                main={
                  mainOn
                    ? {
                        profileId: chat.profileId,
                        botId: bot.botId,
                        openThread: routeThread ?? paneThread,
                        beside: Boolean(routeThread),
                        routeChat,
                      }
                    : undefined
                }
                server={bot.baseUrl}
                apiKey={bot.apiKey}
                session={chat.hermesSessionId}
                prepareTurn={(text, attachments) => prepareTurn(id, text, attachments)}
                queueTurn={async (text, attachments) =>
                  void (await queueTurn(id, text, attachments))
                }
                steerTurn={(text, attachments) => steerTurn(id, text, attachments)}
                // Only Main's messages are triaged; a thread and a project session never are.
                triageTurn={
                  mainOn
                    ? (text, attachments, options) => triageTurn(id, text, attachments, options)
                    : undefined
                }
                // What the plugin holds beside the transcript — the title, the context, the todos, a
                // session's workspace, pull requests and library — read as every chat reads it.
                onSettled={(reason, thread) =>
                  reason === "turn"
                    ? void readAfterTurn(id, { turn: thread.turns })
                    : refreshChatDetails(id)
                }
                Composer={composer}
              />
            </Suspense>
            {leaveDialog}
          </>
        ) : (
          <PendingChat />
        )}
      </div>
    </LimitContext.Provider>
  )
}

/**
 * What the pane knows of the account's limits and how to open the usage sheet, for the composer to
 * warn with: the composer is one component for the chat's life, so it reads this rather than being
 * handed it, and a change in the limits never remounts it.
 */
const LimitContext = createContext<{
  usage: Pick<ReturnType<typeof useChatUsage>, "notice" | "provider" | "noticeDismissed">
  onView: () => void
} | null>(null)

/**
 * The app's composer driving a chat-next thread. A message sent while a reply runs goes to the
 * plugin's queue, or steers the reply where the user asked to; one that can't go is said so and
 * handed back to the field. A project session's own cards take its place in the order the current
 * screen draws them: closed, blocked, then a plan waiting to be approved.
 */
function NextComposer(props: {
  controls: ComposerControls
  chatId: string
  botId: string
  main: boolean
  home?: string
}) {
  const limit = useContext(LimitContext)
  return (
    <>
      {limit && <LimitNotice usage={limit.usage} profileId={props.botId} onView={limit.onView} />}
      <NextPills chatId={props.chatId} botId={props.botId} busy={props.controls.busy} />
      <NextComposerBody {...props} />
    </>
  )
}

/**
 * What the plugin holds for a chat on chat-next, as the current screen shows it above the composer:
 * a staged task's pipeline, the todo list, the session's pull requests and its filed outputs, each
 * opening its sheet. The reads that fill them are the chat's follow-up reads (`onSettled`).
 */
function NextPills({ chatId, botId, busy }: { chatId: string; botId: string; busy: boolean }) {
  const bot = useLiveQuery(() => db.profiles.get(botId), [botId])
  const chat = useLiveQuery(() => db.conversations.get(chatId), [chatId])
  const [todosOpen, setTodosOpen] = useState(false)
  const [pipelineOpen, setPipelineOpen] = useState(false)
  const [outputsOpen, setOutputsOpen] = useState(false)
  const subagents = useLiveSubagents()
  const tracked = Boolean(bot?.apiKey && !bot.disabled)
  const session = chat?.projectId ? chat : undefined
  const stagedPipeline = useStagedPipeline(bot, session?.pipeline)
  if (!stagedPipeline && pipelineOpen) setPipelineOpen(false)
  const checksRunning = prChecksPending(session?.prs)
  useEffect(() => {
    if (!checksRunning) return
    const read = () => {
      if (document.visibilityState === "visible") void refreshPrs(chatId, { force: true })
    }
    read()
    const timer = window.setInterval(read, PR_PENDING_MS)
    return () => window.clearInterval(timer)
  }, [chatId, checksRunning])
  // The session's read mark rides the activity it has seen, as on the current screen.
  const threadId = session?.id
  const activity = session ? lastActivityAt(session) : 0
  useEffect(() => {
    if (threadId) markRead(threadId, activity)
  }, [threadId, activity])
  if (!chat || !bot) return null
  const todos = (tracked && chat.todos?.items) || []
  const progress = tracked ? chat.todos?.progress : undefined
  const outputs = session?.library?.count ?? 0
  const prs = session?.prs ?? []
  const firstPrLabel = prs.length ? prLabel(prs[0], prs) : undefined
  const live = !runFinished({
    live: undefined,
    local: { streaming: busy },
    subagents: subagents[chat.hermesSessionId],
  })
  return (
    <>
      {(stagedPipeline || todos.length > 0 || prs.length > 0 || outputs > 0) && (
        <div className="-mx-3 flex [scrollbar-width:none] overflow-x-auto px-3 pb-2 sm:-mx-4 sm:px-4 [&::-webkit-scrollbar]:hidden">
          <div className="mx-auto flex w-max max-w-none min-w-full shrink-0 justify-center gap-2">
            {stagedPipeline && (
              <PipelinePill pipeline={stagedPipeline} onClick={() => setPipelineOpen(true)} />
            )}
            {todos.length > 0 && (
              <TodosPill
                items={todos}
                progress={progress}
                live={live}
                onClick={() => setTodosOpen(true)}
              />
            )}
            {outputs === 0 && prs.length === 1 && firstPrLabel ? (
              <PrPill pr={prs[0]} label={firstPrLabel} />
            ) : (
              (outputs > 0 || prs.length > 1) && (
                <LibraryPill count={outputs + prs.length} onClick={() => setOutputsOpen(true)} />
              )
            )}
          </div>
        </div>
      )}
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
        progress={progress}
        live={live}
      />
      {session && (
        <OutputsDrawer
          open={outputsOpen}
          onOpenChange={setOutputsOpen}
          session={session}
          config={serverConfig(bot)}
        />
      )}
    </>
  )
}

function NextComposerBody({
  controls,
  chatId,
  botId,
  main,
  home,
}: {
  controls: ComposerControls
  chatId: string
  botId: string
  /** A bot's Main: `/thread` starts a thread of it. */
  main: boolean
  /** Where `/new` goes: a thread's Main, else home. */
  home?: string
}) {
  const { root } = useNav()
  const navigate = useNavigate()
  const bot = useLiveQuery(() => db.profiles.get(botId), [botId])
  const chat = useLiveQuery(() => db.conversations.get(chatId), [chatId])
  const session = chat?.projectId ? chat : null
  const kept = chat?.modelChoice
  // What the dictation hears best with: the chat's title, its project and the repos it works in.
  const projects = useProjects(
    session && bot ? { baseUrl: bot.baseUrl, apiKey: bot.apiKey } : undefined,
  )
  const project = projects?.find((one) => one.id === session?.projectId)
  const repos = session?.worktree?.repos.length
    ? session.worktree.repos
    : project
      ? projectRepos(project)
      : []
  // `/thread` from Main: a thread of its own, with Main's pick and the message as its first turn.
  const startThread = async (text: string, attachments: Attachment[]) => {
    try {
      const from = await db.conversations.get(chatId)
      const thread = await createConversation(botId, { modelChoice: chosenOf(from?.modelChoice) })
      navigate(`/c/${thread.id}`, { state: { bot: botId } })
      if (text.trim() || attachments.length) await startTurn(thread.id, text, attachments)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't start the thread.")
      throw error
    }
  }
  const filesFeature = usePluginFeature(bot, "attachments")
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false)
  const [navShortcuts, setNavShortcuts] = useState(DEFAULT_SETTINGS.navShortcuts)
  const steerByDefault = useLiveQuery(async () => (await getSettings()).steerByDefault, [])
  if (!bot || !chat) return null
  // Without a key nothing on the host answers for Auto, so the session runs as Accept edits.
  const tracked = Boolean(bot.apiKey && !bot.disabled)
  // The chat's model pill: the composer's, and the plan-ready card's while a plan waits on it.
  const chooseModel = (choice: ModelChoice | undefined) => {
    const stored = storedPick(choice)
    // Re-picking the model the chat already holds would wake every query over its row for nothing.
    if (!samePick(kept, stored)) void updateConversation(chatId, { modelChoice: stored })
  }
  const modelPill = (extra: { display?: "pill" | "block"; disabled?: boolean }) =>
    tracked && <ModelMenu profile={bot} choice={chosenOf(kept)} onChoose={chooseModel} {...extra} />
  const said =
    (go: (text: string, attachments: Attachment[]) => Promise<void>) =>
    async (text: string, attachments: Attachment[]) => {
      try {
        await go(text, attachments)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
        throw error
      }
    }
  if (session?.discardedAt) return <DiscardedCard />
  if (session?.resolvedAt)
    return (
      <ResolvedCard onReopen={() => updateConversation(session.id, { resolvedAt: undefined })} />
    )
  if (session?.blocked && !controls.busy) return <BlockedCard reason={session.blocked} />
  if (session?.planPending && session.mode === "plan" && !controls.busy)
    return (
      <PlanReadyCard
        autoAvailable={tracked}
        model={modelPill({ display: "block" })}
        onApprove={async (mode) => {
          await setSessionMode(session.id, mode)
          await controls.send(planApprovalMessage(session.planFile), [])
        }}
        onKeepPlanning={() => setSessionMode(session.id, "plan")}
      />
    )
  return (
    <>
      <Composer
        busy={controls.busy}
        connection={serverConfig(bot)}
        botName={bot.name}
        dictationWords={bot.vocabulary}
        dictationHint={dictationHint({ title: chat.title, project: project?.name, repos })}
        draftKey={draftKey(chatId)}
        filesFeature={filesFeature}
        imagesAvailable={bot.imageInput !== false}
        onSend={controls.send}
        onQueue={said(controls.queue)}
        onSteer={said(controls.steer)}
        canSteer={controls.canSteer}
        model={modelPill({ disabled: controls.busy })}
        steerByDefault={Boolean(steerByDefault)}
        subagentsRunning={controls.subagents}
        onStop={controls.stop}
        session={
          session
            ? {
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
            : undefined
        }
        main={main}
        onCommand={async (command, message) => {
          if (command === "thread")
            return startThread(message?.text ?? "", message?.attachments ?? [])
          if (command === "new") return root(home ?? "/")
          if (command === "settings") return root("/settings")
          if (command === "cheatsheet") {
            const settings = await getSettings().catch(quietly("Reading the cheatsheet's switch"))
            setNavShortcuts(settings?.navShortcuts ?? DEFAULT_SETTINGS.navShortcuts)
            setCheatsheetOpen(true)
          }
        }}
      />
      <Cheatsheet
        open={cheatsheetOpen}
        onOpenChange={setCheatsheetOpen}
        navShortcuts={navShortcuts}
      />
    </>
  )
}

function CurrentChatPage({ chatId, paneThread, slot }: ChatPageProps) {
  const params = useParams()
  const { pathname } = useLocation()
  const id = chatId ?? params.id
  // The id the address names, which differs from this instance's own: a Main drawn beside a
  // thread is keyed to the Main while the address holds the thread.
  const routeChat = matchPath("/c/:id", pathname)?.params.id
  // A message left triaging by a page that closed mid-triage was never sent.
  useEffect(() => {
    if (id) void settleTriaging(id)
  }, [id])
  const navigate = useNavigate()
  const { root, up } = useNav()
  // Settings answer "no row" on a device that never wrote one, so an absent answer is `null` here
  // rather than the `undefined` a query that has not run hands back.
  const settings = useLiveQuery(async () => (await db.settings.get("settings")) ?? null, [])
  const botThreads = useBotThreads()
  const found = useLiveQuery(
    async () => (id ? ((await db.conversations.get(id)) ?? null) : undefined),
    [id],
  )
  // The route is the chat on screen. The live query keeps its last result until the next one is in,
  // so a session swapped in place beside Code's list can still hand back the one before it: nothing
  // of that session may render or be acted on here — its plan card's Approve would send its plan.
  const conversation = found && found.id !== id ? undefined : found
  const gone = id !== undefined && conversation === null
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
  const [usageOpen, setUsageOpen] = useState(false)
  // A new chat's pick, held until its first message makes the chat; it follows the chosen bot.
  const [pendingModel, setPendingModel] = useState<{ profileId?: string; choice?: ModelChoice }>()
  const [todosOpen, setTodosOpen] = useState(false)
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false)
  const [cheatsheetNavShortcuts, setCheatsheetNavShortcuts] = useState(
    DEFAULT_SETTINGS.navShortcuts,
  )
  const [pipelineOpen, setPipelineOpen] = useState(false)
  const [outputsOpen, setOutputsOpen] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  // The window's edge as one value the reach watches: the oldest row this device holds, and which
  // numbering it was found in — each counts its own rows, so both are part of the edge.
  const cursor = conversation?.olderThan ? windowKey(conversation.olderThan) : undefined
  const loadOlder = useCallback(() => {
    if (!id) return
    setLoadingEarlier(true)
    loadEarlierHistory(id)
      .catch((error) => toast.error(error instanceof Error ? error.message : "Couldn't load more."))
      .finally(() => setLoadingEarlier(false))
  }, [id])
  const [historyMissing, setHistoryMissing] = useState<string>()
  const readyRef = useRef<{ id?: string }>(undefined)

  const resolved = { ...DEFAULT_SETTINGS, ...settings }
  const configured = Boolean(profile?.baseUrl.trim())
  const filesFeature = usePluginFeature(profile, "attachments")
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
  const {
    threadList,
    cards,
    flow,
    moved,
    moveThatOpenedThread,
    undo: undoMoveOutMain,
    marker: moveMarker,
  } = useMainFlow({
    chatId: id,
    profileId: conversation?.profileId ?? "",
    thread,
    moves: conversation?.moves,
    on: Boolean(botThreads && conversation?.main),
    listFor: gone ? profile?.id : undefined,
    afterUndo: refreshQueue,
    routeChat,
  })
  const answered =
    settings !== undefined &&
    botThreads !== undefined &&
    (id === undefined || conversation !== undefined) &&
    profile !== undefined &&
    messages !== undefined &&
    (!(botThreads && conversation?.main) || threadList !== undefined)
  const keptReady = readyRef.current !== undefined && readyRef.current.id === id
  const ready = answered || keptReady
  useLayoutEffect(() => {
    if (answered) readyRef.current = { id }
  })
  const { drawn, cut } = useFirstRows(id ?? "", flow, answered)
  // Where this chat's model changed, as the host recorded it: the divider each turn below carries.
  const changes = useMemo(
    () => modelChanges(thread ?? [], conversation?.modelChanges),
    [thread, conversation?.modelChanges],
  )
  // Where the host compacted this chat's context: the first message after each carries a divider above
  // it. One that fell inside a reply is drawn in the reply, where it happened, and not by this.
  const compacted = useMemo(
    () => compactionMarks(thread ?? [], conversation?.compactions),
    [thread, conversation?.compactions],
  )
  const draws = useDraws(thread ?? NO_ROWS, profile)
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
  // The pick the chat's row holds, Default included, for the chat a send creates.
  const keptModel = conversation
    ? conversation.modelChoice
    : pendingModel?.profileId === profile?.id
      ? pendingModel?.choice
      : undefined
  // As the menu reads a pick: the Default row's marker is no pick at all.
  const modelChoice = chosenOf(keptModel)
  const chooseModel = (choice: ModelChoice | undefined) => {
    const stored = storedPick(choice)
    if (!conversation) return setPendingModel({ profileId: profile?.id, choice: stored })
    // Re-picking the model the chat already holds would wake every query over its row for nothing.
    if (samePick(conversation.modelChoice, stored)) return
    void updateConversation(conversation.id, { modelChoice: stored })
  }
  // The chat's model pill: the composer's, and the plan-ready card's while a plan waits on it.
  const modelPill = (extra: { display?: "pill" | "block"; disabled?: boolean }) =>
    configured && (
      <ModelMenu profile={profile} choice={modelChoice} onChoose={chooseModel} {...extra} />
    )
  // What this chat runs next: its own pick, the bot's default, else what the host last reported.
  const { usage, provider, providerUsage, notice, noticeDismissed } = useChatUsage(
    conversation,
    profile,
    modelChoice,
  )
  const profileId = profile?.id

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
  const hasCards = Boolean(cards && (cards.before.size || cards.trailing.length))
  const unstarted = !gone && configured && !hasMessages && !hasCards && !loadingHistory
  // The agents this chat's agent delegated to, for their cards in the thread. Only a call that set a
  // subagent to work turns the poll on: a list, steer or stop runs no agent to wait for (ADR 0053).
  const spawning = useMemo(() => spawnInFlight(messages), [messages])
  const agents = useSessionAgents(conversation ?? undefined, profile, spawning, busy)
  const subagentsRunning = useMemo(() => runningAgents(agents).length, [agents])
  // The count is drawn once, by whichever row is last: the reply's own while it streams, else the foot.
  const lastId = thread?.at(-1)?.id
  const drawsInline = subagentsRunning > 0 && streaming?.id === lastId
  const [agentView, setAgentView] = useState<DelegatedAgent>()
  const [agentsOpen, setAgentsOpen] = useState(false)
  const showSubagents = useCallback(() => setAgentsOpen(true), [setAgentsOpen])
  const agentsSource = useMemo(
    () =>
      agents && baseUrl && apiKey
        ? {
            agents,
            server: { baseUrl, apiKey },
            sessionId: conversation?.hermesSessionId,
            onOpen: (agent: DelegatedAgent) => setAgentView(agent),
          }
        : null,
    [agents, baseUrl, apiKey, conversation?.hermesSessionId, setAgentView],
  )
  const hostStopsAll = usePluginFeatureOn(profile, "subagents_stop_all")
  const stopEverything = useCallback(async () => {
    if (!id) return
    stopMessage(id)
    if (!agentsSource?.sessionId) return
    try {
      await stopSubagents(agentsSource.server, agentsSource.sessionId, agentsSource.agents, {
        stopAll: hostStopsAll,
      })
    } catch {
      // A subagent the host declined says why on its own card; only a call that never landed has
      // nowhere to say it.
      toast.error("Couldn't stop the subagents.")
    }
  }, [id, agentsSource, hostStopsAll])
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
  // only at its next round. Run-scoped on purpose: `reattachRun` only ever picks up a run of this
  // session (`adoptRun` bails on `knownLiveRun`), so a chat whose turn has ended and whose subagents
  // still work has nothing here to reattach — its work reads `working` from the state rule
  // (`session-work.ts`), a finished delivery draws nothing in the thread, and the composer stays the
  // user's. The wake turn it starts is a run: it is followed here once the host lists it.
  const runStatus = useLiveRun(
    tracked && baseUrl && apiKey ? { baseUrl, apiKey } : undefined,
    conversation?.hermesSessionId,
  )
  const hostRuns = Boolean(runStatus)
  // What the run still has to do is read from one answer, the rule the plugin holds its
  // run-finished push to as well: the run has ended and no subagent it left at work still runs.
  // Neither half alone says it — a delegation outlives the turn that dispatched it, and a run
  // started elsewhere lists before this device streams a word of it.
  const subagents = useLiveSubagents()
  const runLive = !runFinished({
    live: runStatus,
    local: { streaming: busy },
    subagents: conversation ? subagents[conversation.hermesSessionId] : undefined,
  })
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

  const mainOf = conversation?.main ? conversation.profileId : undefined
  useEffect(() => {
    if (mainOf) void setActiveProfile(mainOf)
  }, [mainOf])

  const mainOwner = id ? mainThreadProfile(id) : undefined
  useEffect(() => {
    if (!id || conversation !== null || !mainOwner || !botThreads) return
    void db.profiles
      .get(mainOwner)
      .then((owner) => (owner ? ensureMainThread(mainOwner) : root("/")))
  }, [id, conversation, root, botThreads, mainOwner])

  const isMain = Boolean(conversation?.main)
  // The thread the address itself names, when this instance is a bot's Main drawn beside it: a
  // Main id is never a thread, so a Main drawn beside another Main carries no item of its own.
  const routeThread =
    chatId && routeChat && routeChat !== id && !mainThreadProfile(routeChat) ? routeChat : undefined
  const mainPath =
    botThreads && conversation && !session && !isMain
      ? `/c/${mainThreadId(conversation.profileId)}`
      : undefined
  // `beside` stays on the address alone, so a card tapped from Main still pushes a history entry
  // Back can return to, while the thread the pane really holds is still the one marked open.
  const openThread = routeThread ?? (isMain ? paneThread : undefined)
  // A session opens beside Code's list where there's room, and is then a top-level screen with
  // nothing to go back to.
  const xl = useXLarge()
  const wide = useWide()
  const besideMain = Boolean(mainPath) && xl
  const beside = Boolean(useCodePane()) && Boolean(session)
  useRememberOpened("code", session?.id)
  const codePath = session && "/code"
  const {
    leave,
    underCode,
    dialog: leaveDialog,
  } = useSessionLeave({
    id,
    session,
    beside,
    unsent: hasNoMessages,
  })
  // This device has the session's thread on screen as of now — its read mark, written when the
  // thread renders and again while new activity lands in front of the reader, which is what clears
  // the row's unread dot (never synced: a mark is about where the reader was sitting).
  const threadId = session?.id
  const sessionActivity = session ? lastActivityAt(session) : 0
  // The mark rides the activity it has seen, not the wall clock: a re-render with nothing new
  // writes nothing, and the list's dot still clears.
  useEffect(() => {
    if (threadId) markRead(threadId, sessionActivity)
  }, [threadId, sessionActivity])
  // A thread beside Main says how many replies it has under its title.
  const replyCount = messages?.filter((m) => m.role === "assistant").length ?? 0
  const repliesLine =
    mainPath && xl && replyCount
      ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`
      : undefined
  useEffect(() => {
    if (!mainPath) return
    return setBackGuard(() => {
      up(mainPath)
      return true
    })
  }, [mainPath, up])

  // Main's messages are triaged even while its reply runs, so one for another thread goes there at
  // once; the rest steer or queue behind the reply.
  const sendMidReply = (id: string, steer: boolean, text: string, attachments: Attachment[] = []) =>
    sendFromMain(id, text, attachments, { steer })
      .then(announceMove)
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Couldn't send your message.")
      })

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
        conversationId = (await createConversation(profile.id, { modelChoice: keptModel })).id
        navigate(`/c/${conversationId}`, { replace: true, state: { quiet: true } })
      }
      if (session?.draftAt) void updateConversation(conversationId, { draftAt: undefined })
      // Main's messages are triaged by the host first; a thread and a new chat never are.
      if (conversation?.main)
        await announceMove(await sendFromMain(conversationId, text, attachments))
      else await sendMessage(conversationId, text, { attachments })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send your message.")
      throw error
    }
  }

  const startThread = async (text: string, attachments: Attachment[] = []) => {
    if (!profile || !conversation?.main) return
    try {
      // A pick made in Main comes with the thread; the Default row's marker doesn't, or the thread
      // would follow the default without ever fixing the model it started on.
      const thread = await createConversation(profile.id, { modelChoice: chosenOf(keptModel) })
      navigate(`/c/${thread.id}`, { state: { bot: profile.id } })
      if (text.trim() || attachments.length) await sendMessage(thread.id, text, { attachments })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't start the thread.")
      throw error
    }
  }

  const openCheatsheet = async () => {
    const navShortcuts = await getSettings()
      .then((settings) => settings.navShortcuts)
      .catch(quietly("Reading the cheatsheet's navigation switch"))
    setCheatsheetNavShortcuts(navShortcuts ?? DEFAULT_SETTINGS.navShortcuts)
    setCheatsheetOpen(true)
  }

  const mainChrome = Boolean(botThreads && isMain && profile)
  const actions = conversation && (
    <ChatActions
      chat={conversation}
      profile={profile}
      session={session}
      mainChrome={mainChrome}
      wide={wide}
      usage={usage}
      providerUsage={providerUsage}
      usageOpen={usageOpen}
      onUsageOpenChange={setUsageOpen}
      onDeleted={() => (codePath ? up(codePath) : root(mainPath ?? "/"))}
    />
  )

  // A session is a place in a project, and a thread beside Main is a place within the bot, so both
  // are centred; the bot's own face reads from the left.
  const centered = Boolean(session) || besideMain
  // Nothing started has no title yet, and its bot is the big one in the middle. Main is the bot's
  // face, so its title is the bot's name rather than the `Main` its record is stored under: the
  // name Bot settings edits, so a rename shows here at once.
  // A chat that answered gone keeps the title it is still known by: Main is its bot's name, and a
  // thread is the one the list this device last read carries for it. Nothing once that list has
  // nothing left — a gone chat is never drawn as a new one, and its header standing empty is the
  // honest answer. The scan runs only on the branch that draws it.
  const goneTitle = !gone
    ? ""
    : mainOwner
      ? (profile?.name ?? "")
      : (threadList?.find((one) => one.chat.id === id)?.chat.title ?? "")
  const headerTitle = gone
    ? goneTitle
    : unstarted
      ? ""
      : isMain
        ? profile?.name || conversation?.title || ""
        : (conversation?.title ?? "New chat")
  const mainLine =
    botThreads && isMain && threadList ? threadsLine(threadCount(threadList)) : undefined
  let subtitle: string | undefined
  if (!unstarted)
    subtitle = session
      ? sessionSubtitle({
          activity,
          botName: profile?.name,
          names: sessionRepos.map((repo) => repo.name),
          cap: repoCap({ wide, xlarge: xl }),
        })
      : activity || mainLine || repliesLine

  const frame = ready ? (
    <>
      <ChatHeader
        title={headerTitle}
        subtitle={subtitle}
        botId={profile?.botId}
        muted={Boolean(conversation?.muted || profile?.muted)}
        centered={centered}
        // A chat is with its bot, so its picture stays — until the bot is drawn beside its own
        // thread, where the picture is Main's and the thread is within it.
        showBot={!session && !unstarted && !besideMain}
        actions={actions}
        leading={
          mainPath
            ? // Beside Main a thread needs no control of its own: the bot is on screen with it, and
              // the pane keeps the thread wherever the address goes. Below `xl` it is a screen over
              // Main, and leads back to it.
              !besideMain && (
                <HeaderBack
                  label={`Back to ${profile?.name ?? "bot"}`}
                  onClick={() => up(mainPath)}
                />
              )
            : underCode && <HeaderBack label="Back to Code" onClick={() => void leave()} />
        }
      />

      {hasMessages || hasCards || (thread && moved.trailing.length) ? (
        <MessageScrollerProvider key={id ?? "new"} autoScroll defaultScrollPosition="end">
          <MessageScroller className="flex-1">
            <MessageScrollerViewport aria-label="Messages">
              <MessageScrollerContent
                // A cut chat's rows sit at the end, where they will be once the rows above land.
                className={
                  cut ? "w-full justify-end gap-6 px-4 pt-32 pb-6" : "w-full gap-6 px-4 pt-32 pb-6"
                }
              >
                {!cut && loadingEarlier && (
                  <div className="flex shrink-0 justify-center py-2" aria-hidden>
                    <Spinner className="size-4 text-muted-foreground" />
                  </div>
                )}
                <AgentsContext.Provider value={agentsSource}>
                  {drawn.map((entry) => {
                    if (entry.kind === "heading")
                      return <DayHeading key={`day-${entry.at}`} day={entry.day} />
                    if (entry.kind === "card")
                      return (
                        <ThreadCard
                          key={`card-${entry.thread.chat.id}`}
                          thread={entry.thread}
                          botId={profile?.botId}
                          profileId={conversation?.profileId ?? ""}
                          open={entry.thread.chat.id === openThread}
                          beside={Boolean(routeThread)}
                          current={entry.thread.chat.id === routeChat}
                          move={moveThatOpenedThread.get(entry.thread.chat.id)}
                          onUndo={undoMoveOutMain}
                        />
                      )
                    const message = entry.message
                    const change = changes.get(message.id)
                    return (
                      <MessageScrollerItem key={message.id} messageId={message.id}>
                        {moved.before.get(message.id)?.map(moveMarker)}
                        {compacted.before.has(message.id) && (
                          <Compacted compaction={compacted.before.get(message.id)!} />
                        )}
                        {change && <ModelChange model={change} />}
                        <MessageItem
                          message={message}
                          showStats
                          busy={busy}
                          subagents={message.id === lastId ? subagentsRunning : undefined}
                          onShowSubagents={showSubagents}
                          subagentsInline={message.id === lastId && drawsInline}
                          blocks={draws.get(message.id)}
                          // Only a row that draws a seam reads these: a new array on every
                          // conversation write would wake every row's memo.
                          compactions={
                            message.seams?.length ? conversation?.compactions : undefined
                          }
                        />
                      </MessageScrollerItem>
                    )
                  })}
                  {compacted.trailing && <Compacted compaction={compacted.trailing} />}
                  {moved.trailing.map(moveMarker)}
                  {subagentsRunning > 0 && !drawsInline && (
                    <div className={`${COLUMN_BOX} ${REPLY_INSET}`}>
                      <SubagentLine count={subagentsRunning} onOpen={showSubagents} />
                    </div>
                  )}
                </AgentsContext.Provider>
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
            <FollowAfterApproval pending={Boolean(awaitingApproval || awaitingClarify)} />
            <FollowOnSend lastUserId={thread!.findLast((m) => m.role === "user")?.id} />
            <LoadOlderWindow
              cursor={cursor}
              enabled={answered && !cut}
              loading={loadingEarlier}
              onLoad={loadOlder}
            />
          </MessageScroller>
        </MessageScrollerProvider>
      ) : loadingHistory ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-6" />
        </div>
      ) : conversation?.main && botThreads && configured ? (
        <MainEmptyState botId={profile?.botId} id={conversation?.id} onSend={send} />
      ) : (
        <EmptyState
          botId={profile?.botId}
          configured={configured}
          session={session && { repos: sessionRepos }}
          id={conversation?.id}
          line={!gone}
        />
      )}

      <div
        data-slot="composer-slot"
        data-toast-above
        className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4"
      >
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
                  live={runLive}
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
          <div className={`${COLUMN_BOX} flex pb-2`}>
            <BotPicker profile={profile} />
          </div>
        )}
        <LimitNotice
          usage={{ notice, provider, noticeDismissed }}
          profileId={profileId}
          onView={() => setUsageOpen(true)}
        />
        {session?.discardedAt ? (
          <DiscardedCard />
        ) : session?.resolvedAt ? (
          <ResolvedCard
            onReopen={() => updateConversation(session.id, { resolvedAt: undefined })}
          />
        ) : awaitingApproval ? (
          <ApprovalCard message={awaitingApproval} />
        ) : awaitingClarify ? (
          <QuestionCard key={awaitingClarify.clarify!.clarifyId} message={awaitingClarify} />
        ) : session?.blocked && !busy ? (
          <BlockedCard reason={session.blocked} />
        ) : session?.planPending && session.mode === "plan" && !busy ? (
          <PlanReadyCard
            autoAvailable={tracked}
            model={modelPill({ display: "block" })}
            onApprove={async (mode) => {
              await setSessionMode(session.id, mode)
              await send(planApprovalMessage(session.planFile))
            }}
            onKeepPlanning={() => setSessionMode(session.id, "plan")}
          />
        ) : (
          <Composer
            // Sessions are swapped in place beside Code's list; each keeps its own text.
            key={session?.id}
            busy={busy}
            disabled={!configured}
            draftKey={draftKey(id)}
            onSend={send}
            onQueue={(text, attachments) => {
              if (!id) return send(text, attachments)
              if (conversation?.main) return sendMidReply(id, false, text, attachments)
              void queueMessage(id, text, attachments)
            }}
            steerByDefault={resolved.steerByDefault}
            canSteer={steerable}
            onSteer={(text, attachments) =>
              id
                ? conversation?.main
                  ? sendMidReply(id, true, text, attachments)
                  : steerText(id, text, attachments)
                : send(text, attachments)
            }
            filesFeature={filesFeature}
            imagesAvailable={profile?.imageInput !== false}
            subagentsRunning={subagentsRunning}
            onStop={() => void stopEverything()}
            main={Boolean(botThreads && isMain)}
            onCommand={(command, message) => {
              switch (command) {
                case "thread":
                  return startThread(message?.text ?? "", message?.attachments ?? [])
                case "new":
                  return root(mainPath ?? "/")
                case "settings":
                  return root("/settings")
                case "cheatsheet":
                  return openCheatsheet()
                default: {
                  const unhandled: never = command
                  return unhandled
                }
              }
            }}
            connection={serverConfig(profile)}
            botName={profile?.name}
            dictationWords={profile?.vocabulary}
            dictationHint={dictationHint({
              title: conversation?.title,
              project: project?.name,
              repos: sessionRepos,
            })}
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
        live={runLive}
      />
      <SubagentsSheet
        open={agentsOpen}
        onOpenChange={setAgentsOpen}
        source={agentsSource ?? undefined}
      />
      <AgentPopup
        agent={agentView}
        server={serverConfig(profile)}
        open={agentView !== undefined}
        onOpenChange={(next) => !next && setAgentView(undefined)}
      />
      <Cheatsheet
        open={cheatsheetOpen}
        onOpenChange={setCheatsheetOpen}
        navShortcuts={cheatsheetNavShortcuts}
      />
      {session && (
        <OutputsDrawer
          open={outputsOpen}
          onOpenChange={setOutputsOpen}
          session={session}
          config={serverConfig(profile)}
        />
      )}

      {leaveDialog}
    </>
  ) : null

  useLayoutEffect(() => {
    if (ready) hold(slot, id)
  })

  return (
    <div
      data-slot="chat-pane"
      data-pane={slot}
      className="relative flex min-h-0 flex-1 flex-col"
      inert={!ready}
    >
      {ready ? frame : <PendingChat />}
    </div>
  )
}
