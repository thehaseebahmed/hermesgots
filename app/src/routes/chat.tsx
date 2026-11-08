import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { XIcon } from "lucide-react"
import { matchPath, Navigate, useLocation, useNavigate, useParams } from "react-router"
import { toast } from "sonner"

import {
  CATCH_UP_MS,
  CHAT_IDLE_MS,
  HOST_QUEUE_MS,
  PR_PENDING_MS,
  RUNS_MS,
  SAFETY_MS,
  SEND_CAUGHT_UP_MS,
} from "@/lib/freshness"
import { equal } from "@/lib/equal"
import { listsAsChat } from "@/lib/lists-as-chat"
import { pausedQueue, type PendingQueue } from "@/lib/pending"
import { COLUMN_BOX } from "@/lib/layout"
import { opensOnBlank, opensOnChatNext } from "@/chat-next/route"
import { noteFailure, quietly } from "@/lib/report"
import { awayLine } from "@/lib/away"
import { useOnline } from "@/lib/online"
import { threadCount, threadsLine } from "@/lib/bot-chrome"
import { repoCap, sessionSubtitle } from "@/lib/repo-line"
import { useBreakReminderEligibility } from "@/components/break-reminder-context"
import { ApprovalCard } from "@/components/chat/approval-card"
import { BotPicker } from "@/components/chat/bot-picker"
import { ChatHeader } from "@/components/chat/chat-header"
import { CODE_FACE, CodeFaceProvider } from "@/components/chat/code-face"
import { ChatActions, LimitNotice, useChatUsage } from "@/components/chat/chat-actions"
import { FollowAfterApproval, FollowOnSend } from "@/components/chat/follow"
import { useFirstRows } from "@/components/chat/first-rows"
import { Composer } from "@/components/chat/composer"
import { MessageItem } from "@/components/chat/message-item"
import { ModelChange } from "@/components/chat/model-change"
import { DayHeading } from "@/components/chat/day-heading"
import { PreviewerProvider } from "@/components/chat/previewer"
import { ThreadCard } from "@/components/chat/thread-card"
import { prLabel } from "@/components/chat/pr-look"
import { Cheatsheet, useCheatsheet } from "@/components/chat/cheatsheet"
import { PrPill } from "@/components/chat/pr-pill"
import { LibraryPill } from "@/components/chat/library-pill"
import { OutputsDrawer } from "@/components/chat/outputs-drawer"
import { QuestionCard } from "@/components/chat/question-card"
import {
  BlockedCard,
  DiscardedCard,
  PlanReadyCard,
  QueuePausedCard,
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
  readPending,
  discardLostTurn,
  HOST_QUEUE_SETTLE_MS,
  refreshQueue,
  reattachRun,
  sendFromMain,
  settleTriaging,
  sendMessage,
  steerText,
  stopMessage,
} from "@/lib/chat"
import { windowKey } from "@/lib/history-window"
import {
  DEFAULT_SETTINGS,
  type Attachment,
  type Conversation,
  type Message,
  type ModelChoice,
  db,
  ensureMainThread,
  getActiveProfile,
  getMessages,
  mainThreadId,
  mainThreadProfile,
  setActiveProfile,
  updateConversation,
} from "@/lib/db"
import { compactionMarks } from "@/lib/compactions"
import { summaryKeyOf, summaryRowsOfKey } from "@/lib/compaction-seam"
import { serverConfig } from "@/lib/connection"
import { describeActivity } from "@/lib/format"
import { supportsSteer, type DelegatedAgent, type HermesProject } from "@/lib/hermes"
import { readProjects, useProjects } from "@/lib/projects"
import { caughtUpWithin, loadEarlierHistory, reconcileHistory } from "@/lib/history"
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
import { beginThread, takeHandover, useBotThreads, useThreads } from "@/lib/threads"
import { EmptyState, MainEmptyState, MissingThread } from "@/components/chat/empty-states"
import type { DiagReadFailure } from "@/lib/read-failure"
import { describeReadFailure, formatReadFailure } from "@/lib/read-failure"
import { reportUnreadThread } from "@/lib/sentry"
import { ChatBody } from "@/chat-next/chat-body"
import { isUnsent } from "@/chat-next/unsent"
import { BackButton } from "@/components/back-button"
import { useSessionLeave } from "@/components/chat/session-leave"
import { announceMove } from "@/lib/triage"
import { useMainFlow } from "@/components/chat/main-flow"

