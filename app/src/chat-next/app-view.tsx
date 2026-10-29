import { type ComponentProps, useMemo, useState } from "react"

import { Banner } from "@/components/banner"
import { AgentPopup } from "@/components/chat/agent-card"
import { MessageItem } from "@/components/chat/message-item"
import { SubagentLine } from "@/components/chat/subagent-line"
import { SubagentsSheet } from "@/components/chat/subagents"
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
import type { DelegatedAgent } from "@/lib/hermes"
import { COLUMN_BOX } from "@/lib/layout"
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
}: ThreadViewProps) {
  const messages = useMemo(
    () => messagesOf(session, turns, { streaming }),
    [session, turns, streaming],
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
  const running = source.agents.filter((agent) => agent.status === "running").length
  const lastId = messages.at(-1)?.id
  const inline = running > 0 && messages.at(-1)?.status === "streaming"

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
                {messages.map((message) => (
                  <MessageScrollerItem key={message.id} messageId={message.id}>
                    <MessageItem
                      message={message}
                      showStats={false}
                      busy={streaming}
                      subagents={message.id === lastId ? running : undefined}
                      onShowSubagents={() => setSheet(true)}
                      subagentsInline={message.id === lastId && inline}
                    />
                  </MessageScrollerItem>
                ))}
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
export function AppChatNextThread(props: ComponentProps<typeof ChatNextThread>) {
  return <ChatNextThread {...props} View={AppThreadView} />
}
