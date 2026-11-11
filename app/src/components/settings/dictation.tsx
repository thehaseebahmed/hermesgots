/**
 * Dictation: what the bots have heard, the way into each bot's own speech settings, and what all of
 * it adds up to. The screen draws from this device's mirror, so nothing here waits on a host; opening
 * it reconciles every bot in the background and caches the totals it reads (ADR 0060).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckIcon, CopyIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Bot } from "@/components/bot"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { ConfirmDestructive } from "@/components/confirm-destructive"
import {
  Caption,
  Group,
  LinkRow,
  PickList,
  PickSurface,
  SwitchRow,
  ValueRow,
  linkRowClass,
  useHeaderAction,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { botTabPath } from "@/lib/bot-tabs"
import {
  bubbleAvailable,
  bubbleState,
  disableBubble,
  enableBubble,
  mirrorBubble,
  openBubbleAccessibility,
  openBubbleOverlay,
  requestBubbleMicrophone,
  type BubbleState,
} from "@/lib/bubble"
import { connectionKey } from "@/lib/connection"
import { copyText, useCopied } from "@/lib/copied"
import {
  db,
  getBubbleProfile,
  listEnabledProfiles,
  listProfiles,
  setBubbleProfile,
  type DictationRecord,
  type Profile,
} from "@/lib/db"
import { useDictationInfo } from "@/lib/dictation"
import { byMonth, pooledRate, spelledCount, textsOf, wordsLabel } from "@/lib/dictation-log"
import {
  clearDictationLog,
  reconcileAll,
  removeDictation,
  useDictationRows,
  useDictationTotals,
} from "@/lib/dictations"
import { formatDuration } from "@/lib/format"
import { botModelLine, levelName, namedLevel, type SpeechSettings } from "@/lib/speech"
import { READ_FAILED, getSpeech, useSpeech, type SpeechCheck } from "@/lib/host-speech"
import { cn } from "@/lib/utils"
import { onReturn } from "@/lib/wake"

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
      <Tabs defaultValue="overview" className="flex flex-col gap-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="bots">Bots</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="flex flex-col gap-4" data-dictation-overview>
          <OverviewTab />
        </TabsContent>
        <TabsContent value="history" className="flex flex-col gap-4" data-dictation-history>
          <HistoryTab profiles={profiles ?? []} />
        </TabsContent>
        <TabsContent value="bots" className="flex flex-col gap-4" data-dictation-bots>
          <BotsTab profiles={profiles ?? []} />
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

function Words({
  label,
  text,
  ...rest
}: { label: string | null; text: string } & ComponentProps<"p">) {
  return (
    <p className="text-base whitespace-pre-wrap" {...rest}>
      {label && (
        <span className="mb-1.5 block text-[13px] font-medium text-muted-foreground">{label}</span>
      )}
      {text}
    </p>
  )
}

/**
 * What tidied a take, in the app's words: the level, whether the cleanup changed anything, and who
 * heard it. A None take reads as not tidied rather than as tidied and found nothing to change, which
 * is the one difference the two texts alone cannot show (ADR 0074).
 */
function tidiedLine(row: DictationRecord): string | null {
  const level = namedLevel(row.level)
  const parts: string[] = []
  if (level === "none") parts.push("Not tidied")
  else if (level) {
    parts.push(`Cleaned up at ${levelName(level)}`)
    parts.push(row.cleaned ? "changed the words" : "found nothing to change")
  }
  const who = [row.provider, row.model].filter(Boolean).join(" · ")
  if (who) parts.push(who)
  return parts.length ? parts.join(" · ") : null
}

