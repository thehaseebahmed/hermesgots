/**
 * Dictation: what the bots have heard, the way into each bot's own speech settings, and what all of
 * it adds up to. The screen draws from this device's mirror, so nothing here waits on a host; opening
 * it reconciles every bot in the background and caches the totals it reads (ADR 0060).
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckIcon, CopyIcon, Trash2Icon } from "lucide-react"
import { Link } from "react-router"
import { toast } from "sonner"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import {
  Caption,
  ConfirmDestructive,
  Group,
  ValueRow,
  linkRowClass,
  useHeaderAction,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { botTabPath } from "@/lib/bot-tabs"
import { connectionKey } from "@/lib/connection"
import { useCopied } from "@/lib/copied"
import { listProfiles, type DictationRecord, type Profile } from "@/lib/db"
import { byMonth, pooledRate, spelledCount } from "@/lib/dictation-log"
import {
  clearDictationLog,
  reconcileAll,
  removeDictation,
  useDictationCount,
  useDictationRows,
  useDictationTotals,
} from "@/lib/dictations"
import { usePluginFeature } from "@/lib/features"
import { cn } from "@/lib/utils"

/** The rows the History tab draws before the reader reaches the end of them. */
export const PAGE_ROWS = 20

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })

function clockOf(at: number) {
  return clockFormat.format(at)
}

function wordsLabel(words: number) {
  return `${spelledCount(words)} ${words === 1 ? "word" : "words"}`
}

