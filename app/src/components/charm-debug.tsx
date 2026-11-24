import { useEffect, useState } from "react"

import { Group } from "@/components/settings-chrome"
import { formatBytes } from "@/lib/attachment-caps"
import { charmDiagnose, charmLog, setCharmLog, usePairedCharm, type PairedCharm } from "@/lib/charm"
import type { CharmDiagnose, CharmLogRow } from "@/lib/charm-protocol"
import { micExitWords } from "@/lib/charm-words"
import { CHARM_POLL_MS } from "@/lib/freshness"

/** What the page needs of the charm. A page mounted in a test is handed a stand-in, as the network's is. */
export interface CharmDebugApi {
  diagnose: () => Promise<CharmDiagnose>
  log: () => Promise<CharmLogRow[]>
  setLog: (on: boolean) => Promise<boolean>
}

const LIVE: CharmDebugApi = { diagnose: charmDiagnose, log: charmLog, setLog: setCharmLog }

/**
 * Settings > Developer > Debug Charm: the last press's microphone refusal and the charm's own log,
 * read over the link the phone already has. The band says "No mic" for every door a press's
 * microphone can refuse at; this says which door, with the heap that was there, and the lines the
 * firmware printed around it.
 *
 * Opening the page arms the charm's log and closing it releases it — the charm keeps one only while
 * it is asked to, and lets go by itself a minute after this phone leaves the link. The page reads
 * every two seconds rather than on a button: a log is watched, and a failure's reason arrives after
 * the failure, not when a thumb asks for it.
 */
export function CharmDebugScreen({
  api = LIVE,
  charm,
}: {
  api?: CharmDebugApi
  charm?: PairedCharm | null
}) {
  const paired = usePairedCharm()
  const live = charm === undefined ? paired : charm
  const [report, setReport] = useState<CharmDiagnose | null>(null)
  const [rows, setRows] = useState<CharmLogRow[] | null>(null)
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Armed while the page is open, released when it closes. The charm's own minute is what covers a
  // page closed by a dead battery rather than by the reader, so nothing here has to be trusted.
  useEffect(() => {
    if (!live) return
    let open = true
    void api
      .setLog(true)
      .then((on) => {
        if (open) setArmed(on)
      })
      .catch((why: unknown) => {
        if (open) setError(why instanceof Error ? why.message : String(why))
      })
    return () => {
      open = false
      void api.setLog(false).catch(() => {})
    }
  }, [live, api])

  // Every two seconds, both halves: the record the board keeps and the rows it is printing. A page
  // that read once would show a failure's log as it stood when the reader arrived.
  useEffect(() => {
    if (!live) return
    let open = true
    const read = async () => {
      try {
        const [next, logRows] = await Promise.all([api.diagnose(), api.log()])
        if (!open) return
        setReport(next)
        setRows(logRows)
        setError(null)
      } catch (why: unknown) {
        if (open) setError(why instanceof Error ? why.message : String(why))
      }
    }
    void read()
    const timer = setInterval(() => void read(), CHARM_POLL_MS)
    return () => {
      open = false
      clearInterval(timer)
    }
  }, [live, api])

  if (!live) {
    return (
      <p className="px-5 text-sm text-muted-foreground">Pair a charm in Settings › Charm first.</p>
    )
  }

  // A record nobody has written is not a reading: three zeros would say the charm had no bytes left
  // rather than that no press has asked it for a microphone.
  const counted = report?.asked ? report : null
  return (
    <>
      <p className="px-5 text-sm text-muted-foreground">The last press</p>
      <Group>
        <Line
          title="Refused at"
          value={!report ? "…" : report.asked ? micExitWords(report.exit) : "No press since boot"}
        />
        <Line title="Internal heap" value={counted ? formatBytes(counted.freeInternal) : "—"} />
        <Line title="Largest block" value={counted ? formatBytes(counted.largestInternal) : "—"} />
        <Line title="PSRAM" value={counted ? formatBytes(counted.freePsram) : "—"} />
      </Group>

      <p className="px-5 text-sm text-muted-foreground">
        The charm's log{armed ? "" : " — not armed"}
      </p>
      <Group>
        {rows && rows.length > 0 ? (
          <div className="px-5 py-3 font-mono text-xs leading-5 whitespace-pre">
            {rows.map((row, i) => (
              // A carried-on row is indented under the line it belongs to, so a wrapped line reads as
              // one line and not as two the firmware never printed.
              <div key={i} className={row.carried ? "pl-3" : undefined}>
                {row.text || " "}
              </div>
            ))}
          </div>
        ) : (
          <p className="px-5 py-3 text-sm text-muted-foreground">
            {armed ? "The charm has not printed anything yet." : "The charm is not keeping a log."}
          </p>
        )}
      </Group>

      {error && <p className="px-5 text-sm text-destructive">{error}</p>}
    </>
  )
}

/** One label and its answer, in the shape every settings row on this screen has. */
function Line({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 bg-background px-5 py-3">
      <span className="text-sm">{title}</span>
      <span className="text-right text-sm text-muted-foreground">{value}</span>
    </div>
  )
}
