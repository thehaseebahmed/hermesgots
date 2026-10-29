import { useLiveQuery } from "dexie-react-hooks"
import { type ComponentProps, createContext, useContext, useEffect, useMemo, useState } from "react"

import { Banner } from "@/components/banner"
import { AgentPopup } from "@/components/chat/agent-card"
import { ApprovalCard } from "@/components/chat/approval-card"
import { CodeFaceProvider } from "@/components/chat/code-face"
import { DayHeading } from "@/components/chat/day-heading"
import { EmptyState, MainEmptyState } from "@/components/chat/empty-states"
import { useMainFlow } from "@/components/chat/main-flow"
import { MessageItem } from "@/components/chat/message-item"
import { useFirstRows } from "@/components/chat/first-rows"
import { Compacted, ModelChange } from "@/components/chat/model-change"
import { QuestionCard } from "@/components/chat/question-card"
import { AskAgainContext } from "@/components/chat/session-cards"
import { SubagentLine } from "@/components/chat/subagent-line"
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
import { AgentsContext, type AgentsSource } from "@/lib/agents"
import { compactionMarks } from "@/lib/compactions"
import { db, type ApprovalChoice, type Message } from "@/lib/db"
import type { DelegatedAgent } from "@/lib/hermes"
import { describeActivity } from "@/lib/format"
import { COLUMN_BOX } from "@/lib/layout"
import { modelChanges } from "@/lib/model-changes"
import { useDraws } from "@/lib/openui-draws"
import type { RepoRef } from "@/lib/workspace"
import { cn } from "@/lib/utils"

import { delegated } from "./agents"
import { messagesOf } from "./messages"
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
  onStatus?: (status: ThreadStatus) => void
}>({
  chatId: "",
})

/** What the thread says of itself to the header above it: what the reply is doing, and its count. */
export interface ThreadStatus {
  chatId: string
  /** What the streaming reply is doing, in words ("Running a command…"); none at rest. */
  activity?: string
  /** How many replies the thread holds. */
  replies: number
}

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
  earlier,
  queue,
  waiting,
  composer,
  send,
}: ThreadViewProps) {
  const { chatId, main, blank, onStatus } = useContext(ChatOf)
  // The rows are the chat's: what a row reads through its chat — its media, its files, a question
  // asked again — finds the chat by this id, never by the session's.
  const messages = useMemo(
    () => messagesOf(chatId, turns, { streaming }),
    [chatId, turns, streaming],
  )
  const streamingReply = messages.findLast((message) => message.status === "streaming")
  const activity = streamingReply && describeActivity(streamingReply)
  const replies = messages.filter((message) => message.role === "assistant").length
  useEffect(() => onStatus?.({ chatId, activity, replies }), [onStatus, chatId, activity, replies])
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
  // A bot's Main draws its threads as cards in its own flow, and the messages it sent off as markers.
  const moves = useLiveQuery(
    async () => (main ? (await db.conversations.get(chatId))?.moves : undefined),
    [chatId, Boolean(main)],
  )
  // What the plugin recorded of the chat beside its transcript: where its model changed and where
  // its context was compacted, which the dividers between the turns are drawn from.
  const record = useLiveQuery(async () => {
    const chat = await db.conversations.get(chatId)
    return chat ? { changes: chat.modelChanges, compactions: chat.compactions } : undefined
  }, [chatId])
  const profile = useLiveQuery(async () => {
    const chat = await db.conversations.get(chatId)
    return chat ? db.profiles.get(chat.profileId) : undefined
  }, [chatId])
  // The interfaces a reply wrote draw as the app's own components, from what the thread holds.
  const draws = useDraws(messages, profile)
  const changes = useMemo(
    () => modelChanges(messages, record?.changes),
    [messages, record?.changes],
  )
  const compacted = useMemo(
    () => compactionMarks(messages, record?.compactions),
    [messages, record?.compactions],
  )
  const { flow, moved, moveThatOpenedThread, undo, marker } = useMainFlow({
    chatId,
    profileId: main?.profileId ?? "",
    thread: messages,
    moves,
    on: Boolean(main),
    routeChat: main?.routeChat,
  })
  const { drawn, cut } = useFirstRows(chatId, flow, messages.length > 0 || Boolean(main))
  const empty = Boolean(main) && !flow.length && !moved.trailing.length && !streaming
  const unstarted = Boolean(blank) && !messages.length && !streaming && !queue?.items.length
  const running = source.agents.filter((agent) => agent.status === "running").length
  const lastId = messages.at(-1)?.id
  const inline = running > 0 && messages.at(-1)?.status === "streaming"

  return (
    <AskAgainContext.Provider value={(text) => send(text, [])}>
      <div className="flex min-h-0 flex-1 flex-col">
        {unstarted && blank ? (
          <EmptyState botId={blank.botId} configured session={{ repos: blank.repos }} id={chatId} />
        ) : empty && main ? (
          <MainEmptyState botId={main.botId} id={chatId} onSend={(text) => send(text, [])} />
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
                            compactions={message.seams?.length ? record?.compactions : undefined}
                            blocks={draws.get(message.id)}
                            showStats={false}
                            busy={streaming}
                            subagents={message.id === lastId ? running : undefined}
                            onShowSubagents={() => setSheet(true)}
                            subagentsInline={message.id === lastId && inline}
                          />
                        </MessageScrollerItem>
                      )
                    })}
                    {compacted.trailing && <Compacted compaction={compacted.trailing} />}
                    {moved.trailing.map(marker)}
                    {running > 0 && !inline && (
                      <SubagentLine
                        count={running}
                        onOpen={() => setSheet(true)}
                        className="px-1"
                      />
                    )}
                  </AgentsContext.Provider>
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
              <MessageScrollerButton />
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

/** The thread as a chat opens it in the app: chat-next, drawn with the app's rows. */
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

export function AppChatNextThread({
  chatId,
  main,
  blank,
  code,
  onStatus,
  ...props
}: ComponentProps<typeof ChatNextThread> & {
  chatId: string
  main?: MainView
  blank?: BlankView
  /** Told what the thread is doing, for a header that says so. */
  onStatus?: (status: ThreadStatus) => void
  /** A code session: the agent's own output reads in the code face. */
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
      onStatus,
    }),
    [chatId, mainKey, blankKey, onStatus],
  )
  return (
    <CodeFaceProvider value={code ? "font-code" : undefined}>
      <ChatOf.Provider value={chat}>
        <ChatNextThread {...props} View={AppThreadView} Prompt={AppPrompt} />
      </ChatOf.Provider>
    </CodeFaceProvider>
  )
}
