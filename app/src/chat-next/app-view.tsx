import { useLiveQuery } from "dexie-react-hooks"
import { RotateCcwIcon } from "lucide-react"
import {
  type ComponentProps,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { Banner } from "@/components/banner"
import { useBreakReminderEligibility } from "@/components/break-reminder-context"
import { AgentPopup } from "@/components/chat/agent-card"
import { ApprovalCard } from "@/components/chat/approval-card"
import { CHAT_FACE, CodeFaceProvider } from "@/components/chat/code-face"
import { DayHeading } from "@/components/chat/day-heading"
import { EmptyState, MainEmptyState } from "@/components/chat/empty-states"
import { useMainFlow } from "@/components/chat/main-flow"
import { MessageItem } from "@/components/chat/message-item"
import { FollowAfterApproval, FollowOnSend } from "@/components/chat/follow"
import { useFirstRows } from "@/components/chat/first-rows"
import { Compacted, ModelChange } from "@/components/chat/model-change"
import { QuestionCard } from "@/components/chat/question-card"
import { AskAgainContext } from "@/components/chat/session-cards"
import { StatusLine } from "@/components/chat/status-line"
import { SubagentCount } from "@/components/chat/subagent-count"
import { SubagentsSheet } from "@/components/chat/subagents"
import { ThreadCard } from "@/components/chat/thread-card"
import { Button } from "@/components/ui/button"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Spinner } from "@/components/ui/spinner"
import { AgentsContext, runningAgents, type AgentsSource } from "@/lib/agents"
import { isBackgroundSafeRunActive } from "@/lib/break-reminders"
import { attachmentsText } from "@/lib/attachment-text"
import { compactionMarks } from "@/lib/compactions"
import { db, type ApprovalChoice, type Message } from "@/lib/db"
import type { DelegatedAgent } from "@/lib/hermes"
import { usePluginFeatureOn } from "@/lib/features"
import { CATCHING_ACTIVITY } from "@/lib/format"
import { COLUMN_BOX, REPLY_INSET } from "@/lib/layout"
import { modelChanges } from "@/lib/model-changes"
import { useDraws } from "@/lib/openui-draws"
import type { RepoRef } from "@/lib/workspace"
import { carriesCount } from "@/lib/thinking"
import { cn } from "@/lib/utils"

import { delegated } from "./agents"
import { clearFailedTurn } from "./api"
import { messagesOf, replyId, withHeldFiles } from "./messages"
import { ChatNextThread, type PromptProps, type ThreadViewProps } from "./page"

/** A bot's Main as chat-next draws it: whose threads are its cards, and which one is open. */
export interface MainView {
  profileId: string
  botId?: string
  /** The thread open beside Main, or the one the address names. */
  openThread?: string
  /** The address is a thread, drawn beside Main. */
  beside: boolean
  /** The chat the address names. */
  routeChat?: string
}

/** The chat a view draws, and its Main where it is one: a context, so the view is one component. */
const ChatOf = createContext<{
  chatId: string
  main?: MainView
  blank?: BlankView
}>({
  chatId: "",
})

/** A project session not started yet: its bot and the repos it will work in, said in its place. */
export interface BlankView {
  botId?: string
  repos: RepoRef[]
}

/**
 * A chat-next thread drawn with the app's own rows (ADR 0065): each turn's request and reply through
 * `MessageItem`, its calls in the reply's tool groups and its delegations as the app's agent cards,
 * in the app's scroller, with the composer — or the prompt the run is held up on — pinned under it.
 */
