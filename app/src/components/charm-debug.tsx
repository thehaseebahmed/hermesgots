import { useEffect, useRef, useState } from "react"
import { CopyIcon, Trash2Icon } from "lucide-react"

import { Group, useHeaderAction } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { formatBytes } from "@/lib/attachment-caps"
import {
  charmDiagnose,
  charmLog,
  charmLogSince,
  setCharmLog,
  usePairedCharm,
  type PairedCharm,
} from "@/lib/charm"
import { clear, lines, place, text, type CharmBook } from "@/lib/charm-book"
import type { CharmDiagnose, CharmLogRow, CharmLogSincePage } from "@/lib/charm-protocol"
import { micExitWords } from "@/lib/charm-words"
import { copyText } from "@/lib/copied"
import { CHARM_POLL_MS } from "@/lib/freshness"
import { tell } from "@/lib/tell"

/**
 * What the page needs of the charm. A page mounted in a test is handed a stand-in, as the network's
 * is. `since` answers the rows after an index, or null for a charm whose firmware predates the op.
 */
export interface CharmDebugApi {
  diagnose: () => Promise<CharmDiagnose>
  log: () => Promise<CharmLogRow[]>
  since: (from: number) => Promise<CharmLogSincePage[] | null>
  setLog: (on: boolean) => Promise<boolean>
}

const LIVE: CharmDebugApi = {
  diagnose: charmDiagnose,
  log: charmLog,
  since: charmLogSince,
  setLog: setCharmLog,
}

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
 *
 * What it has read it keeps as a book, and each read asks only for the rows after the last it holds:
 * the ring holds a handful of seconds and drops its oldest as it fills, so a list replaced whole every
 * two seconds loses the line that fell off between reads. A charm older than that ask answers
 * `BadMessage` to it, so its tail is read and replaced instead.
 *
 * The book leaves the phone whole, through the header's copy: a line per line, oldest first, with
 * nothing added, since a log is pasted into a report far more often than it is read here twice. A
 * clear empties it and reads on past what it held, so what arrives next is what the charm printed
 * from then on rather than what was just dropped.
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
  const [book, setBook] = useState<CharmBook | null>(null)
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The book the next read starts from, and whether a read is still running: a drain is several round
  // trips, and two over the charm's one link would fight for its answers.
  const held = useRef<CharmBook>({ rows: [], next: 0 })
  const reading = useRef(false)
  // How many times the reader has cleared the book. A read answers with the book it started from, so
  // one that lands after a clear is dropped rather than drawn.
  const cleared = useRef(0)

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
    const poll = async () => {
      // A tick that lands while a drain is still out is dropped: the drain will place what it read,
      // and a second one would ask the charm for an answer the first is still waiting on.
      if (reading.current) return
      reading.current = true
      // The clear this read started before: a drain that answers after the reader emptied the book is
      // the book it was reading, and placing it would put the cleared lines back.
      const sinceClear = cleared.current
      const pull = async () => {
        const pages = await api.since(held.current.next)
        // No book is a charm whose firmware predates the op: its tail is read whole and replaced.
        return pages ? pages.reduce(place, held.current) : fromTail(await api.log())
      }
      try {
        const [next, grown] = await Promise.all([api.diagnose(), pull()])
        if (!open || sinceClear !== cleared.current) return
        held.current = grown
        setReport(next)
        setBook(grown)
        setError(null)
      } catch (why: unknown) {
        if (open) setError(why instanceof Error ? why.message : String(why))
      } finally {
        reading.current = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), CHARM_POLL_MS)
    return () => {
      open = false
      clearInterval(timer)
    }
  }, [live, api])

  // Copy hands over the book the page is showing, and the header republishes this node on every
  // render, so neither handler can be older than the lines on screen. Clear empties the ref the next
  // read starts from and the book the page draws together: a ref left behind would re-place the next
  // page from an index inside the rows just cleared, and they would come back with the read. Both are
  // shut while the book is empty, since there is nothing to copy and nothing to clear.
  const drawn = book ? lines(book) : []
  useHeaderAction(
    "charm-debug",
    <>
      <Button
        variant="outline"
        size="icon-lg"
        className="size-11 rounded-full"
        aria-label="Copy the charm's log"
        disabled={!drawn.length}
        onClick={() => {
          if (book) void copyText(text(book), () => tell.note("Charm log copied"))
        }}
      >
        <CopyIcon />
      </Button>
      <Button
        variant="outline"
        size="icon-lg"
        className="ml-2 size-11 rounded-full"
        aria-label="Clear the charm's log"
        disabled={!drawn.length}
        onClick={() => {
          const emptied = clear(held.current)
          held.current = emptied
          cleared.current++
          setBook(emptied)
        }}
      >
        <Trash2Icon />
      </Button>
    </>,
  )

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
        {drawn.length > 0 ? (
          <div className="px-5 py-3 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
            {drawn.map((line, i) => (
              // A line is whole, and wrapped at the phone's width: the panel's twenty-six columns are
              // where the firmware broke it, not where this screen has to.
              <div key={i}>{line || " "}</div>
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

/**
 * The tail as a book: a charm older than `LogSince` answers rows with no index, so they are numbered
 * from zero here and the next ask starts there too. Rebuilt on every read, because a tail cannot say
 * which of its rows the page already holds — the one thing a book is for.
 */
function fromTail(rows: CharmLogRow[]): CharmBook {
  return { rows: rows.map((row, index) => ({ ...row, index })), next: 0 }
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
