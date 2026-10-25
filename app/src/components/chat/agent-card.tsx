import { useEffect, useRef, useState, type ReactNode } from "react"
import { BotIcon, CheckIcon, ChevronRightIcon, PauseIcon, SquareIcon } from "lucide-react"

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
  applyAnswers,
  stopOneAgent,
  useAgentsSource,
  type AgentsSource,
} from "@/lib/agents"
import { type Message, type SubagentRef, type ToolEvent } from "@/lib/db"
import { usePluginFeatureOn } from "@/lib/features"
import type { AgentStopRow, DelegatedAgent, HermesConfig } from "@/lib/hermes"
import { toMessages } from "@/lib/history"
import { useDraws } from "@/lib/openui-draws"
import { connectionKey } from "@/lib/connection"
import { cn } from "@/lib/utils"

const NO_ROWS: Message[] = []

const agentTitle = (goal: string) => `Sub-Agent: ${agentName(goal)}`

/** A `delegate_task` call: a card per agent it started. */
export function AgentCards({ tool }: { tool: ToolEvent }) {
  const source = useAgentsSource()
  const agents = source ? agentsOf(tool, source.agents) : []
  if (!source || agents.length === 0) return <PendingCard tool={tool} />
  return (
    <>
      {agents.map((agent) => (
        <SubagentCard key={agent.id} agent={agent} source={source} />
      ))}
    </>
  )
}

/**
 * One subagent as a card: what it is and how it is doing on the left — all of which opens its
 * sub-thread — and Stop on the right while it works, out of that tap target so a press can't open
 * the sub-thread by accident. Its commands and its goal are the sub-thread's to show, not the
 * card's.
 */
export function SubagentCard({
  agent,
  source,
  slot = "agent-card",
}: {
  agent: DelegatedAgent
  source: AgentsSource
  /** What a test (or a style) can name the card by. */
  slot?: string
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  // The host's own answer to this card's Stop, read here at once: the next list read may be a poll
  // away, and the card should not go on offering to stop something it was just told has stopped.
  const [answer, setAnswer] = useState<AgentStopRow & { at: number }>()
  const stoppable = usePluginFeatureOn(source.server, "subagent_stop")
  const shown = applyAnswers([agent], answer ? [answer] : [])[0]
  const canStop = shown.status === "running" && Boolean(source.sessionId) && stoppable && !busy
  const note = failure ?? shown.stopReason
  const stop = async () => {
    if (!source.sessionId) return
    setBusy(true)
    setFailure(undefined)
    try {
      const row = await stopOneAgent(source.server, source.sessionId, agent)
      setAnswer({ ...row, at: Date.now() / 1000 })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Couldn't stop this subagent.")
    } finally {
      setBusy(false)
    }
  }
  const open = source.onOpen
  const body = (
    <CardBody
      title={agentTitle(shown.goal)}
      line={
        <>
          <StatusIcon agent={shown} />
          <span className="min-w-0 truncate">{note ?? agentLine(shown)}</span>
        </>
      }
      chevron={Boolean(open)}
    />
  )
  return (
    <div
      data-slot={slot}
      data-agent={agent.id}
      className={cn(FLAT_CARD, "flex items-center gap-3 px-4 py-3")}
    >
      {open ? (
        <button
          type="button"
          onClick={() => open(shown)}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl text-left outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </button>
      ) : (
        <span className="flex min-h-11 min-w-0 flex-1 items-center gap-3">{body}</span>
      )}
      {canStop && (
        <Button
          variant="outline"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          aria-label={`Stop ${agentName(agent.goal)}`}
          onClick={() => void stop()}
        >
          <SquareIcon className="size-4 fill-current" />
        </Button>
      )}
    </div>
  )
}

function CardBody({
  title,
  line,
  chevron = false,
  className,
}: {
  title: ReactNode
  line?: ReactNode
  chevron?: boolean
  className?: string
}) {
  return (
    <span className={cn("flex min-w-0 flex-1 flex-col gap-1", className)}>
      <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <BotIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {chevron && <ChevronRightIcon className="size-4 shrink-0" />}
      </span>
      {line && (
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
          {line}
        </span>
      )}
    </span>
  )
}

function PendingCard({ tool }: { tool: ToolEvent }) {
  const running = tool.status === "running"
  return (
    <div data-slot="agent-card" className={cn(FLAT_CARD, "flex items-center gap-3 px-4 py-3")}>
      <CardBody
        className="min-h-11 justify-center"
        title={agentTitle(tool.label)}
        line={
          running && (
            <>
              <Spinner className="size-3" />
              Working
            </>
          )
        }
      />
    </div>
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

/**
 * A subagent's result, as the thread draws it: a line naming the subagent whose work it is, opening
 * the same sub-thread its card does. A chat that can't name the subagent still draws the line — the
 * result itself is the message — with nothing to open.
 */
export function SubagentResultCard({ subagent }: { subagent: SubagentRef }) {
  const source = useAgentsSource()
  const agent = source ? agentOfResult(subagent, source.agents) : undefined
  if (agent && source) return <SubagentCard agent={agent} source={source} slot="subagent-result" />
  const goal = subagent.goals[0]
  return (
    <div data-slot="subagent-result" className={cn(FLAT_CARD, "flex items-center gap-3 px-4 py-3")}>
      <CardBody className="min-h-11 justify-center" title={goal ? agentTitle(goal) : "Sub-Agent"} />
    </div>
  )
}

/**
 * The sub-thread pop-up an agent's card, its result's line and the subagent sheet all open. The
 * screen draws it rather than the card, so a press inside the sheet can close the sheet and open
 * this.
 */
export function AgentPopup({
  agent,
  server,
  open,
  onOpenChange,
}: {
  agent: DelegatedAgent | undefined
  server: HermesConfig
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent size="xl">
        {open && agent && <AgentView agent={agent} server={server} />}
      </PopupContent>
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
