import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { Cheatsheet, useCheatsheet } from "@/components/chat/cheatsheet"
import { LimitNotice, type useChatUsage } from "@/components/chat/chat-actions"
import { Composer } from "@/components/chat/composer"
import { LibraryPill } from "@/components/chat/library-pill"
import { ModelMenu } from "@/components/chat/model-picker"
import { OutputsDrawer } from "@/components/chat/outputs-drawer"
import { PrPill } from "@/components/chat/pr-pill"
import { prLabel } from "@/components/chat/pr-look"
import {
  BlockedCard,
  DiscardedCard,
  PlanReadyCard,
  ResolvedCard,
} from "@/components/chat/session-cards"
import { TodosPill, TodosSheet } from "@/components/chat/todos"
import { PR_PENDING_MS } from "@/lib/freshness"
import { readAfterTurn } from "@/lib/chat"
import { refreshChatDetails } from "@/lib/history"
import { serverConfig } from "@/lib/connection"
import {
  DEFAULT_SETTINGS,
  type Attachment,
  type Conversation,
  type ModelChoice,
  type Profile,
  db,
  getSettings,
  updateConversation,
} from "@/lib/db"
import { dictationHint } from "@/lib/dictation-hint"
import { draftKey } from "@/lib/drafts"
import { usePluginFeature } from "@/lib/features"
import { mayHoldArchive } from "@/lib/history-window"
import { chosenOf, samePick, storedPick } from "@/lib/model-pick"
import { useNav } from "@/lib/nav"
import { beginThread } from "@/lib/threads"
import { useProjects } from "@/lib/projects"
import { markRead } from "@/lib/read-marks"
import { lastActivityAt, runFinished } from "@/lib/session-work"
import { useLiveSubagents } from "@/lib/waiting"
import {
  planApprovalMessage,
  prChecksPending,
  projectRepos,
  refreshPrs,
  setSessionMode,
} from "@/lib/workspace"
import type { ComposerControls } from "./page"
import { prepareTurn, queueTurn, steerTurn, triageTurn } from "./turn"
import type { BlankView, MainView } from "./app-view"

const ChatNextThread = lazy(() =>
  import("./app-view").then((m) => ({ default: m.AppChatNextThread })),
)

export interface ChatBodyProps {
  chat: Conversation
  bot: Profile
  summaries: ComponentProps<typeof ChatNextThread>["summaries"]
  /** A project session not started yet: said in the thread's place. */
  blank?: BlankView
  /** A bot's Main: its threads are cards in its flow, and its messages are triaged first. */
  main?: MainView
  /** The message a thread opened by `/thread` is handed, taken once by the route. */
  start: ComponentProps<typeof ChatNextThread>["start"]
  onAway: (away: boolean) => void
  /** Where `/new` goes from the composer: a thread's Main, else home. */
  home?: string
  limit: LimitValue
}

/**
 * One chat as a container holds it: the thread with the composer, its pills and the account's limit
 * notice under it. It needs no route, pane slot or header, and fills the flex column it is given,
 * scrolling the thread inside it; the chat pane draws it under its header.
 */
export function ChatBody({
  chat,
  bot,
  summaries,
  blank,
  main,
  start,
  onAway,
  home,
  limit,
}: ChatBodyProps) {
  const id = chat.id
  const mainOn = Boolean(main)
  const botKey = bot.id
  // One component per chat and bot, so the composer keeps its text across the thread's renders:
  // a write to the bot's row hands back a new object, which mustn't remount it.
  const composer = useMemo(
    () =>
      function ChatNextComposer({ controls }: { controls: ComposerControls }) {
        return (
          <NextComposer controls={controls} chatId={id} botId={botKey} main={mainOn} home={home} />
        )
      },
    [id, botKey, mainOn, home],
  )
  return (
    <LimitContext.Provider value={limit}>
      <Suspense fallback={null}>
        <ChatNextThread
          key={chat.hermesSessionId}
          chatId={id}
          code={Boolean(chat.projectId)}
          compacted={mayHoldArchive(chat.compactions)}
          summaries={summaries}
          blank={blank}
          main={main}
          server={bot.baseUrl}
          apiKey={bot.apiKey}
          session={chat.hermesSessionId}
          start={start}
          prepareTurn={(text, attachments, at) => prepareTurn(id, text, attachments, at)}
          queueTurn={async (text, attachments) => void (await queueTurn(id, text, attachments))}
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
          onAway={onAway}
          Composer={composer}
        />
      </Suspense>
    </LimitContext.Provider>
  )
}