export function DictationSettings() {
  const profiles = useLiveQuery(listProfiles, [])
  const [confirmed, setConfirmed] = useState(false)
  const [clearing, setClearing] = useState(false)

  // Once per open, every bot at a time: a matching fingerprint costs one small read, and a bot that
  // is away never holds up another. Nothing here is waited on before the first paint.
  const reconciled = useRef("")
  const ids = (profiles ?? []).map((profile) => profile.id).join(",")
  useEffect(() => {
    if (!profiles?.length || reconciled.current === ids) return
    reconciled.current = ids
    void reconcileAll(profiles)
  }, [ids, profiles])

  useHeaderAction(
    "dictation-clear",
    <Button
      variant="ghost"
      size="icon-lg"
      className="size-11 rounded-full text-muted-foreground"
      aria-label="Clear history"
      onClick={() => setConfirmed(true)}
    >
      <Trash2Icon />
    </Button>,
  )

  const clear = async () => {
    setClearing(true)
    try {
      const refused = await clearDictationLog(profiles ?? [])
      if (refused.length) toast.error(`Couldn't clear ${refused.join(", ")}.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't clear the history.")
    } finally {
      setClearing(false)
      setConfirmed(false)
    }
  }

  return (
    <>
      <Tabs defaultValue="history" className="flex flex-col gap-4">
        <TabsList>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="bots">Bots</TabsTrigger>
          <TabsTrigger value="stats">Stats</TabsTrigger>
        </TabsList>
        <TabsContent value="history" className="flex flex-col gap-4" data-dictation-history>
          <HistoryTab profiles={profiles ?? []} />
        </TabsContent>
        <TabsContent value="bots" className="flex flex-col gap-4" data-dictation-bots>
          <BotsTab profiles={profiles ?? []} />
        </TabsContent>
        <TabsContent value="stats" className="flex flex-col gap-4" data-dictation-stats>
          <StatsTab />
        </TabsContent>
      </Tabs>
      <ConfirmDestructive
        open={confirmed}
        title="Clear dictation history?"
        description="Every dictation goes, on this device and on every bot's host."
        confirmLabel="Clear"
        busy={clearing}
        onOpenChange={setConfirmed}
        onConfirm={() => void clear()}
      />
    </>
  )
}

/** Every dictation, newest first, a card of rows under each month it falls in. */
function HistoryTab({ profiles }: { profiles: Profile[] }) {
  const [shown, setShown] = useState(PAGE_ROWS)
  const rows = useDictationRows(shown)
  const total = useDictationCount() ?? 0
  const [open, setOpen] = useState<DictationRecord | null>(null)
  const [deleting, setDeleting] = useState<DictationRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)

  // The next page appends when the end of what is drawn comes into view.
  useEffect(() => {
    const node = sentinel.current
    if (!node || rows === undefined || rows.length < shown || rows.length >= total) return
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setShown((current) => Math.min(current + PAGE_ROWS, total))
      },
      { rootMargin: "200px" },
    )
    watcher.observe(node)
    return () => watcher.disconnect()
  }, [rows, shown, total])

  const names = useMemo(() => {
    const map = new Map<string, string>()
    for (const profile of profiles) map.set(connectionKey(profile), profile.name)
    return map
  }, [profiles])

  const groups = useMemo(() => byMonth(rows ?? []), [rows])

  const remove = async (row: DictationRecord) => {
    const profile = profiles.find((one) => connectionKey(one) === row.connection)
    if (!profile) return
    setBusy(true)
    try {
      await removeDictation(profile, row.id)
      setOpen(null)
      setDeleting(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't delete that dictation.")
    } finally {
      setBusy(false)
    }
  }

  if (rows?.length === 0)
    return <p className="px-5 py-6 text-sm text-muted-foreground">No dictations yet.</p>

  return (
    <>
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1.5">
          <Caption>{group.label}</Caption>
          <Group>
            {group.rows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setOpen(row)}
                className={cn(linkRowClass, "flex-col items-start gap-1")}
                data-dictation={row.id}
              >
                <span className="line-clamp-2 text-base">{row.text}</span>
                <span className="text-sm text-muted-foreground">
                  {[
                    clockOf(row.at),
                    names.get(row.connection),
                    wordsLabel(row.words),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            ))}
          </Group>
        </div>
      ))}
      <div ref={sentinel} aria-hidden className="h-px" />
      {open && (
        <EntrySheet
          row={open}
          bot={names.get(open.connection)}
          onOpenChange={(next) => !next && setOpen(null)}
          onDelete={() => setDeleting(open)}
        />
      )}
      <ConfirmDestructive
        open={deleting !== null}
        title="Delete this dictation?"
        description="It goes from this device and from its bot's host."
        confirmLabel="Delete"
        busy={busy}
        onOpenChange={(next) => !next && setDeleting(null)}
        onConfirm={() => deleting && void remove(deleting)}
      />
    </>
  )
}

/** One dictation, whole: its words, what it was, a Copy and a way to delete it. */
function EntrySheet({
  row,
  bot,
  onOpenChange,
  onDelete,
}: {
  row: DictationRecord
  bot?: string
  onOpenChange: (open: boolean) => void
  onDelete: () => void
}) {
  const { copied, noteCopied } = useCopied()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(row.text)
      noteCopied()
    } catch {
      toast.error("Couldn't copy that.")
    }
  }
  return (
    <Popup open onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader>
          <PopupTitle>{clockOf(row.at)}</PopupTitle>
        </PopupHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <p className="whitespace-pre-wrap text-base" data-dictation-text>
            {row.text}
          </p>
          <p className="text-sm text-muted-foreground">
            {[bot, wordsLabel(row.words), clockOf(row.at)].filter(Boolean).join(" · ")}
          </p>
          <div className="flex flex-col gap-2">
            <Button variant="outline" className="h-11" data-dictation-copy onClick={() => void copy()}>
              {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              variant="ghost"
              className="h-11 text-destructive hover:text-destructive"
              data-dictation-delete
              onClick={onDelete}
            >
              <Trash2Icon data-icon="inline-start" />
              Delete
            </Button>
          </div>
        </div>
      </PopupContent>
    </Popup>
  )
}

/** One row per bot, into its own speech settings, disabled where its host can't dictate. */
function BotsTab({ profiles }: { profiles: Profile[] }) {
  if (!profiles.length)
    return <p className="px-5 py-6 text-sm text-muted-foreground">No bots yet.</p>
  return (
    <Group>
      {profiles.map((profile) => (
        <BotLink key={profile.id} profile={profile} />
      ))}
    </Group>
  )
}

function BotLink({ profile }: { profile: Profile }) {
  const answer = usePluginFeature(profile, "dictation")
  const off = answer === "no"
  const body = (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-base">{profile.name}</span>
      {off && <span className="text-sm text-muted-foreground">Not available on this bot's host</span>}
    </span>
  )
  const path = botTabPath(profile.id, "speech-to-text")
  if (off)
    return (
      <div aria-disabled data-dictation-bot={profile.id} className={cn(linkRowClass, "opacity-60 hover:bg-card")}>
        {body}
      </div>
    )
  return (
    <Link to={path} data-dictation-bot={profile.id} className={linkRowClass}>
      {body}
    </Link>
  )
}

/** What every bot has added up to, as the hosts last reported it. */
function StatsTab() {
  const { totals } = useDictationTotals()
  const rate = pooledRate(totals.words, totals.ms)
  return (
    <>
      <Caption>All bots</Caption>
      <Group>
        <ValueRow
          title="Words spoken"
          value={spelledCount(totals.words)}
          data-setting="words-spoken"
        />
        <ValueRow
          title="Words per minute"
          value={rate === null ? "—" : String(rate)}
          data-setting="words-per-minute"
        />
      </Group>
    </>
  )
}