export { SETUP_COPY } from "@/components/chat/empty-states"
import { dictationHint } from "@/lib/dictation-hint"
import { draftKey } from "@/lib/drafts"
import { AgentsContext, runningAgents, stopSubagents, useSessionAgents } from "@/lib/agents"
import { spawnInFlight } from "@/lib/spawn"
import { carriesCount } from "@/lib/thinking"
import { usePluginFeature, usePluginFeatureOn } from "@/lib/features"
import { AgentPopup } from "@/components/chat/agent-card"
import { StatusLine } from "@/components/chat/status-line"
import { SubagentCount } from "@/components/chat/subagent-count"
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
const loadBlankChat = () => import("@/chat-next/blank")
const ChatNextBlank = lazy(() => loadBlankChat().then((m) => ({ default: m.ChatNextBlank })))
const loadRoomChat = () => import("@/components/room/room-chat")
const RoomChat = lazy(() => loadRoomChat().then((m) => ({ default: m.RoomChat })))

interface ChatPageProps {
  chatId?: string
  paneThread?: string
  slot: HoldSlot
  /**
   * Puts the thread beside Main away, wherever the lane holds one: the thread's header draws it as
   * the close cross, and where the address names that thread it comes back to Main instead.
   * Absent where closing can't take effect.
   */
  closeThread?: () => void
}

/**
 * The chat on screen, on chat-next when its bot can be called (ADR 0065) and on the current screen
 * otherwise — a chat whose bot has no address or no key. A new chat with a bot it can call opens on
 * chat-next's blank surface, which makes the record on its first send. The choice is one string, so
 * a write to the chat that changes nothing about it draws nothing again.
 */
