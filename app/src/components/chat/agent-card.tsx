import { useEffect, useRef, useState } from "react"
import { BotIcon, CheckIcon, ChevronRightIcon, PauseIcon } from "lucide-react"

import { AGENT_WORK_MS } from "@/lib/freshness"
import { Banner } from "@/components/banner"
import { MessageItem } from "@/components/chat/message-item"
import { FLAT_CARD } from "@/components/chat/session-cards"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  agentLine,
  agentName,
  agentOfResult,
  agentsOf,
  agentTranscript,
  useAgentsSource,
  type AgentsSource,
} from "@/lib/agents"
import { type Message, type SubagentRef, type ToolEvent } from "@/lib/db"
import { usePluginFeatureOn } from "@/lib/features"
import { stopAgent, type AgentStop, type DelegatedAgent, type HermesConfig } from "@/lib/hermes"
import { toMessages } from "@/lib/history"
import { useDraws } from "@/lib/openui-draws"
import { activityOf } from "@/lib/tools"
import { connectionKey } from "@/lib/connection"
import { cn } from "@/lib/utils"

const RECENT_ROWS = 40
const STEPS = 2
const NO_ROWS: Message[] = []

const agentTitle = (goal: string) => `Sub-Agent: ${agentName(goal)}`

/** A `delegate_task` call: a card per agent it started, each offering Stop once its turn has ended. */
export function AgentCards({ tool, ended }: { tool: ToolEvent; ended: boolean }) {
  const source = useAgentsSource()
  const agents = source ? agentsOf(tool, source.agents) : []
  if (!source || agents.length === 0) return <PendingCard tool={tool} />
  return (
    <>
      {agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} source={source} ended={ended} />
      ))}
    </>
  )
}

function CardShell({
  onClick,
  slot,
  action,
  children,
}: {
  onClick?: () => void
  /** What a test (or a style) can name the card by. */
  slot?: string
  /** A control on a row of its own under the card's body, never inside its tap target. */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const box = cn(FLAT_CARD, "flex flex-col gap-2 px-4 py-3 text-left")
  if (!action)
    return onClick ? (
      <button
        type="button"
        data-slot={slot}
        onClick={onClick}
        className={cn(
          box,
          "outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {children}
      </button>
    ) : (
      <div data-slot={slot} className={box}>
        {children}
      </div>
    )
  // With a row under the body, the card is a box whose body is the tap target: a control of its own
  // may not sit inside a button.
  const body = "flex flex-col gap-2 px-4 py-3 text-left"
  return (
    <div
      data-slot={slot}
      className={cn(FLAT_CARD, "flex flex-col")}
    >
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className={cn(
            body,
            "rounded-3xl outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {children}
        </button>
      ) : (
        <div className={body}>{children}</div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-2">
        {action}
      </div>
    </div>
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

function AgentCard({
  agent,
  source,
  ended,
}: {
  agent: DelegatedAgent
  source: AgentsSource
  /** The turn that started it is over, so its own stop is offered here. */
  ended: boolean
}) {
  const [open, setOpen] = useState(false)
  const [answer, setAnswer] = useState<AgentStop & { at?: number }>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const { messages } = useTranscript(source.server, agent, RECENT_ROWS)
  const steps = (messages ?? []).flatMap((m) => m.tools ?? []).slice(-STEPS)
  // A host without the route draws no Stop at all, and neither does a card whose turn still runs.
  const stoppable = usePluginFeatureOn(source.server, "subagent_stop")
  const canStop =
    ended &&
    agent.status === "running" &&
    !answer?.stopped &&
    Boolean(source.sessionId) &&
    stoppable
  // What the card reads once it is stopped: when it stopped here, since the host hasn't written an
  // end yet, and the host's own row takes over on the next read.
  const shown: DelegatedAgent = answer?.stopped
    ? { ...agent, status: "stopped", endedAt: agent.endedAt ?? answer.at ?? null }
    : agent
  const stop = async () => {
    if (!source.sessionId) return
    setBusy(true)
    setFailure(undefined)
    try {
      const next = await stopAgent(source.server, source.sessionId, agent.id)
      setAnswer({ ...next, at: Date.now() / 1000 })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Couldn't stop this subagent.")
    } finally {
      setBusy(false)
    }
  }
  const note = failure ?? answer?.reason
  return (
    <>
      <CardShell
        slot="agent-card"
        onClick={() => setOpen(true)}
        action={
          canStop || note ? (
            <>
              {note && <p className="min-w-0 flex-1 text-xs text-muted-foreground">{note}</p>}
              {canStop && (
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-9 rounded-full"
                  disabled={busy}
                  onClick={() => void stop()}
                >
                  {busy ? "Stopping…" : "Stop"}
                </Button>
              )}
            </>
          ) : undefined
        }
      >
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
          <StatusIcon agent={shown} />
          {agentLine(shown)}
        </span>
      </CardShell>
      <AgentPopup agent={shown} server={source.server} open={open} onOpenChange={setOpen} />
    </>
  )
}

/**
 * A subagent's result, as the thread draws it: a line naming the subagent whose work it is, opening
 * the same sub-thread its card does. A chat that can't name the subagent still draws the line — the
 * result itself is the message — with nothing to open.
 */
export function SubagentResultCard({ subagent }: { subagent: SubagentRef }) {
  const source = useAgentsSource()
  const agent = source ? agentOfResult(subagent, source.agents) : undefined
  const [open, setOpen] = useState(false)
  const goal = agent?.goal ?? subagent.goals[0]
  return (
    <>
      <CardShell slot="subagent-result" onClick={agent ? () => setOpen(true) : undefined}>
        <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <BotIcon className="size-4" />
          <span className="flex-1 truncate">{goal ? agentTitle(goal) : "Sub-Agent"}</span>
          {agent && <ChevronRightIcon className="size-4" />}
        </span>
        {agent && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
            <StatusIcon agent={agent} />
            {agentLine(agent)}
          </span>
        )}
      </CardShell>
      {agent && source && (
        <AgentPopup agent={agent} server={source.server} open={open} onOpenChange={setOpen} />
      )}
    </>
  )
}

/** The sub-thread pop-up a delegation's card and its result's message both open. */
function AgentPopup({
  agent,
  server,
  open,
  onOpenChange,
}: {
  agent: DelegatedAgent
  server: HermesConfig
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent size="xl">{open && <AgentView agent={agent} server={server} />}</PopupContent>
    </Popup>
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
