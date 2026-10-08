import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronDownIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { db, type Profile } from "@/lib/db"
import { formatTokens } from "@/lib/format"
import { getProjectUsage, type HermesProject, type ProjectUsage } from "@/lib/hermes"
import { estimateCost, type ModelUsage } from "@/lib/pricing"
import { cn } from "@/lib/utils"

const SHOWN = 5

const KINDS = [
  { key: "inputTokens", label: "Input", dot: "bg-usage-input" },
  { key: "outputTokens", label: "Output", dot: "bg-usage-output" },
  { key: "cacheWriteTokens", label: "Cache write", dot: "bg-usage-cache-write" },
  { key: "cacheReadTokens", label: "Cache read", dot: "bg-usage-cache-read" },
] as const

const SORTS = { share: "Share", cost: "Cost", recent: "Recent" } as const
type Sort = keyof typeof SORTS

const total = (usage: Omit<ModelUsage, "model">) =>
  usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens

const usd = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" })
const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 })

function formatCost({ usd: value, partial }: { usd: number; partial: boolean }) {
  return `${usd.format(value)}${partial ? "+" : ""}`
}

/** A project's usage: totals, the split by kind of token and each session's share. */
export function ProjectUsageView({
  profile,
  project,
}: {
  profile: Profile
  project: HermesProject
}) {
  const [usage, setUsage] = useState<ProjectUsage | null>()
  useEffect(() => {
    let cancelled = false
    getProjectUsage(profile, project.id)
      .then((value) => !cancelled && setUsage(value))
      .catch(() => !cancelled && setUsage(null))
    return () => {
      cancelled = true
    }
  }, [profile, project.id])
  if (usage === undefined)
    return (
      <div className="flex justify-center px-6 py-10">
        <Spinner className="size-5" />
      </div>
    )
  if (usage === null)
    return <p className="px-6 pb-8 text-sm text-muted-foreground">Couldn't load usage.</p>
  return <UsageDetails usage={usage} projectId={project.id} />
}