export function ChatPage(props: ChatPageProps) {
  const params = useParams()
  const id = props.chatId ?? params.id
  const verdict = useLiveQuery(async () => {
    const chat = id ? await db.conversations.get(id) : undefined
    // A canvas's chat is no chat: its address opens the canvas it belongs to (ADR 0113).
    if (chat?.canvasId) return `canvas\n${chat.canvasId}`
    // A room is no bot's chat either: its own screen reads the Host's log, and its address is the
    // chat's because back, deep links and the sidebar's highlight already work there (ADR 0116).
    if (chat?.room) {
      void loadRoomChat()
      return `room\n${id}`
    }
    const bot = chat
      ? await db.profiles.get(chat.profileId)
      : id
        ? undefined
        : await getActiveProfile()
    // A chat with no record yet, whose bot can be called: chat-next's blank surface, named by the
    // bot it would go to, since a pick of another bot draws another one.
    if (bot && opensOnBlank(id, bot)) {
      // The chunk loads while the verdict settles, not after the screen is chosen.
      void loadBlankChat()
      return `blank\n${bot.id}`
    }
    const next = opensOnChatNext(chat, bot)
    // The chunk loads while the verdict settles, not after the screen is chosen.
    if (next) void loadChatNext()
    return `${next ? "next" : "current"}\n${id}`
  }, [id])
  // While the verdict for a chat just switched to is still out, the screen that drew the last one
  // keeps drawing: the current screen holds the chat it left until the new one is ready.
  const [screenKind, subjectId] = verdict?.split("\n") ?? []
  // The screen this chat opens on, wrapped once: the one Previewer a screen mounts is the same
  // instance whichever screen drew the thread.
  const screen =
    screenKind === "canvas" && subjectId ? (
      <Navigate to={`/canvas/${subjectId}`} replace />
    ) : screenKind === "blank" && subjectId ? (
      // Keyed by the bot it draws: another bot's new chat is a fresh surface, with its own pick.
      <Suspense fallback={null}>
        <ChatNextBlank key={subjectId} botId={subjectId} slot={props.slot} />
      </Suspense>
    ) : screenKind === "room" && verdict === `room\n${id}` && id ? (
      <Suspense fallback={null}>
        <RoomChat key={id} id={id} slot={props.slot} />
      </Suspense>
    ) : screenKind === "next" && verdict === `next\n${id}` && id ? (
      <NextChat
        // Keyed by the chat it draws: a thread opened from Main is a fresh instance, which is what
        // lets it take the handover meant for its own id (ADR 0096).
        key={id}
        id={id}
        slot={props.slot}
        pinned={Boolean(props.chatId)}
        paneThread={props.paneThread}
        closeThread={props.closeThread}
      />
    ) : screenKind === "current" ? (
      <CurrentChatPage {...props} />
    ) : null
  if (screen) return <PreviewerProvider>{screen}</PreviewerProvider>
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
  closeThread,
}: {
  id: string
  slot: HoldSlot
  /** This instance draws a chat the address may not name: a Main beside its thread. */
  pinned: boolean
  paneThread?: string
  closeThread?: () => void
}) {
  const chat = useLiveQuery(() => db.conversations.get(id), [id])
  // A live query hands back a fresh array on every run, so what the thread keeps is keyed on the ids
  // the record names rather than on the array that carried them.
  const summaryKey = summaryKeyOf(chat?.compactions)
  const summaries = useMemo(() => summaryRowsOfKey(summaryKey), [summaryKey])
  const bot = useLiveQuery(
    async () => (chat ? db.profiles.get(chat.profileId) : undefined),
    [chat?.profileId],
  )
  const ready = Boolean(chat && bot && chat.id === id)
  const botThreads = useBotThreads()
  const { pathname, state: address } = useLocation()
  const { root, up } = useNav()
  // `useNav` hands back a fresh `up` each render; the back guard must not re-register every time.
  const upRef = useRef(up)
  upRef.current = up
  // A thread Main opened with `/thread` is handed the message it was opened for, by its own id: taken
  // once, here, so the screen that draws this thread is the one that sends it (ADR 0096).
  const [start] = useState(() => takeHandover(id))
  const routeChat = matchPath("/c/:id", pathname)?.params.id
  const isMain = Boolean(chat?.main)
  const mainOn = Boolean(botThreads && isMain)
  const threadList = useThreads(mainOn ? chat?.profileId : undefined)
  // The thread the address names when this instance is a Main drawn beside it.
  const routeThread =
    pinned && routeChat && routeChat !== id && !mainThreadProfile(routeChat) ? routeChat : undefined
  const mainPath =
    botThreads && chat && listsAsChat(chat) && !isMain
      ? `/c/${mainThreadId(chat.profileId)}`
      : undefined
  const xl = useXLarge()
  const wide = useWide()
  const besideMain = Boolean(mainPath) && xl
  useEffect(() => {
    if (!mainPath) return
    return setBackGuard(() => {
      upRef.current(mainPath)
      return true
    })
  }, [mainPath])
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
  const handed = (address as { project?: HermesProject } | null)?.project
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
  useLayoutEffect(() => {
    if (ready) hold(slot, id)
  }, [ready, slot, id])
  const { usage, providerUsage, notice, provider, noticeDismissed } = useChatUsage(
    chat,
    bot,
    chosenOf(chat?.modelChoice),
  )
  const [usageOpen, setUsageOpen] = useState(false)
  const [away, setAway] = useState(false)
  const online = useOnline()
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
              awayLine(away, online) ??
              (mainOn && threadList
                ? threadsLine(threadCount(threadList))
                : session && !unstarted
                  ? sessionSubtitle({
                      botName: bot.name,
                      names: sessionRepos.map((repo) => repo.name),
                      cap: repoCap({ wide, xlarge: xl }),
                    })
                  : undefined)
            }
            botId={bot.botId}
            muted={Boolean(chat.muted || bot.muted)}
            centered={Boolean(session) || besideMain}
            showBot={!session && !besideMain}
            actions={actions}
            leading={
              // Beside Main the bot is already on screen with the thread, so the way out is the
              // one that puts this pane away, in the slot a phone's Back takes. Below `xl` the
              // thread is a screen of its own and leads back; a session leads back to Code,
              // unless it is drawn beside Code's list.
              besideMain ? (
                closeThread && (
                  <BackButton
                    label="Close thread"
                    onClick={closeThread}
                    floating
                    icon={<XIcon />}
                  />
                )
              ) : mainPath ? (
                <BackButton
                  label={`Back to ${bot.name || "bot"}`}
                  onClick={() => up(mainPath)}
                  floating
                />
              ) : (
                underCode && (
                  <BackButton label="Back to Code" onClick={() => void leave()} floating />
                )
              )
            }
          />
          <ChatBody
            chat={chat}
            bot={bot}
            summaries={summaries}
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
            start={start}
            onAway={setAway}
            home={mainPath}
            limit={limit}
          />
          {leaveDialog}
        </>
      ) : (
        <PendingChat />
      )}
    </div>
  )
}

