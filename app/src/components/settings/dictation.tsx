/**
 * Dictation: what the bots have heard, the way into each bot's own speech settings, and what all of
 * it adds up to. The screen draws from this device's mirror, so nothing here waits on a host; opening
 * it reconciles every bot in the background and caches the totals it reads (ADR 0060).
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckIcon, CopyIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Bot } from "@/components/bot"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import {
  Caption,
  ConfirmDestructive,
  Group,
  LinkRow,
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
import { useDictationInfo } from "@/lib/dictation"
import { byMonth, pooledRate, spelledCount, wordsLabel } from "@/lib/dictation-log"
import {
  clearDictationLog,
  reconcileAll,
  removeDictation,
  useDictationRows,
  useDictationTotals,
} from "@/lib/dictations"
import { formatDuration } from "@/lib/format"
import { useSpeech, type SpeechCheck } from "@/lib/host-speech"
import { cn } from "@/lib/utils"

/** The rows the History tab draws before the reader reaches the end of them. */
export const PAGE_ROWS = 20

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })

function clockOf(at: number) {
  return clockFormat.format(at)
}

/** How long the words took to say, in the app's own duration format. */
function spokenLabel(ms: number) {
  return `${formatDuration(ms)} spoken`
}

export function DictationSettings() {
  const profiles = useLiveQuery(listProfiles, [])
  const [confirmed, setConfirmed] = useState(false)
  const [clearing, setClearing] = useState(false)

  // Once per open, every bot at a time: a matching fingerprint costs one small read, and a bot that
  // is away never holds up another. Nothing here is waited on before the first paint.
  const reconciled = useRef("")
  const bots = useRef(profiles)
  bots.current = profiles
  const ids = (profiles ?? []).map((profile) => profile.id).join(",")
  useEffect(() => {
    if (!ids || reconciled.current === ids) return
    reconciled.current = ids
    void reconcileAll(bots.current ?? [])
  }, [ids])

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
  // One row more than is drawn is what says there is more, so the list needs no separate count.
  const page = useDictationRows(shown + 1)
  const rows = page?.slice(0, shown)
  const more = (page?.length ?? 0) > shown
  const [open, setOpen] = useState<DictationRecord | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = sentinel.current
    if (!node || !more) return
    const watcher = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setShown((current) => current + PAGE_ROWS)
      },
      { rootMargin: "200px" },
    )
    watcher.observe(node)
    return () => watcher.disconnect()
  }, [more])

  const byConnection = useMemo(
    () => new Map(profiles.map((profile) => [connectionKey(profile), profile])),
    [profiles],
  )
  const groups = byMonth(rows ?? [])

  const remove = async (row: DictationRecord) => {
    const profile = byConnection.get(row.connection)
    if (!profile) return
    setBusy(true)
    try {
      await removeDictation(profile, row.id)
      setOpen(null)
      setConfirming(false)
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
                  {[byConnection.get(row.connection)?.name, wordsLabel(row.words)]
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
          bot={byConnection.get(open.connection)?.name}
          onOpenChange={(next) => !next && setOpen(null)}
          onDelete={() => setConfirming(true)}
        />
      )}
      <ConfirmDestructive
        open={confirming && open !== null}
        title="Delete this dictation?"
        description="It goes from this device and from its bot's host."
        confirmLabel="Delete"
        busy={busy}
        onOpenChange={(next) => !next && setConfirming(false)}
        onConfirm={() => open && void remove(open)}
      />
    </>
  )
}

/**
 * One dictation, whole: the words as the host heard them under **Heard**, the tidied text under
 * **Tidied** where the cleanup changed anything, what it was, a Copy and a way to delete it (ADR 0062).
 */
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
  const heard = row.heard?.trim() || undefined
  // What the cleanup changed, if anything: a take it left alone lands as the words the host heard, so
  // it reads as one block rather than the same text twice (ADR 0062).
  const tidied = heard !== undefined && heard !== row.text
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
          {heard && (
            <p className="text-base whitespace-pre-wrap" data-dictation-heard>
              <span className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
                Heard
              </span>
              {heard}
            </p>
          )}
          {heard && !tidied ? null : (
            <p className="text-base whitespace-pre-wrap" data-dictation-text>
              {tidied && (
                <span className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
                  Tidied
                </span>
              )}
              {row.text}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {[bot, wordsLabel(row.words), spokenLabel(row.ms)].filter(Boolean).join(" · ")}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="h-11 flex-1 text-destructive hover:text-destructive"
              data-dictation-delete
              onClick={onDelete}
            >
              <Trash2Icon data-icon="inline-start" />
              Delete
            </Button>
            <Button
              variant="outline"
              className="h-11 flex-1"
              data-dictation-copy
              onClick={() => void copy()}
            >
              {copied ? (
                <CheckIcon data-icon="inline-start" />
              ) : (
                <CopyIcon data-icon="inline-start" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      </PopupContent>
    </Popup>
  )
}

/** One row per bot: the Settings menu's own row, into that bot's speech settings. */
function BotsTab({ profiles }: { profiles: Profile[] }) {
  if (!profiles.length)
    return <p className="px-5 py-6 text-sm text-muted-foreground">No bots yet.</p>
  return (
    <Group>
      {profiles.map((profile) => (
        <BotRow key={profile.id} profile={profile} />
      ))}
    </Group>
  )
}

/**
 * What a bot's host is doing about speech: the host's own sentence where it can't dictate, else the
 * model it last reported, "Checking…" until it reports one, and a word where the read itself failed.
 */
function speechLine({
  model,
  check,
  reason,
}: {
  model?: string
  check?: SpeechCheck
  reason?: string
}) {
  if (reason) return reason
  if (model) return `On · ${model}`
  if (check === "failed") return "Couldn't read this bot's host."
  if (check === "checking") return "Checking…"
  return "Off"
}

function BotRow({ profile }: { profile: Profile }) {
  const answer = useDictationInfo(profile)
  const reason = answer && answer.status === "off" ? answer.reason : undefined
  const { model, check } = useSpeech(profile)
  return (
    <LinkRow
      to={botTabPath(profile.id, "speech-to-text")}
      data-dictation-bot={profile.id}
      leading={
        <Bot
          id={profile.botId}
          className={cn("size-8 shrink-0", profile.disabled && "opacity-40")}
        />
      }
      title={profile.name}
      subtitle={speechLine({ model, check, reason })}
    />
  )
}

/** What a value reads where nothing has been reported for it yet. */
const UNSET = "—"

/** What every bot has added up to, as the hosts last reported it. */
function StatsTab() {
  const { totals, reported } = useDictationTotals()
  const rate = pooledRate(totals.words, totals.ms)
  return (
    <Group>
      <ValueRow
        title="Words spoken"
        purpose="Every word you've spoken so far"
        value={reported ? spelledCount(totals.words) : UNSET}
        data-setting="words-spoken"
      />
      <ValueRow
        title="Words per minute"
        purpose="This is your pooled pace"
        value={rate === null ? UNSET : String(rate)}
        data-setting="words-per-minute"
      />
    </Group>
  )
}
