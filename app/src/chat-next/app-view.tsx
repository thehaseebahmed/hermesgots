import { useLiveQuery } from "dexie-react-hooks"
import { type ComponentProps, createContext, useContext, useMemo, useState } from "react"

import { Banner } from "@/components/banner"
import { AgentPopup } from "@/components/chat/agent-card"
import { DayHeading } from "@/components/chat/day-heading"
import { EmptyState, MainEmptyState } from "@/components/chat/empty-states"
import { useMainFlow } from "@/components/chat/main-flow"
import { MessageItem } from "@/components/chat/message-item"
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
import { db } from "@/lib/db"
import type { DelegatedAgent } from "@/lib/hermes"
import { COLUMN_BOX } from "@/lib/layout"
import type { RepoRef } from "@/lib/workspace"
import { cn } from "@/lib/utils"

import type { Agent } from "./agents"
import { messagesOf } from "./messages"
import { ChatNextThread, type ThreadViewProps } from "./page"

/** A child as the app's agent cards read one: the plugin's row, in the app's own words. */
const delegated = (agent: Agent): DelegatedAgent => ({
  id: agent.id,
  goal: agent.goal,
  model: agent.model ?? null,
  startedAt: agent.started_at ?? null,
  endedAt: agent.ended_at ?? null,
  toolCalls: agent.tool_calls ?? 0,
  status: agent.status === "running" || agent.status === "stopped" ? agent.status : "done",
})

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
const ChatOf = createContext<{ chatId: string; main?: MainView; blank?: BlankView }>({
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
  earlier,
  queue,
  waiting,
  composer,
  send,
}: ThreadViewProps) {
  const { chatId, main, blank } = useContext(ChatOf)
  // The rows are the chat's: what a row reads through its chat — its media, its files, a question
  // asked again — finds the chat by this id, never by the session's.
  const messages = useMemo(
    () => messagesOf(chatId, turns, { streaming }),
    [chatId, turns, streaming],
  )
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
  const { flow, moved, moveThatOpenedThread, undo, marker } = useMainFlow({
    chatId,
    profileId: main?.profileId ?? "",
    thread: messages,
    moves,
    on: Boolean(main),
    routeChat: main?.routeChat,
  })
  const empty = Boolean(main) && !flow.length && !moved.trailing.length && !streaming
  const unstarted = Boolean(blank) && !messages.length && !streaming && !queue?.items.length
  const running = source.agents.filter((agent) => agent.status === "running").length
  const lastId = messages.at(-1)?.id
  const inline = running > 0 && messages.at(-1)?.status === "streaming"

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {unstarted && blank ? (
        <EmptyState botId={blank.botId} configured session={{ repos: blank.repos }} id={chatId} />
      ) : empty && main ? (
        <MainEmptyState botId={main.botId} id={chatId} onSend={(text) => send(text, [])} />
      ) : (
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller className="flex-1">
            <MessageScrollerViewport aria-label="Messages">
              <MessageScrollerContent className="w-full gap-6 px-4 pt-32 pb-6">
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
                  {flow.map((entry) => {
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
                    return (
                      <MessageScrollerItem key={message.id} messageId={message.id}>
                        {moved.before.get(message.id)?.map(marker)}
                        <MessageItem
                          message={message}
                          showStats={false}
                          busy={streaming}
                          subagents={message.id === lastId ? running : undefined}
                          onShowSubagents={() => setSheet(true)}
                          subagentsInline={message.id === lastId && inline}
                        />
                      </MessageScrollerItem>
                    )
                  })}
                  {moved.trailing.map(marker)}
                  {running > 0 && !inline && (
                    <SubagentLine count={running} onOpen={() => setSheet(true)} className="px-1" />
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
  )
}

/** The thread as a chat opens it in the app: chat-next, drawn with the app's rows. */
export function AppChatNextThread({
  chatId,
  main,
  blank,
  ...props
}: ComponentProps<typeof ChatNextThread> & {
  chatId: string
  main?: MainView
  blank?: BlankView
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
    <ChatOf.Provider value={chat}>
      <ChatNextThread {...props} View={AppThreadView} />
    </ChatOf.Provider>
  )
}