export function AppThreadView({
  server,
  session,
  turns,
  streaming,
  agents,
  away,
  failure,
  catchingUp,
  older,
  origin,
  earlier,
  queue,
  waiting,
  inFlight,
  composer,
  stats,
  send,
}: ThreadViewProps) {
  const { chatId, main, blank } = useContext(ChatOf)
  // The files this device sent keep their bytes, so its own photos draw with the host away: only
  // the ones the thread's requests name are read.
  const sentPaths = useMemo(
    () => turns.flatMap((turn) => turn.files?.flatMap((file) => file.path ?? []) ?? []).join("\n"),
    [turns],
  )
  const sent = useLiveQuery(
    async () => ({
      // What the answer is for: a query goes on answering with its last result while the next runs.
      paths: sentPaths,
      files: await db.sentFiles.bulkGet(
        sentPaths ? sentPaths.split("\n").map((path): [string, string] => [session, path]) : [],
      ),
    }),
    [session, sentPaths],
  )
  const sentFiles = sent?.paths === sentPaths ? sent.files : undefined
  // The rows are the chat's: what a row reads through its chat — its media, its files, a question
  // asked again — finds the chat by this id, never by the session's.
  const messages = useMemo(
    () =>
      withHeldFiles(
        messagesOf(chatId, turns, { streaming, inFlight, stats, origin }),
        sentFiles &&
          new Map(sentFiles.flatMap((file) => (file ? [[file.path, file.blob] as const] : []))),
      ),
    [chatId, turns, streaming, inFlight, stats, origin, sentFiles],
  )
  // The send a card asks for is the latest one, behind an identity that never changes, so a streamed
  // flush never wakes the cards that hold it.
  const latestSend = useRef(send)
  useEffect(() => {
    latestSend.current = send
  })
  const ask = useCallback((text: string) => latestSend.current(text, []), [])
  // A turn the host gave up on can be sent again from where it stands: the host drops the failure
  // from its transcript where it can, and the thread hides it once the request is asked again.
  const hostClears = usePluginFeatureOn(
    { baseUrl: server.server, apiKey: server.key },
    "failed_turn_clear",
  )
  const [retrying, setRetrying] = useState(false)
  // A turn whose request is in a page not read yet has nothing to send again.
  const failedTurn =
    turns.at(-1)?.failed && !turns.at(-1)?.cut && !streaming && !waiting ? turns.at(-1) : undefined
  const retryId = failedTurn && replyId(chatId, origin + turns.length - 1)
  async function retry() {
    if (!failedTurn?.failed || retrying) return
    setRetrying(true)
    try {
      if (hostClears) await clearFailedTurn(server, session, failedTurn.failed.row)
      // The files are on the host already, so the message names their paths; a photo goes as a
      // file, since the transcript keeps no copy of the image part to send again.
      const files = (failedTurn.files ?? []).map((file) => ({
        ...file,
        id: file.path ?? file.name,
        image: false,
      }))
      await latestSend.current(attachmentsText(failedTurn.user, files), [])
    } finally {
      setRetrying(false)
    }
  }
  const [shown, setShown] = useState<DelegatedAgent>()
  const [sheet, setSheet] = useState(false)
  const config = useMemo(
    () => ({ baseUrl: server.server, apiKey: server.key }),
    [server.server, server.key],
  )
  const source = useMemo<AgentsSource>(
    () => ({ agents: agents.map(delegated), server: config, sessionId: session, onOpen: setShown }),
    [agents, config, session],
  )
  // The chat's own record, read once: a bot's Main draws the messages it sent off as markers from
  // it, and beside the transcript the plugin recorded where its model changed and where its context
  // was compacted, which the dividers between the turns are drawn from.
  const chat = useLiveQuery(() => db.conversations.get(chatId), [chatId])
  const moves = main ? chat?.moves : undefined
  const record = {
    changes: chat?.modelChanges,
    compactions: chat?.compactions,
    resolved: Boolean(chat?.resolvedAt),
    discarded: Boolean(chat?.discardedAt),
    blocked: Boolean(chat?.blocked),
  }
  // The break reminder counts only time the run carries on without the app: this screen follows
  // `/v1/runs` alone, so a streaming reply is one, until it waits on the user or its session closes.
  useBreakReminderEligibility(
    isBackgroundSafeRunActive({
      busy: streaming,
      runId: "run",
      awaitingApproval: Boolean(waiting),
      awaitingClarify: false,
      resolved: Boolean(record.resolved),
      discarded: Boolean(record.discarded),
      blocked: Boolean(record.blocked),
    }),
  )
  const profileId = chat?.profileId
  const profile = useLiveQuery(
    () => (profileId ? db.profiles.get(profileId) : undefined),
    [profileId],
  )
  // The interfaces a reply wrote draw as the app's own components, from what the thread holds.
  const draws = useDraws(messages, profile)
  const changes = useMemo(() => modelChanges(messages, record.changes), [messages, record.changes])
  const compacted = useMemo(
    () => compactionMarks(messages, record.compactions),
    [messages, record.compactions],
  )
  const { flow, moved, moveThatOpenedThread, undo, marker } = useMainFlow({
    chatId,
    profileId: main?.profileId ?? "",
    thread: messages,
    moves,
    on: Boolean(main),
    routeChat: main?.routeChat,
  })
  const { drawn, cut } = useFirstRows(chatId, flow, flow.length > 0)
  // A Main still being read is not an empty one: its greeting would say there is nothing here.
  const empty = Boolean(main) && !flow.length && !moved.trailing.length && !streaming && !catchingUp
  const unstarted = Boolean(blank) && !messages.length && !streaming && !queue?.items.length
  // A thread this device holds nothing of has nothing to say "catching up" under: its first read
  // is one loader in the middle of the pane, and only a thread already held says it in words.
  const loadingFresh = catchingUp && !messages.length && !streaming && !unstarted
  const running = runningAgents(source.agents).length
  const lastId = messages.at(-1)?.id
  // The count is drawn once: on the last reply's own line, or at the thread's foot where it draws none.
  const inline = running > 0 && Boolean(messages.at(-1) && carriesCount(messages.at(-1)!))
  // Stable, so a reply's own memo holds: a fresh callback would redraw every row on every token.
  const showSubagents = useCallback(() => setSheet(true), [])

  return (
    <AskAgainContext.Provider value={ask}>
      <div className="flex min-h-0 flex-1 flex-col">
        {unstarted && blank ? (
          <EmptyState botId={blank.botId} configured session={{ repos: blank.repos }} id={chatId} />
        ) : empty && main ? (
          <MainEmptyState botId={main.botId} id={chatId} onSend={(text) => send(text, [])} />
        ) : loadingFresh ? (
          <div className="flex min-h-0 flex-1 items-center justify-center" data-loading-fresh>
            <Spinner className="size-6 text-primary" />
          </div>
        ) : (
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <MessageScroller className="flex-1">
              <MessageScrollerViewport aria-label="Messages">
                <MessageScrollerContent
                  className={cn("w-full gap-6 px-4 pt-32 pb-6", cut && "justify-end")}
                >
                  {away && (
                    <div className={COLUMN_BOX} data-away role="status">
                      <Banner tone="info">Can't reach this host right now.</Banner>
                    </div>
                  )}
                  {failure !== undefined && (
                    <div className={COLUMN_BOX} role="alert">
                      <Banner tone="error">{failure || "Something went wrong."}</Banner>
                    </div>
                  )}
                  {earlier && (
                    <div className="flex shrink-0 justify-center">
                      <Button
                        data-earlier
                        variant="ghost"
                        size="sm"
                        disabled={earlier.state === "reading"}
                        onClick={earlier.load}
                      >
                        {earlier.state === "reading" ? (
                          <Spinner className="size-4" />
                        ) : earlier.state === "failed" ? (
                          "Couldn't load earlier messages. Try again"
                        ) : (
                          "Earlier messages"
                        )}
                      </Button>
                    </div>
                  )}
                  <AgentsContext.Provider value={source}>
                    {drawn.map((entry) => {
                      if (entry.kind === "heading")
                        return <DayHeading key={`day-${entry.at}`} day={entry.day} />
                      if (entry.kind === "card")
                        return (
                          <ThreadCard
                            key={`card-${entry.thread.chat.id}`}
                            thread={entry.thread}
                            botId={main?.botId}
                            profileId={main?.profileId ?? ""}
                            open={entry.thread.chat.id === main?.openThread}
                            beside={Boolean(main?.beside)}
                            current={entry.thread.chat.id === main?.routeChat}
                            move={moveThatOpenedThread.get(entry.thread.chat.id)}
                            onUndo={undo}
                          />
                        )
                      const message = entry.message
                      const change = changes.get(message.id)
                      return (
                        <MessageScrollerItem key={message.id} messageId={message.id}>
                          {moved.before.get(message.id)?.map(marker)}
                          {compacted.before.has(message.id) && (
                            <Compacted compaction={compacted.before.get(message.id)!} />
                          )}
                          {change && <ModelChange model={change} />}
                          <MessageItem
                            message={message}
                            // Only a row that draws a seam reads these: a new array on every
                            // conversation write would wake every row's memo.
                            compactions={message.seams?.length ? record.compactions : undefined}
                            blocks={draws.get(message.id)}
                            showStats
                            busy={streaming}
                            subagents={message.id === lastId ? running : undefined}
                            onShowSubagents={showSubagents}
                            subagentsInline={message.id === lastId && inline}
                          />
                          {message.id === retryId && (
                            <div className={cn(COLUMN_BOX, REPLY_INSET)}>
                              <Button
                                data-retry
                                variant="ghost"
                                size="sm"
                                disabled={retrying}
                                onClick={() => void retry()}
                              >
                                <RotateCcwIcon data-icon="inline-start" />
                                Retry
                              </Button>
                            </div>
                          )}
                        </MessageScrollerItem>
                      )
                    })}
                    {compacted.trailing && <Compacted compaction={compacted.trailing} />}
                    {moved.trailing.map(marker)}
                    {running > 0 && !inline && (
                      <StatusLine>
                        <SubagentCount count={running} onOpen={showSubagents} place="alone" />
                      </StatusLine>
                    )}
                  </AgentsContext.Provider>
                  {catchingUp && messages.length > 0 && (
                    <div className={COLUMN_BOX} data-catching-up>
                      <StatusLine text={CATCHING_ACTIVITY} seed={chatId} />
                    </div>
                  )}
                  {queue?.items.map((item) => (
                    <div
                      key={item.id}
                      data-queued
                      className={cn(COLUMN_BOX, "flex flex-col items-end gap-1")}
                    >
                      {item.files.length > 0 && (
                        <p className="text-xs text-muted-foreground">{item.files.join(", ")}</p>
                      )}
                      {item.text && (
                        <p className="max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 whitespace-pre-wrap opacity-60">
                          {item.text}
                        </p>
                      )}
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <span data-queued-state className="px-2">
                          {item.error ?? "Queued"}
                        </span>
                        {(queue.paused || item.error) && (
                          <Button
                            data-send-queued
                            variant="ghost"
                            size="sm"
                            onClick={() => queue.act(item.id, "send")}
                          >
                            Send now
                          </Button>
                        )}
                        <Button
                          data-remove-queued
                          variant="ghost"
                          size="sm"
                          onClick={() => queue.act(item.id, "remove")}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              {/* Over the scroller rather than in its flow: a row added or taken away at the top of the
                  content would move the thread, and this one is there only while pages are read. */}
              {older && (
                <div
                  data-older={older.state}
                  role="status"
                  className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center"
                >
                  {older.state === "reading" ? (
                    <span className="rounded-full bg-background/90 p-2 shadow-sm">
                      <Spinner className="size-4" />
                      <span className="sr-only">Loading earlier messages</span>
                    </span>
                  ) : (
                    <Button
                      data-older-retry
                      variant="secondary"
                      size="sm"
                      className="pointer-events-auto"
                      onClick={older.retry}
                    >
                      Couldn't load earlier messages. Try again
                    </Button>
                  )}
                </div>
              )}
              <MessageScrollerButton />
              <FollowAfterApproval pending={Boolean(waiting)} />
              <FollowOnSend
                lastUserId={messages.findLast((message) => message.role === "user")?.id}
              />
            </MessageScroller>
          </MessageScrollerProvider>
        )}
        <div
          data-slot="composer-slot"
          data-toast-above
          className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4"
        >
          {waiting ? <div className={COLUMN_BOX}>{waiting}</div> : composer}
        </div>
        <AgentPopup
          agent={shown}
          server={config}
          open={Boolean(shown)}
          onOpenChange={(open) => !open && setShown(undefined)}
        />
        <SubagentsSheet open={sheet} onOpenChange={setSheet} source={source} />
      </div>
    </AskAgainContext.Provider>
  )
}

const APPROVAL_CHOICES: ApprovalChoice[] = ["once", "session", "always", "deny"]

/**
 * The prompt a run is held up on, drawn as the app draws one everywhere: the approval card with the
 * tool that asked and every choice the host offers, and the question card with its choices and an
 * Other. The cards read a message, so the wait is dressed as the reply it interrupts, and an answer
 * goes where chat-next sends it rather than through the old engine.
 */
export function AppPrompt({ waiting, answer, asker }: PromptProps) {
  const message = useMemo((): Message => {
    const base = {
      id: `prompt-${waiting.promptId}`,
      conversationId: "",
      role: "assistant" as const,
      content: "",
      status: "streaming" as const,
      createdAt: 0,
    }
    if (waiting.kind === "approval")
      return {
        ...base,
        approval: {
          runId: waiting.run,
          command: waiting.command,
          ...(waiting.description ? { description: waiting.description } : {}),
          choices: waiting.choices.filter((choice): choice is ApprovalChoice =>
            APPROVAL_CHOICES.includes(choice as ApprovalChoice),
          ),
        },
        ...(asker
          ? {
              tools: [
                {
                  toolCallId: "asker",
                  tool: asker,
                  label: "",
                  status: "running" as const,
                  startedAt: 0,
                  contentOffset: 0,
                },
              ],
            }
          : {}),
      }
    return {
      ...base,
      clarify: {
        runId: waiting.run,
        clarifyId: waiting.promptId,
        questions: [
          {
            id: "q0",
            question: waiting.question,
            ...(waiting.choices.length ? { choices: waiting.choices } : {}),
            ...(waiting.multiSelect ? { multiSelect: true } : {}),
          },
        ],
      },
    }
  }, [waiting, asker])
  if (waiting.kind === "approval") return <ApprovalCard message={message} onAnswer={answer} />
  return (
    <QuestionCard
      message={message}
      onAnswer={(answers) => {
        const given = answers.q0
        return answer(Array.isArray(given) ? given.join(", ") : (given ?? ""))
      }}
    />
  )
}

/** The thread as a chat opens it in the app: chat-next, drawn with the app's rows. */
export function AppChatNextThread({
  chatId,
  main,
  blank,
  code,
  ...props
}: ComponentProps<typeof ChatNextThread> & {
  chatId: string
  main?: MainView
  blank?: BlankView
  /** A code session: what is said in it reads in the code face. */
  code?: boolean
}) {
  // Held by its fields, so a parent's render that changes nothing about Main draws nothing again.
  const mainKey = main ? JSON.stringify(main) : ""
  const blankKey = blank ? JSON.stringify(blank) : ""
  const chat = useMemo(
    () => ({
      chatId,
      main: mainKey ? (JSON.parse(mainKey) as MainView) : undefined,
      blank: blankKey ? (JSON.parse(blankKey) as BlankView) : undefined,
    }),
    [chatId, mainKey, blankKey],
  )
  return (
    <CodeFaceProvider value={code ? CHAT_FACE : undefined}>
      <ChatOf.Provider value={chat}>
        <ChatNextThread {...props} View={AppThreadView} Prompt={AppPrompt} />
      </ChatOf.Provider>
    </CodeFaceProvider>
  )
}
