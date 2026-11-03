import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CopyIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Chip, ChipRow } from "@/components/chip"
import { Group, useHeaderAction } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { copyText } from "@/lib/copied"
import { db, listProfiles, type NetRequest } from "@/lib/db"
import { clockText, DRAWN, endingLabel, figuresOf, formatNetLog, waitText } from "@/lib/net-log"
import { clearNetLog } from "@/lib/net-recorder"

/**
 * Settings > Developer > Network log: this device's own requests to each bot's host, with the
 * numbers a slow app is diagnosed by (ADR 0086). The pills pick one bot or all of them; the summary
 * strip reads the selection's waits; the table is every request still in the log, newest first.
 *
 * The switch that records is Developer's own row: turning it off leaves what it measured to read.
 */
export function NetworkLogScreen() {
  const rows = useLiveQuery(() => db.netLog.orderBy("at").reverse().toArray(), [])
  const bots = useLiveQuery(listProfiles, [])
  const [chosen, setChosen] = useState<string>()

  const names = new Map((bots ?? []).map((bot) => [bot.id, bot.name]))
  const all = rows ?? []
  const heard = (bots ?? []).filter((bot) => all.some((row) => row.bots.includes(bot.id)))
  // A pick only holds while its bot is still in the log: a cleared log leaves no filter to get stuck in.
  const picked = chosen && heard.some((bot) => bot.id === chosen) ? chosen : undefined
  const shown = picked ? all.filter((row) => row.bots.includes(picked)) : all
  const drawn = shown.slice(0, DRAWN)
  const figures = figuresOf(shown)

  useHeaderAction(
    "network-log",
    <>
      <Button
        variant="outline"
        size="icon-lg"
        className="size-11 rounded-full"
        aria-label="Copy the network log"
        disabled={!all.length}
        onClick={() => void copyText(formatNetLog(all), () => toast("Network log copied"))}
      >
        <CopyIcon />
      </Button>
      <Button
        variant="outline"
        size="icon-lg"
        className="ml-2 size-11 rounded-full"
        aria-label="Clear the network log"
        disabled={!all.length}
        onClick={() =>
          void clearNetLog().then(
            () => toast("Network log cleared"),
            () => toast.error("Couldn't clear the log."),
          )
        }
      >
        <Trash2Icon />
      </Button>
    </>,
  )

  // Nothing drawn until the log has been read: an empty table would say "nothing recorded" for a moment.
  if (!rows) return null
  if (!all.length)
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">No requests recorded yet.</p>
    )

  return (
    <>
      {heard.length > 1 && (
        <ChipRow label="Bots">
          <Chip active={!picked} onClick={() => setChosen(undefined)}>
            All
          </Chip>
          {heard.map((bot) => (
            <Chip
              key={bot.id}
              active={picked === bot.id}
              onClick={() => setChosen(picked === bot.id ? undefined : bot.id)}
            >
              {bot.name}
            </Chip>
          ))}
        </ChipRow>
      )}

      <Group>
        <dl className="grid grid-cols-2 gap-x-6 bg-card px-5 py-4">
          {(
            [
              ["Average", waitText(figures.average)],
              ["Slowest 5%", waitText(figures.slowest)],
              ["Failed", `${figures.failed} of ${figures.count}`],
              ["Connected in", waitText(figures.open)],
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
            <span className="text-base font-medium tabular-nums">{waitText(figures.words)}</span>
            {/* Not the network's own number: the host's queue and the model's start are in it. */}
            <span className="ml-auto text-xs text-muted-foreground">not network time</span>
          </div>
        )}
      </Group>

      <NetTable rows={drawn} names={names} />

      {shown.length > drawn.length && (
        <p className="text-center text-xs text-muted-foreground">
          Newest {drawn.length} of {shown.length} requests
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
          {rows.map((row) => (
            <tr key={row.id} className="h-11 border-t border-border">
              <td className="pr-3 pl-4 tabular-nums">{clockText(row.at)}</td>
              <td className="max-w-28 truncate pr-3">
                {row.bots.map((id) => names.get(id) ?? "A bot").join(", ") || "—"}
              </td>
              <td className="max-w-56 truncate pr-3 font-mono text-xs">{row.route}</td>
              <td className="pr-3 text-right tabular-nums">{waitText(row.ms)}</td>
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
