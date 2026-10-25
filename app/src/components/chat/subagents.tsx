import { useState } from "react"

import { AgentPopup, SubagentCard } from "@/components/chat/agent-card"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { runningAgents, type AgentsSource } from "@/lib/agents"
import type { DelegatedAgent } from "@/lib/hermes"

const newestFirst = (agents: DelegatedAgent[]) =>
  [...agents].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))

/** Every subagent of a session, in one sheet: the ones at work first, then the ones finished. */
export function SubagentsSheet({
  open,
  onOpenChange,
  source,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  source: AgentsSource | undefined
}) {
  const [shown, setShown] = useState<DelegatedAgent>()
  if (!source) return null
  return (
    <>
      <Popup open={open} onOpenChange={onOpenChange}>
        <PopupContent size="lg">
          {open && <Groups source={source} onOpen={setShown} />}
        </PopupContent>
      </Popup>
      <AgentPopup
        agent={shown}
        server={source.server}
        open={shown !== undefined}
        onOpenChange={(next) => !next && setShown(undefined)}
      />
    </>
  )
}

function Groups({
  source,
  onOpen,
}: {
  source: AgentsSource
  onOpen: (agent: DelegatedAgent) => void
}) {
  const agents = source.agents
  const inside: AgentsSource = { ...source, onOpen }
  return (
    <>
      <PopupHeader>
        <PopupTitle>Subagents</PopupTitle>
      </PopupHeader>
      <div className="flex flex-col gap-5 px-4 pb-6">
        {agents.length === 0 && (
          <p className="px-1 text-sm text-muted-foreground">No subagents yet.</p>
        )}
        <Group group="running" agents={newestFirst(runningAgents(agents))} source={inside} />
        <Group
          group="finished"
          agents={newestFirst(agents.filter((agent) => agent.status !== "running"))}
          source={inside}
        />
      </div>
    </>
  )
}

type GroupKey = "running" | "finished"

function Group({
  group,
  agents,
  source,
}: {
  group: GroupKey
  agents: DelegatedAgent[]
  source: AgentsSource
}) {
  if (agents.length === 0) return null
  return (
    <section className="flex flex-col gap-2" data-group={group}>
      <h2 className="px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {group === "running" ? "Running" : "Finished"}
      </h2>
      <div className="flex flex-col gap-2">
        {agents.map((agent) => (
          <SubagentCard key={agent.id} agent={agent} source={source} slot="sheet-agent-card" />
        ))}
      </div>
    </section>
  )
}
