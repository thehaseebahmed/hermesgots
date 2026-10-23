import { useEffect, useRef, useState } from "react"
import { BotIcon, CheckIcon, ChevronRightIcon, PauseIcon } from "lucide-react"

import { AGENT_WORK_MS } from "@/lib/freshness"
import { Banner } from "@/components/banner"
import { MessageItem } from "@/components/chat/message-item"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Spinner } from "@/components/ui/spinner"
import {
  agentLine,
  agentName,
  agentsOf,
  agentTranscript,
  useAgentsSource,
  type AgentsSource,
} from "@/lib/agents"
import type { Message, ToolEvent } from "@/lib/db"
import type { DelegatedAgent, HermesConfig } from "@/lib/hermes"
import { toMessages } from "@/lib/history"
import { useDraws } from "@/lib/openui-draws"
import { activityOf } from "@/lib/tools"
import { connectionKey } from "@/lib/connection"
import { cn } from "@/lib/utils"

const RECENT_ROWS = 40
const STEPS = 2
const NO_ROWS: Message[] = []

const agentTitle = (goal: string) => `Sub-Agent: ${agentName(goal)}`

/**
 * A `delegate_task` call: a card per agent it started, with the last few things that agent did,
 * opening everything it did. Without the plugin to name the agent, the call's goal and state.
 */
export function AgentCards({ tool }: { tool: ToolEvent }) {
  const source = useAgentsSource()
  const agents = source ? agentsOf(tool, source.agents) : []
  if (!source || agents.length === 0) return <PendingCard tool={tool} />
  return (
    <>
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} source={source} />
      ))}
    </>
  )
}

function CardShell({ onClick, children }: { onClick?: () => void; children: React.ReactNode }) {
  const className =
    "mx-auto flex w-full max-w-md flex-col gap-2 rounded-3xl border bg-muted/40 px-4 py-3 text-left"
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        className,
        "outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {children}
    </button>
  ) : (
    <div className={className}>{children}</div>
  )
}

function PendingCard({ tool }: { tool: ToolEvent }) {
  const running = tool.status === "running"
  return (
    <CardShell>
      <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <BotIcon className="size-4" />
        <span className="flex-1 truncate">{agentTitle(tool.label)}</span>
      </span>
      {running && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3" />
          Working
        </span>
      )}
    </CardShell>
  )
}

function StatusIcon({ agent }: { agent: DelegatedAgent }) {
  if (agent.status === "running") return <Spinner className="size-3" />
  if (agent.status === "stopped")
    return <PauseIcon className="size-3 text-warning" aria-label="Stopped" />
  return <CheckIcon className="size-3" aria-label="Done" />
}

/** Finished agents' transcripts, which don't change, by server, agent and length. */
const finished = new Map<string, Message[]>()

/** An agent's transcript as the chat shows a reply, read again while the agent works. */
function useTranscript(server: HermesConfig, agent: DelegatedAgent, limit: number) {
  const running = agent.status === "running"
  const { baseUrl, apiKey } = server
  const cacheKey = `${connectionKey(server)}|${agent.id}|${limit}`
  const [messages, setMessages] = useState<Message[]>()
  const [failed, setFailed] = useState(false)
  const kept = running ? undefined : finished.get(cacheKey)
  useEffect(() => {
    if (kept) return
    let cancelled = false
    const read = () => {
      if (document.visibilityState !== "visible") return
      agentTranscript({ baseUrl, apiKey }, agent.id, limit)
        .then((rows) => {
          if (cancelled) return
          const next = toMessages(`agent-${agent.id}`, agent.id, rows, { live: running })
          if (!running) finished.set(cacheKey, next)
          setMessages(next)
          setFailed(false)
        })
        .catch(() => !cancelled && setFailed(true))
    }
    read()
    const timer = running ? window.setInterval(read, AGENT_WORK_MS) : undefined
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [baseUrl, apiKey, agent.id, limit, running, cacheKey, kept])
  return { messages: kept ?? messages, failed: !kept && failed }
}

function AgentCard({ agent, source }: { agent: DelegatedAgent; source: AgentsSource }) {
  const [open, setOpen] = useState(false)
  const { messages } = useTranscript(source.server, agent, RECENT_ROWS)
  const steps = (messages ?? []).flatMap((m) => m.tools ?? []).slice(-STEPS)
  return (
    <>
      <CardShell onClick={() => setOpen(true)}>
        <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <BotIcon className="size-4" />
          <span className="flex-1 truncate">{agentTitle(agent.goal)}</span>
          <ChevronRightIcon className="size-4" />
        </span>
        {steps.length ? (
          <ul className="flex flex-col gap-1">
            {steps.map((step) => (
              <li key={step.toolCallId} className="flex min-w-0 items-center gap-2 text-[15px]">
                <span className="shrink-0">{activityOf(step)}</span>
                {step.label && step.label !== step.tool && (
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {step.label}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="line-clamp-2 text-[15px]">
            {agentName(agent.goal) === agent.goal.trim() ? "Starting…" : agent.goal}
          </p>
        )}
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          <StatusIcon agent={agent} />
          {agentLine(agent)}
        </span>
      </CardShell>
      <Popup open={open} onOpenChange={setOpen}>
        <PopupContent size="xl">
          {open && <AgentView agent={agent} server={source.server} />}
        </PopupContent>
      </Popup>
    </>
  )
}

/** Everything one delegated agent did, followed while it works. */
function AgentView({ agent, server }: { agent: DelegatedAgent; server: HermesConfig }) {
  const { messages, failed } = useTranscript(server, agent, 500)
  const draws = useDraws(messages ?? NO_ROWS, server)
  const end = useRef<HTMLDivElement>(null)
  const loaded = messages !== undefined
  useEffect(() => {
    if (loaded) end.current?.scrollIntoView({ block: "end" })
  }, [loaded])
  return (
    <>
      <PopupHeader className="gap-1 pb-3">
        <PopupTitle>{agentTitle(agent.goal)}</PopupTitle>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <StatusIcon agent={agent} />
          <span className="truncate">
            {[agentLine(agent), agent.model].filter(Boolean).join(" · ")}
          </span>
        </p>
      </PopupHeader>
      {failed && !loaded && (
        <div className="px-6">
          <Banner tone="error">Couldn't load this agent's work.</Banner>
        </div>
      )}
      <div className="flex flex-col gap-4 px-4 pb-2">
        {loaded && messages.length === 0 && (
          <p className="px-2 text-sm text-muted-foreground">Nothing yet.</p>
        )}
        {messages?.map((message) => (
          <MessageItem
            key={message.id}
            message={message}
            showStats={false}
            blocks={draws.get(message.id)}
          />
        ))}
        <div ref={end} />
      </div>
    </>
  )
}