function UsageDetails({ usage, projectId }: { usage: ProjectUsage; projectId: string }) {
  const tokens = total(usage)
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  // An older plugin sends no sessions, so only Hermes's own total can be shown.
  const cost = usage.threads.length
    ? estimateCost(usage.threads.flatMap((thread) => thread.models))
    : usage.costUsd !== undefined
      ? { usd: usage.costUsd, partial: false }
      : undefined
  const stats: [string, string][] = [
    ["Sessions", String(usage.sessions)],
    ["Tokens", formatTokens(tokens)],
    ["Cache hit", prompt ? percent.format(usage.cacheReadTokens / prompt) : "–"],
    ["Est. cost", cost ? formatCost(cost) : "–"],
  ]
  return (
    <div className="flex flex-col gap-8 px-5 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-7">
      <section className="flex flex-col">
        <h3 className="text-base text-muted-foreground">This project</h3>
        <dl className="mb-6 grid grid-cols-2 gap-x-6 sm:gap-x-8">
          {stats.map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-2 border-b border-border py-3.5">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="truncate text-lg font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {tokens > 0 && (
          <div
            className="flex h-1.5 overflow-hidden rounded-full"
            role="img"
            aria-label={KINDS.map(
              ({ key, label }) => `${label} ${percent.format(usage[key] / tokens)}`,
            ).join(", ")}
          >
            {KINDS.filter(({ key }) => usage[key] > 0).map(({ key, dot }) => (
              <div
                key={key}
                className={cn("h-full min-w-1", dot)}
                style={{ flexGrow: usage[key] / tokens, flexBasis: 0 }}
              />
            ))}
          </div>
        )}
      </section>
      <section className="flex flex-col">
        <h3 className="border-b border-border pb-3 text-base text-muted-foreground">Breakdown</h3>
        <dl>
          {KINDS.map(({ key, label, dot }) => (
            <div key={key} className="flex min-h-12 items-center gap-3 border-b border-border">
              <span className={cn("size-2.5 shrink-0 rounded-full", dot)} aria-hidden />
              <dt className="flex-1">{label}</dt>
              <dd className="tabular-nums">{formatTokens(usage[key])}</dd>
            </div>
          ))}
          <div className="flex min-h-12 items-center gap-3 border-b border-border">
            <dt className="flex-1">Sessions</dt>
            <dd className="tabular-nums">{usage.sessions}</dd>
          </div>
        </dl>
      </section>
      {usage.threads.length > 0 && (
        <SessionList usage={usage} tokens={tokens} projectId={projectId} />
      )}
    </div>
  )
}

function SessionList({
  usage,
  tokens,
  projectId,
}: {
  usage: ProjectUsage
  tokens: number
  projectId: string
}) {
  const [sort, setSort] = useState<Sort>("share")
  const [expanded, setExpanded] = useState(false)
  // A session's name here is the one the user sees in the app, renames included.
  const names = useLiveQuery(
    async () =>
      new Map(
        (await db.conversations.where("projectId").equals(projectId).toArray()).map((chat) => [
          chat.hermesSessionId,
          chat.title,
        ]),
      ),
    [projectId],
  )
  const rows = useMemo(() => {
    const listed = usage.threads.map((thread) => {
      const sum = thread.models.reduce((all, model) => all + total(model), 0)
      return {
        id: thread.id,
        title: names?.get(thread.id) || thread.title || "Untitled",
        tokens: sum,
        cost: estimateCost(thread.models),
        lastActive: thread.lastActive ?? 0,
      }
    })
    const by = {
      share: (a: (typeof listed)[0], b: (typeof listed)[0]) => b.tokens - a.tokens,
      cost: (a: (typeof listed)[0], b: (typeof listed)[0]) => b.cost.usd - a.cost.usd,
      recent: (a: (typeof listed)[0], b: (typeof listed)[0]) => b.lastActive - a.lastActive,
    }[sort]
    return listed.sort(by)
  }, [usage.threads, names, sort])
  const largest = Math.max(1, ...rows.map((row) => row.tokens))
  const shown = expanded ? rows : rows.slice(0, SHOWN)
  return (
    <section className="flex flex-col">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base text-muted-foreground">Sessions</h3>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                className="-mr-3 h-11 gap-1.5 rounded-full px-3 text-muted-foreground"
                aria-label={`Sort by ${SORTS[sort]}`}
              />
            }
          >
            {SORTS[sort]}
            <ChevronDownIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuRadioGroup value={sort} onValueChange={(value) => setSort(value as Sort)}>
              {(Object.keys(SORTS) as Sort[]).map((option) => (
                <DropdownMenuRadioItem
                  key={option}
                  value={option}
                  className="min-h-11"
                  closeOnClick
                >
                  {SORTS[option]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <table className="w-full table-fixed border-separate border-spacing-0">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th className="font-normal">
              <span className="sr-only">Session</span>
            </th>
            <th className="w-14 font-normal sm:w-24">
              <span className="sr-only">Share of the largest</span>
            </th>
            <th className="w-16 pb-1 text-right font-normal sm:w-20">
              {sort === "cost" ? "Cost" : "Tokens"}
            </th>
            <th className="w-12 pb-1 text-right font-normal">Share</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row) => (
            <tr key={row.id} className="h-11">
              <td className="truncate pr-3">{row.title}</td>
              <td className="pr-3">
                <div className="h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full min-w-1 rounded-full bg-usage-input"
                    style={{ width: `${(row.tokens / largest) * 100}%` }}
                  />
                </div>
              </td>
              <td className="text-right tabular-nums">
                {sort === "cost" ? formatCost(row.cost) : formatTokens(row.tokens)}
              </td>
              <td className="text-right text-muted-foreground tabular-nums">
                {percent.format(tokens ? row.tokens / tokens : 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > SHOWN && (
        <Button
          variant="ghost"
          className="mt-2 -ml-3 h-11 gap-1.5 self-start rounded-full px-3 text-muted-foreground"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
        >
          {expanded ? "Show less" : `Show ${rows.length - SHOWN} more`}
          <ChevronDownIcon className={cn("transition-transform", expanded && "rotate-180")} />
        </Button>
      )}
    </section>
  )
}