/**
 * A chat's composer, drawn from its record: a project session's own cards take the composer's place
 * in the order the current screen draws them — closed, blocked, then a plan waiting to be approved —
 * and a chat this device holds nothing of draws none of it.
 */
function CurrentChatPage({ chatId, paneThread, slot, closeThread }: ChatPageProps) {
  const params = useParams()
  const { pathname, state: address } = useLocation()
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
  const [todosOpen, setTodosOpen] = useState(false)
  const sheet = useCheatsheet()
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
  /** The read that left the thread empty: what it was, and the facts the pane and the report keep. */
  const [readFailure, setReadFailure] = useState<DiagReadFailure>()
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
  // Where the host compacted this chat's context: the first message after each carries a divider above
  // it. One that fell inside a reply is drawn in the reply, where it happened, and one with nothing
  // drawn on a side of it — above the first message a device holds, or after its last — draws none.
  const compacted = useMemo(
    () => compactionMarks(thread ?? [], conversation?.compactions),
    [thread, conversation?.compactions],
  )
  const {
    threadList,
    flow,
    moveThatOpenedThread,
    undo: undoMoveOutMain,
    itemRow,
  } = useMainFlow({
    chatId: id,
    profileId: conversation?.profileId ?? "",
    thread,
    moves: conversation?.moves,
    compacted,
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
  // The queue Hermes itself holds for this chat, and the turn a restart can lose under it
  // (`plugin/pending.py`). Read as the chat opens and then at the idle pace while nothing runs — a
  // fence is written to the ledger with no event of its own, so nothing else here would say so. A
  // read that changed nothing leaves the state it was, so the screen doesn't redraw on every tick.
  const [pending, setPending] = useState<PendingQueue>()
  const [discarding, setDiscarding] = useState(false)
  // A card whose host stopped answering: still drawn — the queue may still be held — but its one
  // control can't be promised to work, so it says so rather than handing the composer back and
  // letting a message be admitted behind a fence nothing will drain.
  const [stale, setStale] = useState(false)
  // Set when this device acknowledged a lost turn: the turn it freed starts a beat later and writes
  // its first row then, so an empty thread while this holds is being filled, not missing. Cleared by
  // the ladder that follows the turn, or by the screen moving to another chat.
  const [freed, setFreed] = useState(false)
  // The timer that closes that window, kept so another chat opening (or the screen closing) ends it
  // for the chat it belongs to rather than bumping a read on whatever is on screen then.
  const freedTimer = useRef(0)
  const missed = useRef(0)
  usePoll(
    () => {
      if (!id) return setPending(undefined)
      void readPending(id)
        .then((next) => {
          missed.current = 0
          setStale(false)
          setPending((held) => (equal(held, next) ? held : next))
        })
        .catch((error) => {
          noteFailure("Reading the host's queue", error)
          if (++missed.current >= 2) setStale(true)
        })
    },
    CHAT_IDLE_MS,
    [id],
    // A running turn is not a fenced one: the FIFO that a fence holds still is the one a run drains.
    { active: Boolean(id) && !busy },
  )
  // This component outlives the chat it shows, so the last chat's queue, misses and freed turn are
  // dropped when another one opens: none of them is a fact about the chat on screen now.
  useEffect(() => {
    setPending(undefined)
    setStale(false)
    missed.current = 0
    setFreed(false)
    window.clearTimeout(freedTimer.current)
  }, [id])
  const paused = pausedQueue(pending)
  const heldQueue = Boolean(paused)
  // What this screen knows about a thread that is being filled rather than missing.
  const filling = heldQueue || Boolean(pending?.running) || busy || freed
  // `readHistory` is rebuilt only when the chat changes, so it reads this rather than a captured
  // value: the empty-thread verdict must be judged against what is true when the read answers.
  const fillingNow = useRef(false)
  useEffect(() => {
    fillingNow.current = filling
  }, [filling])
  // Bumped when the freed turn's window closes, so the thread is read once more and says what it
  // finds rather than spinning on a read that already answered.
  const [freedCheck, setFreedCheck] = useState(0)
  const discardLost = async () => {
    // The row the card drew as lost is the row acknowledged: one answer, not two readings of it.
    if (!id || !paused) return
    setDiscarding(true)
    try {
      const next = await discardLostTurn(id, paused.lost)
      setPending(next)
      setStale(false)
      // The turn this frees writes its first row within the ladder that follows it; the last rung is
      // when the window closes and the thread is read again, so a turn that never came draws the
      // pane rather than a spinner nobody is filling.
      setFreed(true)
      const chat = id
      window.clearTimeout(freedTimer.current)
      freedTimer.current = window.setTimeout(() => {
        if (latest.current.chat?.id !== chat) return
        setFreed(false)
        setFreedCheck((n) => n + 1)
      }, HOST_QUEUE_SETTLE_MS)
    } catch (error) {
      setFreed(false)
      toast.error(error instanceof Error ? error.message : "Couldn't discard the lost turn.")
    } finally {
      setDiscarding(false)
    }
  }
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
  // The pick the chat's row holds, Default included.
  const keptModel = conversation?.modelChoice
  // As the menu reads a pick: the Default row's marker is no pick at all.
  const modelChoice = chosenOf(keptModel)
  const chooseModel = (choice: ModelChoice | undefined) => {
    if (!conversation) return
    const stored = storedPick(choice)
    // Re-picking the model the chat already holds would wake every query over its row for nothing.
    if (samePick(conversation.modelChoice, stored)) return
    void updateConversation(conversation.id, { modelChoice: stored })
  }
  // The chat's model pill: the composer's, and the plan-ready card's while a plan waits on it. A
  // chat with no record has no pick to write, so it has no pill.
  const modelPill = (extra: { display?: "pill" | "block"; disabled?: boolean }) =>
    configured &&
    conversation && (
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
  // A chat whose queue is held, or whose turn the host is running, and whose thread is empty is
  // being filled rather than unread: the turn writes its first row a beat later, so neither a read
  // that failed nor a spinner that never lands is the truth (ADR 0108).
  const pausedEmpty = filling && !flow.length
  const threadUnread = needsHistory && readFailure?.chat.id === id && !pausedEmpty
  const loadingHistory = needsHistory && !threadUnread && !pausedEmpty
  // A read describes the chat as it is when it fails, which is no reason for the read to run again.
  const latest = useRef({ chat: conversation, profile, stored: messages?.length ?? 0 })
  useEffect(() => {
    latest.current = { chat: conversation, profile, stored: messages?.length ?? 0 }
  })
  // The pane says the read failed and offers Try again; a toast on top of it says it twice.
  const readHistory = useCallback(() => {
    if (!id) return
    const at = Date.now()
    const failed = (error?: unknown) => {
      const { chat, profile, stored } = latest.current
      if (!chat || !profile) return
      const failure = describeReadFailure({
        at,
        error,
        chat,
        profile,
        stored,
        endpoint: "/api/sessions/{id}/messages",
      })
      setReadFailure(failure)
      reportUnreadThread(failure)
    }
    // A chat whose queue the host holds is empty by design (the lost turn never wrote its row),
    // which the card states, so neither outcome is recorded as a failed read (ADR 0108). Asked
    // through `readPending`, which the card's poll shares: one question, one request.
    const held = async () => {
      if (fillingNow.current) return true
      return Boolean(pausedQueue(await readPending(id).catch(() => undefined)))
    }
    reconcileHistory(id)
      .then(async (count) => {
        if (count || (await held())) return
        failed()
      })
      .catch(async (error) => {
        if (await held()) return
        failed(error)
      })
  }, [id])
  useEffect(() => {
    // The queue's answer belongs to the question: a fence lifted is what makes the read worth making
    // again, and a fence still in place is what leaves the thread empty without a word.
    if (needsHistory && !pausedEmpty) readHistory()
  }, [needsHistory, pausedEmpty, freedCheck, readHistory])
  const retryHistory = useCallback(() => {
    setReadFailure(undefined)
    readHistory()
  }, [readHistory])
  const readDetails = useCallback(
    () => (readFailure ? formatReadFailure(readFailure) : ""),
    [readFailure],
  )

  // Other devices add turns on Hermes. Catch up when the chat opens, when sync brings news of it,
  // when this tab comes back, and now and then while it's on screen.
  const updatedAt = conversation?.updatedAt
  const hasMessages = (messages?.length ?? 0) > 0
  // A session with a past is never drawn as one nobody started: it has a thread, unread. What Main
  // draws is its flow — messages, cards and the markers and dividers no message follows — so that
  // one list answers "is there anything here", not the messages or the cards on their own.
  const unstarted = !gone && configured && !flow.length && !needsHistory
  // The agents this chat's agent delegated to, for their cards in the thread. Only a call that set a
  // subagent to work turns the poll on: a list, steer or stop runs no agent to wait for (ADR 0053).
  const spawning = useMemo(() => spawnInFlight(messages), [messages])
  const agents = useSessionAgents(conversation ?? undefined, profile, spawning, busy)
  // A child is at work if this device's list says so or the host's own count does: the list folds
  // the answers to a stop made here, so it reads quiet while the host still holds the child.
  const hostChildren = useLiveSubagents()[conversation?.hermesSessionId ?? ""] ?? 0
  const subagentsRunning = useMemo(
    () => Math.max(runningAgents(agents).length, hostChildren),
    [agents, hostChildren],
  )
  const lastId = thread?.at(-1)?.id
  // The count is drawn once: on the last reply's own line, or at the thread's foot where it draws
  // none. This screen draws no catch-up line, so it has no second row to keep it off.
  const drawsInline =
    subagentsRunning > 0 && Boolean(thread?.at(-1) && carriesCount(thread.at(-1)!))
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
  /** The screen's Stop: the turn, and every subagent the session holds. */
  const stopEverything = useCallback((): boolean => {
    if (!id) return false
    stopMessage(id)
    if (agentsSource?.sessionId)
      void stopSubagents(agentsSource.server, agentsSource.sessionId, agentsSource.agents, {
        stopAll: hostStopsAll,
      }).catch(() => {
        // A subagent the host declined says why on its own card; only a call that never landed has
        // nowhere to say it.
        toast.error("Couldn't stop the subagents.")
      })
    return true
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
  const handed = (address as { project?: HermesProject } | null)?.project
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
  // This device has the chat's thread on screen as of now — its read mark, written when the thread
  // renders and again while new activity lands in front of the reader, which is what clears a row's
  // dot (never synced: a mark is about where the reader was sitting). Every chat writes one, not
  // only a coding session: the sidebar's bot row reads the marks of the bot's own threads (ADR
  // 0110). A session's moment is its last activity, which a pull request or a close moves too; a
  // thread's is its last turn.
  const seenId = conversation?.id
  const seenAt = session ? lastActivityAt(session) : (conversation?.updatedAt ?? 0)
  // The mark rides the activity it has seen, not the wall clock: a re-render with nothing new
  // writes nothing, and the list's dot still clears.
  useEffect(() => {
    if (seenId && seenAt > 0) markRead(seenId, seenAt)
  }, [seenId, seenAt])
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

  const send = async (text: string, attachments: Attachment[] = [], at?: number) => {
    if (!id) return
    try {
      // So a reply that builds on another device's latest turn shows after it, not before; a chat
      // that caught up a moment ago doesn't wait again.
      if (!caughtUpWithin(id, SEND_CAUGHT_UP_MS))
        await Promise.race([reconcileHistory(id).catch(() => undefined), wait(1500)])
      // Main's messages are triaged by the host first; a thread never is.
      if (conversation?.main) await announceMove(await sendFromMain(id, text, attachments))
      else await sendMessage(id, text, { attachments, at })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't send your message.")
      throw error
    }
  }

  // The thread opens on the message the reader typed with `/thread`, and sends it from its own
  // screen — the same handover chat-next's Main makes (ADR 0096).
  const startThread = async (text: string, attachments: Attachment[] = []) => {
    if (!profile || !conversation?.main) return
    try {
      // A pick made in Main comes with the thread; the Default row's marker doesn't, or the thread
      // would follow the default without ever fixing the model it started on.
      const thread = await beginThread(profile.id, {
        modelChoice: chosenOf(keptModel),
        text,
        attachments,
      })
      navigate(`/c/${thread.id}`, { state: { bot: profile.id } })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't start the thread.")
      throw error
    }
  }

  // The message Main handed this thread with `/thread`, sent here as the thread's first turn: the
  // same handover chat-next's screen takes, so the thread draws its message as it opens (ADR 0096).
  // Read by the address's id, because this screen keeps its instance as the address moves from Main
  // to the thread it just made; the take is once, so a second run of this effect finds nothing.
  useEffect(() => {
    if (!ready || !id) return
    const first = takeHandover(id)
    if (!first) return
    void send(first.text, first.attachments, first.at).catch(
      quietly("Sending a thread's first message"),
    )
  }, [ready, id, send])

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
          besideMain ? (
            // The bot is on screen with the thread, so the way out is the one that puts this pane
            // away, in the slot a phone's Back takes.
            closeThread && (
              <BackButton
                label="Close thread"
                onClick={closeThread}
                floating
                icon={<XIcon />}
              />
            )
          ) : mainPath ? (
            // Below `xl` the thread is a screen over Main, and leads back to it.
            <BackButton
              label={`Back to ${profile?.name ?? "bot"}`}
              onClick={() => up(mainPath)}
              floating
            />
          ) : (
            underCode && <BackButton label="Back to Code" onClick={() => void leave()} floating />
          )
        }
      />

      {flow.length > 0 ? (
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
                          profileId={conversation?.profileId ?? ""}
                          open={entry.thread.chat.id === openThread}
                          beside={Boolean(routeThread)}
                          current={entry.thread.chat.id === routeChat}
                          move={moveThatOpenedThread.get(entry.thread.chat.id)}
                          onUndo={undoMoveOutMain}
                        />
                      )
                    if (entry.kind !== "message") return itemRow(entry)
                    const message = entry.message
                    // A model change is a project session's mark; a chat draws none (ADR 0087).
                    const change = session ? changes.get(message.id) : undefined
                    return (
                      <MessageScrollerItem key={message.id} messageId={message.id}>
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
                          replaced={message.seams?.length ? compacted.replaced : undefined}
                        />
                      </MessageScrollerItem>
                    )
                  })}
                  {subagentsRunning > 0 && !drawsInline && (
                    <StatusLine>
                      <SubagentCount
                        count={subagentsRunning}
                        onOpen={showSubagents}
                        place="alone"
                      />
                    </StatusLine>
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
      ) : threadUnread ? (
        <MissingThread onRetry={retryHistory} details={readDetails} />
      ) : pausedEmpty ? (
        // Nothing has been written in this thread yet and nothing can be until the lost turn is
        // discarded: the card below says both, and a new session's face would say neither. The pane
        // still takes its room, so the card keeps the composer's own place at the foot.
        <div className="flex flex-1" />
      ) : conversation?.main && botThreads && configured ? (
        <MainEmptyState botId={profile?.botId} id={conversation?.id} onSend={send} />
      ) : (
        <EmptyState
          botId={profile?.botId}
          configured={configured && Boolean(id)}
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
        {(todos.length > 0 || prs.length > 0 || outputs > 0) && (
          // One line, centred; wider than the screen it scrolls, from the first pill.
          <div className="-mx-3 flex [scrollbar-width:none] overflow-x-auto px-3 pb-2 sm:-mx-4 sm:px-4 [&::-webkit-scrollbar]:hidden">
            <div className="mx-auto flex w-max max-w-none min-w-full shrink-0 justify-center gap-2">
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
        ) : paused ? (
          // Hermes holds this chat's queue behind a turn a restart lost: nothing typed here would
          // run, so the card takes the composer's place and names what waits (ADR 0108).
          <QueuePausedCard
            rows={paused.rows}
            discarding={discarding}
            stale={stale}
            onDiscard={discardLost}
          />
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
            notice={
              <LimitNotice
                usage={{ notice, provider, noticeDismissed }}
                profileId={profileId}
                onView={() => setUsageOpen(true)}
              />
            }
            // A chat with no record is not a chat the current screen can make: nothing can be sent
            // from here, and the blank surface is where a new chat is drawn.
            disabled={!configured || !id}
            draftKey={draftKey(id)}
            onSend={send}
            onQueue={(text, attachments) => {
              if (!id) return send(text, attachments)
              if (conversation?.main) return sendMidReply(id, false, text, attachments)
              void queueMessage(id, text, attachments)
            }}
            steerByDefault={resolved.steerByDefault}
            sendOnEnter={resolved.sendOnEnter}
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
            onStop={stopEverything}
            runId={runId}
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
                  return void sheet.show()
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
      <Cheatsheet open={sheet.open} onOpenChange={sheet.setOpen} switches={sheet.switches} />
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
    <CodeFaceProvider value={session ? CODE_FACE : undefined}>
      <div
        data-slot="chat-pane"
        data-pane={slot}
        className="relative flex min-h-0 flex-1 flex-col"
        inert={!ready}
      >
        {ready ? frame : <PendingChat />}
      </div>
    </CodeFaceProvider>
  )
}