/**
 * One dictation, whole: its words, what it was, a Copy and a way to delete it. The machine's words
 * are **Transcribed** and the words that landed are **Cleaned up** — the words say what the text is
 * rather than who did what, and a take the cleanup left alone draws one **Transcribed** block
 * (ADR 0082).
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
  const { heard, tidied } = textsOf(row)
  const cleanup = tidiedLine(row)
  const copy = () => void copyText(row.text, noteCopied)
  return (
    <Popup open onOpenChange={onOpenChange}>
      <PopupContent>
        <PopupHeader>
          <PopupTitle>{clockOf(row.at)}</PopupTitle>
        </PopupHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {heard && <Words label="Transcribed" text={heard} data-dictation-heard />}
          {tidied && <Words label={heard ? "Cleaned up" : null} text={tidied} data-dictation-text />}
          <p className="text-sm text-muted-foreground">
            {[bot, wordsLabel(row.words), spokenLabel(row.ms)].filter(Boolean).join(" · ")}
          </p>
          {cleanup && (
            <p className="text-sm text-muted-foreground" data-dictation-tidied>
              {cleanup}
            </p>
          )}
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
 * The model is the last answer this device read, kept until a fresh one confirms it (ADR 0082).
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
  if (check === "failed") return READ_FAILED
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
function StatsTotals() {
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

/**
 * The screen's first tab: the Bubble this phone runs, the bot whose speech-to-text it uses, and the
 * totals underneath. Both cards are about this device, which is why they sit here rather than on a
 * bot's own page — the Bubble does not follow a bot's settings, it follows this phone's choice.
 */
function OverviewTab() {
  return (
    <>
      <BubbleCards />
      <Caption>Stats</Caption>
      <StatsTotals />
    </>
  )
}

type Grant = keyof Pick<BubbleState, "overlay" | "accessibility">

/** Why the phone's answer means no Bubble, in the words the toast says it in. */
function refusal(grant: Grant) {
  return grant === "overlay"
    ? "Without drawing over other apps there is no Bubble to tap."
    : "Without the accessibility service the Bubble cannot type, so there is no Bubble."
}

/** What the phone said when it would not start, in the words the toast says it in. */
const REFUSED: Record<string, string> = {
  overlay: refusal("overlay"),
  accessibility: refusal("accessibility"),
  microphone: "Allow the microphone first.",
}

/**
 * What each bot's takes are heard by, from the answer its host gave this device — the same cache the
 * Bots tab draws from. A bot this device has never read is asked once; its answer lands in the cache
 * and this query runs again.
 */
function useHeardBy(bots: Profile[]) {
  const ids = bots.map((one) => one.id).join(",")
  return useLiveQuery(async () => {
    const rows = await db.speechCache.toArray()
    const known = new Map(rows.map((row) => [row.key, row.speech]))
    await Promise.all(
      bots.map((bot) =>
        known.has(connectionKey(bot)) ? undefined : getSpeech(bot).catch(() => undefined),
      ),
    )
    return known
  }, [ids])
}

/**
 * The provider and model a bot hears with, or the host's own word for hearing nothing: the line is
 * `botModelLine`'s, since a bot's host reports its local model whatever provider resolves.
 */
function heardLine(settings?: SpeechSettings) {
  return botModelLine(settings) ?? "Speech-to-text off"
}

