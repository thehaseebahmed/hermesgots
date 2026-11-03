import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CopyIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Chip } from "@/components/chip"
import { Group, useHeaderAction } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { db, listProfiles, type NetRequest } from "@/lib/db"
import { clockLabel, DRAWN, endingLabel, figuresOf, formatNetLog, waitLabel } from "@/lib/net-log"

/**
 * Settings > Developer > Network log: this device's own requests to each bot's host, with the
 * numbers a slow app is diagnosed by (ADR 0086). The pills pick one bot or all of them; the summary
 * strip reads the selection's waits; the table is every request still in the log, newest first.
 *
 * The switch that records is Developer's own row, not this screen's: turning recording off leaves
 * what it already measured here to read, and Clear log is what empties it.
 */
export function NetworkLogScreen() {
  const rows = useLiveQuery(() => db.netLog.orderBy("at").reverse().toArray(), [])
  const bots = useLiveQuery(listProfiles, [])
  const [picked, setPicked] = useState<string>()
  const [busy, setBusy] = useState(false)

  const all = rows ?? []
  const shown = picked ? all.filter((row) => row.bot.includes(picked)) : all
  const figures = figuresOf(shown)
  const names = new Map((bots ?? []).map((bot) => [bot.id, bot.name]))
  /** The bots this log has heard from, in the order the list holds them. */
  const heard = (bots ?? []).filter((bot) => all.some((row) => row.bot.includes(bot.id)))

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatNetLog(all))
      toast("Network log copied")
    } catch {
      toast.error("Couldn't copy that.")
    }
  }

  const clear = async () => {
    setBusy(true)
    try {
      await db.netLog.clear()
      toast("Network log cleared")
    } finally {
      setBusy(false)
    }
  }

  useHeaderAction(
    "network-log",
    <>
      <Button
        variant="outline"
        size="icon-lg"
        className="size-11 rounded-full"
        aria-label="Copy the network log"
        disabled={!all.length}
        onClick={() => void copy()}
      >
        <CopyIcon />
      </Button>
      <Button
        variant="outline"
        size="icon-lg"
        className="ml-2 size-11 rounded-full"
        aria-label="Clear the network log"
        disabled={!all.length || busy}
        onClick={() => void clear()}
      >
        <Trash2Icon />
      </Button>
    </>,
  )

  if (!all.length)
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No requests recorded yet. Turn on Network log in Developer settings, then use a bot.
      </p>
    )

  return (
    <>
      {heard.length > 1 && (
        <div
          className="-mx-4 flex [scrollbar-width:none] gap-2 overflow-x-auto px-4"
          role="group"
          aria-label="Bots"
        >
          <Chip active={!picked} onClick={() => setPicked(undefined)}>
            All
          </Chip>
          {heard.map((bot) => (
            <Chip
              key={bot.id}
              active={picked === bot.id}
              onClick={() => setPicked(picked === bot.id ? undefined : bot.id)}
            >
              {bot.name}
            </Chip>
          ))}
        </div>
      )}

      <Group>
        <dl className="grid grid-cols-2 gap-x-6 bg-card px-5 py-4">
          {(
            [
              ["Average", waitLabel(figures.average)],
              ["Slowest 5%", waitLabel(figures.slowest)],
              ["Failed", `${figures.failed} of ${figures.count}`],
              ["Connected in", waitLabel(figures.open)],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex flex-col py-1">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className="text-lg font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {figures.words !== null && (
          <div className="flex items-baseline gap-2 bg-card px-5 py-3">
            <span className="text-sm text-muted-foreground">First words</span>
            <span className="text-base font-medium tabular-nums">{waitLabel(figures.words)}</span>
            {/* Not the network's own number: the host's queue and the model's start are in it. */}
            <span className="ml-auto text-xs text-muted-foreground">not network time</span>
          </div>
        )}
      </Group>

      <NetTable rows={shown} names={names} />

      {shown.length > DRAWN && (
        <p className="text-center text-xs text-muted-foreground">
          Newest {DRAWN} of {shown.length} requests
        </p>
      )}
    </>
  )
}

/** The requests as a table: five columns, scrolling sideways rather than dropping one. */
function NetTable({ rows, names }: { rows: NetRequest[]; names: Map<string, string> }) {
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[34rem] text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1 pr-3 pl-4 font-normal">Time</th>
            <th className="pr-3 font-normal">Bot</th>
            <th className="pr-3 font-normal">Request</th>
            <th className="pr-3 text-right font-normal">Took</th>
            <th className="py-1 pr-4 text-right font-normal">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, DRAWN).map((row) => (
            <tr key={row.id} className="h-11 border-t border-border">
              <td className="pr-3 pl-4 tabular-nums">{clockLabel(row.at)}</td>
              <td className="max-w-28 truncate pr-3">
                {row.bot.map((id) => names.get(id) ?? "A bot").join(", ") || "—"}
              </td>
              <td className="max-w-56 truncate pr-3 font-mono text-xs">{row.route}</td>
              <td className="pr-3 text-right tabular-nums">{waitLabel(row.ms)}</td>
              <td className="py-1 pr-4 text-right tabular-nums">
                {endingLabel(row)}
                {row.stream && <span className="ml-1 text-xs text-muted-foreground">stream</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