/**
 * What the pane knows of the account's limits and how to open the usage sheet, for the composer to
 * warn with: the composer is one component for the chat's life, so it reads this rather than being
 * handed it, and a change in the limits never remounts it.
 */
export interface LimitValue {
  usage: Pick<ReturnType<typeof useChatUsage>, "notice" | "provider" | "noticeDismissed">
  onView: () => void
}

const LimitContext = createContext<LimitValue | null>(null)

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
      <NextPills chatId={props.chatId} botId={props.botId} busy={props.controls.busy} />
      <NextComposerBody
        {...props}
        notice={
          limit ? (
            <LimitNotice usage={limit.usage} profileId={props.botId} onView={limit.onView} />
          ) : null
        }
      />
    </>
  )
}

/**
 * What the plugin holds for a chat on chat-next, as the current screen shows it above the composer:
 * the todo list, the session's pull requests and its filed outputs, each opening its sheet. The reads
 * that fill them are the chat's follow-up reads (`onSettled`).
 */
function NextPills({ chatId, botId, busy }: { chatId: string; botId: string; busy: boolean }) {
  const bot = useLiveQuery(() => db.profiles.get(botId), [botId])
  const chat = useLiveQuery(() => db.conversations.get(chatId), [chatId])
  const [todosOpen, setTodosOpen] = useState(false)
  const [outputsOpen, setOutputsOpen] = useState(false)
  const subagents = useLiveSubagents()
  const tracked = Boolean(bot?.apiKey && !bot.disabled)
  const session = chat?.projectId ? chat : undefined
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
  // The chat's read mark rides the activity it has seen, as on the current screen: every chat
  // writes one, not only a coding session, because the sidebar's bot row reads the marks of the
  // bot's own threads (ADR 0110). A session's moment is its last activity, which a pull request or
  // a close moves too; a thread's is its last turn.
  const threadId = chat?.id
  const activity = chat ? (session ? lastActivityAt(chat) : chat.updatedAt) : 0
  useEffect(() => {
    if (threadId && activity > 0) markRead(threadId, activity)
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
      {(todos.length > 0 || prs.length > 0 || outputs > 0) && (
        <div className="-mx-3 flex [scrollbar-width:none] overflow-x-auto px-3 pb-2 sm:-mx-4 sm:px-4 [&::-webkit-scrollbar]:hidden">
          <div className="mx-auto flex w-max max-w-none min-w-full shrink-0 justify-center gap-2">
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
  notice,
}: {
  controls: ComposerControls
  chatId: string
  botId: string
  /** A bot's Main: `/thread` starts a thread of it. */
  main: boolean
  /** Where `/new` goes: a thread's Main, else home. */
  home?: string
  /** The account's warning, which the composer draws above its text while it holds. */
  notice?: ReactNode
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
  // `/thread` from Main: a thread of its own, with Main's pick, opened on the message the reader
  // typed with it. The thread's own screen sends that message, so the turn is drawn there as it
  // arrives and Main's card has the opener to show (ADR 0096).
  const startThread = async (text: string, attachments: Attachment[]) => {
    try {
      const from = await db.conversations.get(chatId)
      const thread = await beginThread(botId, {
        modelChoice: chosenOf(from?.modelChoice),
        text,
        attachments,
      })
      navigate(`/c/${thread.id}`, { state: { bot: botId } })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't start the thread.")
      throw error
    }
  }
  const filesFeature = usePluginFeature(bot, "attachments")
  const sheet = useCheatsheet()
  const steerByDefault = useLiveQuery(async () => (await getSettings()).steerByDefault, [])
  const sendOnEnter = useLiveQuery(async () => (await getSettings()).sendOnEnter, [])
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
        notice={notice}
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
        sendOnEnter={sendOnEnter ?? DEFAULT_SETTINGS.sendOnEnter}
        subagentsRunning={controls.subagents}
        onStop={controls.stop}
        runId={controls.runId}
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
          if (command === "cheatsheet") return void sheet.show()
        }}
      />
      <Cheatsheet open={sheet.open} onOpenChange={sheet.setOpen} switches={sheet.switches} />
    </>
  )
}