/** The Bubble and the bot it hears with. The two grants are the phone's, so the app asks for them. */
function BubbleCards() {
  const bots = useLiveQuery(listEnabledProfiles, [])
  const heard = useHeardBy(bots ?? [])
  const bubbleBot = useLiveQuery(getBubbleProfile, [])
  const [state, setState] = useState<BubbleState>()
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  /** The grant the phone is being asked for: the page is away while that screen is up. */
  const [waiting, setWaiting] = useState<Grant>()

  // The one reader of the phone's state: the mount, the walk-through's return and every tap go
  // through it, so a new reason to read it has one place to land.
  const refresh = useCallback(() => bubbleState().then(setState), [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const switchOn = useCallback(async () => {
    // The microphone is the one grant the phone asks in place, so it is asked before the service: an
    // APK that started one without it would be refused by the system, not by the app.
    if (!(await requestBubbleMicrophone())) {
      toast.error(REFUSED.microphone)
      await refresh()
      return
    }
    const started = await enableBubble()
    if (!started.started) toast.error(REFUSED[started.reason ?? ""] ?? "The Bubble couldn't start.")
    await refresh()
  }, [refresh])

  /**
   * The next grant that is missing, and the phone's screen that gives it. Both are the phone's to
   * grant, so the app can only ask for one, wait to be come back to, and ask for the next.
   */
  const ask = useCallback(
    async (now: BubbleState | undefined) => {
      const grant: Grant | null = !now?.overlay ? "overlay" : !now.accessibility ? "accessibility" : null
      if (!grant) {
        await switchOn()
        return
      }
      setWaiting(grant)
      const trouble =
        grant === "overlay" ? await openBubbleOverlay() : await openBubbleAccessibility()
      if (trouble) {
        setWaiting(undefined)
        toast.error(trouble)
      }
    },
    [switchOn],
  )

  // Coming back is the only moment either grant can be read as changed: both are given on screens of
  // the phone's, and neither tells the app anything. `onReturn` is the app's one answer to that —
  // Android's `resume` and the page's `visibilitychange` both say it, and a return from the phone's
  // own settings screen may be only the first of the two.
  useEffect(() => {
    return onReturn(() => {
      void (async () => {
        const now = await bubbleState()
        setState(now)
        if (!waiting) return
        setWaiting(undefined)
        if (!now?.[waiting]) {
          toast.error(refusal(waiting))
          return
        }
        await ask(now)
      })()
    })
  }, [waiting, ask])

  /** One switch, two ways to throw it: the walk through the grants, or turning the service off. */
  const turnOn = useCallback(async () => {
    setBusy(true)
    try {
      await ask(state)
    } finally {
      setBusy(false)
    }
  }, [ask, state])

  const turnOff = useCallback(async () => {
    setBusy(true)
    try {
      await disableBubble()
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  // A browser has no service, no window over another app and no accessibility: the card is not drawn
  // at all rather than drawn dead.
  if (!bubbleAvailable()) return null

  return (
    <>
      <Caption>Bubble</Caption>
      <Group>
        <SwitchRow
          id="bubble-on"
          title="Bubble"
          subtitle="Speak into the field in front of you, in any app"
          checked={state?.enabled === true}
          disabled={busy || Boolean(waiting)}
          onCheckedChange={(on) => void (on ? turnOn() : turnOff())}
          data-setting="bubble"
        />
        <ValueRow
          title="Bot"
          purpose="Who hears the Bubble's takes"
          value={bubbleBot?.name}
          onClick={() => setPicking(true)}
          data-setting="bubble-bot"
        />
      </Group>
      <PickSurface open={picking} onOpenChange={setPicking} title="Bot">
        <PickList
          label="Bots"
          searchable={false}
          selected={bubbleBot?.id}
          // Only the bots the selection can land on: a disabled bot is resolved away on the next
          // read, so offering it would move the row and the phone to a bot nobody picked.
          // The same order the Bots tab draws, and each row the bot's own picture with the model it
          // answers with: a name alone said nothing about which bot a take would be heard by.
          options={(bots ?? []).map((profile) => ({
            id: profile.id,
            label: profile.name,
            // What hears the take, not what answers a chat: this list decides the bot the Bubble
            // dictates with, and its speech model is the one that matters here.
            detail: heardLine(heard?.get(connectionKey(profile))),
            leading: <Bot id={profile.botId} className="size-8 shrink-0" />,
          }))}
          onPick={(id) => {
            setPicking(false)
            const picked = (bots ?? []).find((profile) => profile.id === id)
            if (!picked || picked.id === bubbleBot?.id) return
            void (async () => {
              await setBubbleProfile(picked.id)
              await mirrorBubble(picked)
              await refresh()
            })()
          }}
        />
      </PickSurface>
    </>
  )
}
