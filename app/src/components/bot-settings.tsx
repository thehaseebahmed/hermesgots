import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  AudioLinesIcon,
  BotIcon,
  CodeXmlIcon,
  KeyRoundIcon,
  MessagesSquareIcon,
  NetworkIcon,
  PlusIcon,
  PlugZapIcon,
  SlidersHorizontalIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"

import { Banner, Retry } from "@/components/banner"
import { Bot } from "@/components/bot"
import { BOTS } from "@/components/bots"
import { CodingTab } from "@/components/bot-coding-tab"
import { LlmProvidersTab } from "@/components/bot-llm-providers-tab"
import { Segmented } from "@/components/segmented"
import { DictationTab } from "@/components/bot-dictation-tab"
import { McpsTab } from "@/components/mcps-tab"
import { SkillsTab } from "@/components/skills-tab"
import { ConfirmDestructive } from "@/components/confirm-destructive"
import {
  Caption,
  DestructiveButton,
  EditCard,
  EditForm,
  Group,
  ModelPick,
  PickList,
  PickSurface,
  RowText,
  SwitchRow,
  ValueRow,
  linkRowClass,
  rowClass,
  useHeaderAction,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AFK_PICKS_FEATURE } from "@/lib/afk-picks"
import { botPath, botTabPath, SETTING_PAGES, type BotPage, type BotTab } from "@/lib/bot-tabs"
import { botSubPath, type BotSub } from "@/lib/bot-subs"
import { connectionKey } from "@/lib/connection"
import {
  db,
  deleteProfile,
  getActiveProfile,
  getSettings,
  setActiveProfile,
  updateProfile,
  type ModelChoice,
  type Profile,
} from "@/lib/db"
import { useDelegationModel } from "@/lib/delegation"
import { DICTATION } from "@/lib/dictation"
import { MAX_FALLBACKS } from "@/lib/fallback-list"
import { useFallbackModels } from "@/lib/fallbacks"
import { usePluginFeatureAnswers, usePluginVersion } from "@/lib/features"
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "@/lib/freshness"
import { formatRelative } from "@/lib/format"
import {
  DELEGATION_PAGE,
  GENERAL_PAGE,
  draftOf,
  draftValue,
  fieldLabel,
  generalGroups,
  generalRowValue,
  optionLabel,
  type GeneralField,
  type GeneralSettings,
} from "@/lib/general-settings"
import {
  GENERAL_ROUTES,
  getGeneralSettings,
  REMINDER_LEVELS,
  setGeneralSetting,
  type GeneralTab,
  type ReminderLevel,
} from "@/lib/hermes"
import { cachedHost, keepHost } from "@/lib/host-cache"
import { useLarge } from "@/lib/media"
import { LLM_PROVIDERS } from "@/lib/llm-providers"
import { MCP_FEATURES } from "@/lib/mcps"
import { effective, explicitly, rowOn } from "@/lib/settings-values"
import { botModel, fullModel, setDefaultModel, useModelInfo } from "@/lib/model-info"
import { setBotMuted } from "@/lib/push"
import { seedsFromCache, useReadAttempt } from "@/lib/read-attempt"
import { useReminders } from "@/lib/reminders"
import { isOnline, removeHost, setBotEnabled } from "@/lib/registry"
import { SKILL_FEATURES } from "@/lib/skills"
import { useNow } from "@/lib/threads"
import { plural } from "@/lib/tools"
import { cn } from "@/lib/utils"
import { MIN_PLUGIN_VERSION, pluginOutdated } from "@/lib/version"

/** What a page wears, and the plugin feature it needs where a host can withhold it. */
type PageMeta = {
  /** The icon a page's row, and the screen it opens, wear. */
  icon: LucideIcon
  /** The feature the page is gated on: a page that is always there has none. */
  feature?: string
}

/**
 * Every page's own row: what it wears and, where a plugin can withhold it, the feature it is gated
 * on. One table, so a page can gain neither without the other being written beside it; the screen
 * each page draws is `PAGE_BODIES`, keyed on the same union.
 */
const PAGE_META: Record<BotTab, PageMeta> = {
  bot: { icon: BotIcon },
  // General mirrors the bot's own Hermes, so it needs a plugin that can read the host's schema. A
  // host without it draws no General row, and a general address lands on the bot's own page.
  general: { icon: SlidersHorizontalIcon, feature: GENERAL_PAGE },
  models: { icon: MessagesSquareIcon },
  // The host's API-key providers: a Hermes whose catalog can't be read withholds the page, so an
  // older plugin draws no row and the address lands on the bot's own page.
  "llm-providers": { icon: KeyRoundIcon, feature: LLM_PROVIDERS },
  coding: { icon: CodeXmlIcon, feature: AFK_PICKS_FEATURE },
  "speech-to-text": { icon: AudioLinesIcon, feature: DICTATION },
  mcps: { icon: PlugZapIcon, feature: MCP_FEATURES.list },
  skills: { icon: WrenchIcon, feature: SKILL_FEATURES.list },
  delegation: { icon: NetworkIcon, feature: DELEGATION_PAGE },
}

/** The pages a plugin can withhold, by the segment naming them: the rest are always there. */
const PAGE_FEATURES = gatedFeatures(PAGE_META)

/** That table, read off `PAGE_META` alone: a page with no feature in it is always there. */
function gatedFeatures(meta: Record<BotTab, PageMeta>): Record<string, string> {
  const features: Record<string, string> = {}
  for (const [page, one] of Object.entries(meta)) if (one.feature) features[page] = one.feature
  return features
}

function gated(page: BotTab): boolean {
  return page in PAGE_FEATURES
}

const GENERAL_ANSWERS = { fallbacks: "fallbacks" } as const

/** The registry's Enabled flag, with when the bot's host last checked in. */
function EnabledSetting({ profile }: { profile: Profile }) {
  const now = useNow()
  const [saving, setSaving] = useState(false)
  const seen = profile.seenAt
    ? isOnline(profile, now)
      ? "Online"
      : `Last seen ${formatRelative(profile.seenAt, Math.max(now, profile.seenAt))}`
    : "Not seen yet"

  return (
    <SwitchRow
      id="enabled"
      title="Enabled"
      subtitle={profile.disabled ? "Hidden in Gots" : seen}
      checked={!profile.disabled}
      disabled={saving}
      onCheckedChange={async (checked) => {
        setSaving(true)
        try {
          await setBotEnabled(profile, checked)
          if (!checked && (await getSettings()).activeProfileId === profile.id) {
            const next = await getActiveProfile()
            if (next) await setActiveProfile(next.id)
          }
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Couldn't save that.")
        } finally {
          setSaving(false)
        }
      }}
    />
  )
}

/** Mutes every push from the bot, on every device. */
function MutedSetting({ profile }: { profile: Profile }) {
  return (
    <SwitchRow
      id="muted"
      title="Mute notifications"
      subtitle="Every push from this bot, on every device"
      checked={Boolean(profile.muted)}
      onCheckedChange={(checked) => void setBotMuted(profile.id, checked)}
    />
  )
}

/** What each level is called on the row. The levels themselves are the host's vocabulary. */
const REMINDER_LABELS: Record<ReminderLevel, string> = {
  off: "Off",
  quiet: "Quiet",
  normal: "Normal",
  chatty: "Chatty",
}

/**
 * How often Gots asks this bot to say what it is doing (`progress.py`, ADR 0068): a value held per
 * bot on its host, set where the switches beside it are set, since a control that acts where it
 * sits is what the row is (ADR 0055). No count is drawn beside a level — the counts are the loop's
 * business, and the host changing one later is not an app release.
 */
function RemindersSetting({ profile }: { profile: Profile }) {
  const { value, supported, settled, saving, save } = useReminders(profile)
  if (!supported) return null

  return (
    <div
      className={cn(rowClass, "flex-col items-stretch gap-3")}
      aria-busy={saving || undefined}
      data-setting="reminders"
    >
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-base">Progress updates</span>
        <span className="text-sm text-muted-foreground">
          How often Gots asks the bot to say what it&apos;s doing. How much it says is still the
          bot&apos;s call.
        </span>
      </span>
      <Segmented
        label="Progress updates"
        options={REMINDER_LEVELS.map((id) => ({ id, label: REMINDER_LABELS[id] }))}
        value={value}
        onChange={(next) => {
          void save(next).catch((error: unknown) =>
            toast.error(
              error instanceof Error ? error.message : "Couldn't save that reminder level.",
            ),
          )
        }}
        disabled={!settled || saving}
      />
    </div>
  )
}

/**
 * The confirmation a bot's deletion asks for, in the words its kind settled: a linked bot's host is
 * unlinked, and an unlinked bot's chats go with it — the profile on the Hermes server staying either
 * way. It lives in the list, so its open state dies with the screen that opened it.
 */
function DeleteBotDialog({
  profile,
  open,
  onOpenChange,
  onDeleted,
}: {
  profile: Profile
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const linked = Boolean(profile.hostId)
  // The confirmation's own sentence: who else the unlink takes with it. Nothing is scanned while the
  // dialog is shut — a write to any profile re-emits this query, and the page writes the plugin
  // version on its own open, so an always-live query would scan the table on every such write.
  const siblings = useLiveQuery(
    async (): Promise<Profile[]> =>
      open && profile.hostId
        ? db.profiles.filter((p) => p.hostId === profile.hostId && p.id !== profile.id).toArray()
        : [],
    [open, profile.hostId, profile.id],
  )
  const others = siblings?.map((p) => p.name).join(", ")

  return (
    <ConfirmDestructive
      open={open}
      title={`Delete ${profile.name}?`}
      description={
        linked
          ? `Its host is unlinked${others ? `, and so is every bot it linked: ${others}` : ""}. Its chats stay on your Hermes server, and linking it again brings them back.`
          : "Its chats are removed too. The profile and its sessions on your Hermes server are untouched."
      }
      confirmLabel="Delete"
      onOpenChange={onOpenChange}
      onConfirm={async () => {
        if (linked) {
          try {
            await removeHost(profile.hostId!)
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Couldn't remove it.")
            return
          }
        } else {
          await deleteProfile(profile.id)
        }
        const next = await getActiveProfile()
        if (next) await setActiveProfile(next.id)
        onDeleted?.()
      }}
    />
  )
}

/** A page's row: its icon, its name over what it holds. No chevron — the row itself is the sign. */
function PageRow({
  page,
  botId,
  replace,
}: {
  page: BotPage
  botId: string
  /** Whether the row swaps the pane beside it rather than opening a screen of its own. */
  replace?: boolean
}) {
  const Icon = PAGE_META[page.segment].icon
  return (
    <Link
      to={botTabPath(botId, page.segment)}
      replace={replace}
      data-bot-page={page.segment}
      className={linkRowClass}
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title={page.title} subtitle={page.subtitle ?? ""} />
    </Link>
  )
}

/**
 * A bot's own page: the plugin banner when it is out of date, then what the bot is — its switches,
 * its profile and how it connects — under the caption *Bot*, and the settings behind it in one card
 * under *Settings* (ADR 0106). A page the plugin withholds draws no row. The page ends on *Delete bot*
 * at the foot of its column, asking first; an unlinked bot is left alone where this device holds no
 * other bot to fall back on.
 */
export function BotSettingsList({
  profile,
  replace,
  onDeleted,
}: {
  profile: Profile
  /** Whether the row swaps the pane beside it rather than opening a screen of its own. */
  replace?: boolean
  onDeleted?: () => void
}) {
  const answers = usePluginFeatureAnswers(profile, PAGE_FEATURES)
  const [confirming, setConfirming] = useState(false)
  const linked = Boolean(profile.hostId)
  // The rule is the device's own: an unlinked bot cannot be the last one, since removing it would
  // leave nothing to fall back on. Counted here rather than handed in, so the page a withheld tab
  // address falls back to carries the same answer as the page its own address opens.
  const held = useLiveQuery(() => db.profiles.count(), [])
  const canDelete = (held ?? 0) > 1
  const navigate = useNavigate()
  // A row the host says it hasn't got is not drawn; a row whose answer hasn't come back yet is, so
  // the card fills in rather than appearing a row at a time.
  const rows = SETTING_PAGES.map((page) => {
    const segment = page.segment
    if (gated(segment) && answers[segment] === "no") return null
    return <PageRow key={segment} page={page} botId={profile.id} replace={replace} />
  })

  return (
    <div className="flex flex-col gap-4" data-bot-settings-list>
      {!profile.disabled && pluginOutdated(profile.pluginVersion) && (
        <Banner tone="warning">
          {`This bot's plugin is out of date! Update it to ${MIN_PLUGIN_VERSION} or newer.`}
        </Banner>
      )}
      <Caption>Bot</Caption>
      <BotCard profile={profile} onOpen={(id) => navigate(botSubPath(profile.id, "bot", id))} />
      <Caption>Settings</Caption>
      <Group>{rows}</Group>
      {/* The page's own last control, under its last card: the button MCP Details wears as *Remove
          server*, in this page's words. */}
      <DestructiveButton onClick={() => setConfirming(true)} disabled={!linked && !canDelete}>
        Delete bot
      </DestructiveButton>
      <DeleteBotDialog
        profile={profile}
        open={confirming}
        onOpenChange={setConfirming}
        onDeleted={onDeleted}
      />
    </div>
  )
}

/**
 * One page of a bot's settings: what its body is given — the bot, the sub-screen the address named
 * where the page holds one, the address its close returns to, and whether a pane sits beside it.
 */
type PageBody = {
  profile: Profile
  /** The page's own sub-screen: nothing where the address named none, or named another page's. */
  sub?: BotSub
  /** Where a screen's close returns to: the address the page itself is drawn at. */
  close: () => void
  /** Whether a pane sits beside this one, which is what decides a card over a screen. */
  large: boolean
}

/**
 * The bot's own page: its edits drawn as the screen the route pushed, or as the card over the page
 * where there is a pane beside it.
 */
function botPage({ profile, sub, close, large }: PageBody) {
  // The page asked for is withheld, or its host hasn't answered: what is left to draw is the bot's
  // own page. Where a pane sits beside this one, that page is already in it — drawing it again
  // would put two cards, two Delete bot buttons and two feature reads on one screen.
  if (!sub) return large ? null : <BotSettingsList profile={profile} />
  if (!large) return <BotEditScreen profile={profile} sub={sub} close={close} />
  // From 1024px the bot's page is the pane beside this one, so the pane holds its edit alone.
  return (
    <EditCard title={sub.title} onClose={close}>
      <BotEditScreen profile={profile} sub={sub} close={close} />
    </EditCard>
  )
}

/**
 * The screen each page draws, keyed on the page itself. `BotTab` is the pages `BOT_PAGES` names, so
 * a page added to that list fails the typecheck here until its body is written — there is no chain
 * to fall through, and no page can be drawn by another page's screen. General and Delegation are the
 * host's own page twice (`GeneralPage`), each keyed by the bot and the tab so a switched-to bot
 * starts its own read.
 */
const PAGE_BODIES: Record<BotTab, (page: PageBody) => ReactNode> = {
  bot: botPage,
  general: ({ profile, sub, close }) =>
    // General's one detail — the chain it falls back on — is a screen of its own; every other sub it
    // holds is one of the host's keys, which its own page draws.
    sub?.kind === "detail" ? (
      <FallbacksPage profile={profile} />
    ) : (
      <GeneralPage
        key={`${profile.id}:general`}
        profile={profile}
        tab="general"
        sub={sub}
        close={close}
      />
    ),
  models: ({ profile }) => <ModelsPage profile={profile} />,
  "llm-providers": ({ profile, sub }) => <LlmProvidersTab profile={profile} sub={sub} />,
  coding: ({ profile }) => <CodingTab profile={profile} />,
  "speech-to-text": ({ profile, sub }) => <DictationTab profile={profile} sub={sub} />,
  mcps: ({ profile, sub }) => <McpsTab profile={profile} sub={sub} />,
  skills: ({ profile, sub }) => <SkillsTab profile={profile} sub={sub} />,
  delegation: ({ profile, sub, close }) => (
    <GeneralPage
      key={`${profile.id}:delegation`}
      profile={profile}
      tab="delegation"
      sub={sub}
      close={close}
    />
  ),
}

/**
 * One page of a bot's settings, or one of its sub-screens. A sub-screen is presented by the width:
 * below 1024px it is the screen itself, and from 1024px an edit rides over the page as a centred
 * card while a detail takes the page pane's place (ADR 0055).
 */
export function BotSettingsPage({
  profile,
  tab = "general",
  sub,
}: {
  profile: Profile
  tab?: BotTab
  sub?: BotSub
}) {
  const answers = usePluginFeatureAnswers(profile, PAGE_FEATURES)
  const gate = gated(tab) ? answers[tab] : undefined
  // Where a withheld page lands: the bot's own page, which is always there — a page gated on its own
  // availability cannot land on itself, and General is now one of those.
  const shown: BotTab = gate !== undefined && gate !== "yes" ? "bot" : tab
  const large = useLarge()
  const navigate = useNavigate()
  // Only the page on screen owns its sub: an address into a page this bot doesn't have draws the
  // page it fell back to, never the other page's edit — and never a write to a field it doesn't hold.
  const own = tab === shown ? sub : undefined

  // A URL into a page this bot doesn't have: the bot's own page takes its place, in the history
  // entry it was asked for, rather than the address reading MCP over a screen that isn't. Only an
  // answer of "no" sends anyone anywhere — a Host still reading keeps the address and draws the
  // bot's page meanwhile.
  useEffect(() => {
    if (gate === "no") void navigate(botPath(profile.id), { replace: true })
  }, [gate, navigate, profile.id])

  // A sub of the bot's own page closes back onto that page's address, not onto a segment of its own.
  const close = useCallback(
    () =>
      navigate(shown === "bot" ? botPath(profile.id) : botTabPath(profile.id, shown), {
        replace: true,
      }),
    [navigate, profile.id, shown],
  )

  return PAGE_BODIES[shown]({ profile, sub: own, close, large })
}

/**
 * One of the bot's own edits, wherever it is drawn: the screen the route pushed, or the card over the
 * bot's page where a pane sits beside it.
 */
function BotEditScreen({
  profile,
  sub,
  close,
}: {
  profile: Profile
  sub: BotSub
  close: () => void
}) {
  const large = useLarge()
  const edit = botEdit(sub.id)
  // A segment the router refused never reaches here; one the table doesn't name holds no field, so
  // no id can fall through to a write the page doesn't mean.
  if (!edit) return null
  return (
    <EditForm
      label={sub.label ?? sub.title}
      value={edit.read(profile)}
      placeholder={edit.placeholder}
      kind={edit.kind}
      // A page's own edit is the screen the route pushes; where a pane sits beside it, the card is
      // the surface and its close is the cancel.
      surface={large ? "card" : "screen"}
      onSave={async (value) => {
        try {
          await updateProfile(profile.id, edit.patch(value))
          close()
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Couldn't save that.")
        }
      }}
      onCancel={close}
    />
  )
}

/** One of the bot's own edits: the field it holds, and the one write it makes. */
type BotEdit = {
  read: (profile: Profile) => string
  placeholder: string
  kind: "text" | "url" | "secret"
  patch: (value: string) => Partial<Omit<Profile, "id">>
}

const BOT_EDITS = {
  name: {
    read: (profile) => profile.name,
    placeholder: "Hermes profile name",
    kind: "text",
    patch: (value) => ({ name: value.trim() || "Hermes" }),
  },
  "base-url": {
    read: (profile) => profile.baseUrl,
    placeholder: "http://localhost:8642/v1",
    kind: "url",
    patch: (value) => ({ baseUrl: value.trim() }),
  },
  "server-key": {
    read: (profile) => profile.apiKey,
    placeholder: "API_SERVER_KEY",
    kind: "secret",
    patch: (value) => ({ apiKey: value.trim() }),
  },
} satisfies Record<string, BotEdit>

function botEdit(id: string): BotEdit | undefined {
  return id in BOT_EDITS ? BOT_EDITS[id as keyof typeof BOT_EDITS] : undefined
}

/** What the page says of a key its host only opens when its process starts. */
const RESTART_NOTE = "Applies when this bot's Hermes restarts."

/**
 * The page's own read: the host's General (or Delegation) block, and the sentence where it came back
 * without one. `retry` asks the same read again where it threw; a host that answered without its
 * block keeps its sentence and gets no control, since an answer is an answer. `keep` takes the block
 * a write answers, because a write's answer is fresher than any read could be.
 */
function useGeneralSettings(profile: Profile, tab: GeneralTab) {
  const connection = connectionKey(profile)
  const route = GENERAL_ROUTES[tab].path
  const page = `${connection}/${tab}`
  const [block, setBlock] = useState<GeneralSettings>()
  const [problem, setProblem] = useState<string>()
  const [read, setRead] = useState("")
  const [fresh, setFresh] = useState("")
  const { attempt, landed, landedThrew, release, retry } = useReadAttempt(page)

  useEffect(() => {
    let cancelled = false
    let answered = false
    // The page opens on the last answer this host gave this device, and the fresh read replaces it;
    // until it lands the rows are drawn shut, so a stale value is never what a write starts from.
    // Only the first open seeds from that copy: a retry asks the host, and seeding again would
    // flicker the rows and strobe the sentence under them.
    setBlock(undefined)
    if (seedsFromCache(attempt))
      void cachedHost<GeneralSettings>(profile, route).then((held) => {
        if (!cancelled && !answered && held) setBlock(held)
      })
    void getGeneralSettings(profile, tab, AbortSignal.timeout(READ_TIMEOUT_MS))
      .then((next) => {
        if (cancelled) return
        answered = true
        setRead(connection)
        setProblem(
          next ? undefined : `This host doesn't carry its ${GENERAL_ROUTES[tab].label} settings.`,
        )
        if (next) {
          setBlock(next)
          setFresh(page)
          void keepHost(profile, route, next)
        }
        landed()
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // A read that failed is still an answer: the page stops loading and says what the host said.
        setRead(connection)
        setProblem(
          error instanceof Error
            ? error.message
            : `Couldn't read this bot's ${GENERAL_ROUTES[tab].label} settings.`,
        )
        landedThrew()
      })
    return () => {
      cancelled = true
      release(attempt)
    }
    // The connection is what the answer belongs to: another bot's read is not this page's, and no
    // other field of the profile moves what the host holds. `attempt` is the read asked again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id, connection, tab, attempt])

  const keep = useCallback(
    (next: GeneralSettings) => {
      setBlock(next)
      setFresh(page)
      void keepHost(profile, route, next)
    },
    [profile, route, page],
  )

  return {
    block,
    problem,
    /**
     * Whether the block drawn is this device's copy rather than the host's own answer: nothing is
     * written from it until the host's answer lands.
     */
    stale: Boolean(block) && fresh !== page,
    /** Whether the page holds an answer to draw at all, this device's copy or the host's. */
    seeded: read === connection || Boolean(block),
    /** The block a write answered: it is the host's word, so it is drawn without a read. */
    keep,
    /** The same read, asked again — and nothing at all where the last one did not throw. */
    retry,
  }
}

/**
 * General: the settings on this bot's own Hermes, as its Dashboard's Config > General tab holds
 * them. The rows are the host's own — keys, kinds and choices all arrive with the read, so a key
 * Hermes adds later is a row without an app release — and each is drawn as this app draws a setting:
 * a switch acts in place, a value opens its edit, a pick opens its sheet (ADR 0055). Nothing is
 * written until Save, and a reset hands the key back to the host's default.
 *
 * The page is its own sub-screen surface: below 1024px an edit is the screen the route pushed, and
 * from 1024px it rides over the page as a centred card. A pick is neither — it opens where it is.
 */
function GeneralPage({
  profile,
  tab = "general",
  sub,
  close,
}: {
  profile: Profile
  tab?: GeneralTab
  sub?: BotSub
  close: () => void
}) {
  const large = useLarge()
  const navigate = useNavigate()
  const answers = usePluginFeatureAnswers(profile, GENERAL_ANSWERS)
  const delegation = tab === "delegation"
  const info = useModelInfo(profile)
  const own = botModel(profile, info)
  const chain = useFallbackModels(delegation ? null : profile)
  const subagent = useDelegationModel(delegation ? profile : null)
  const settings = useGeneralSettings(profile, tab)
  const { block, problem, stale, seeded, keep, retry } = settings
  const [saving, setSaving] = useState<string>()
  const [pick, setPick] = useState<string>()

  // Every write answers the host's fresh block, so the row a person just changed is the row the
  // host now holds — and a refused write leaves the page as it was, with the host's sentence.
  const write = useCallback(
    async (key: string, value: unknown) => {
      setSaving(key)
      try {
        const next = await setGeneralSetting(
          profile,
          tab,
          key,
          value,
          AbortSignal.timeout(WRITE_TIMEOUT_MS),
        )
        // A host that answered without its block hasn't saved anything this page can draw: say so
        // rather than closing the form over the value it held before.
        if (!next) throw new Error("The host answered without its settings.")
        keep(next)
        return true
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't save that.")
        return false
      } finally {
        setSaving(undefined)
      }
    },
    [profile, tab, keep],
  )

  const groups = block ? generalGroups(block.fields) : []
  // An address into a key this host doesn't hold: the page goes back to itself rather than standing
  // on a screen that would draw nothing and write to a field it has no row for.
  const field = block && sub ? block.fields.find((one) => one.key === sub.id) : undefined
  const stray = Boolean(sub) && seeded && Boolean(block) && !stale && !field
  useEffect(() => {
    if (stray) close()
  }, [close, stray])

  if (sub) {
    const form =
      block && field && !stale ? (
        <FieldForm
          block={block}
          field={field}
          saving={saving === field.key}
          onWrite={write}
          onClose={close}
        />
      ) : problem ? (
        <Banner tone="warning" action={retry && <Retry onRetry={retry} />}>
          {problem}
        </Banner>
      ) : (
        <div className="flex items-center justify-center py-16" data-general-loading>
          <Spinner />
        </div>
      )
    if (!large) return form
    return (
      <>
        {cards()}
        <EditCard title={sub.title} onClose={close}>
          {form}
        </EditCard>
      </>
    )
  }

  return cards()

  /**
   * The page's cards: the bot's model and the chain it falls back on lead, then a caption per section
   * the host files its keys under with the rows it put there. The model and its chain are one
   * decision, so they sit together ahead of the host's own order (ADR 0104).
   */
  function cards() {
    if (!seeded)
      return (
        <div className="flex items-center justify-center py-16" data-general-loading>
          <Spinner />
        </div>
      )
    const [first, ...rest] = groups
    const lead = first?.section === "" ? first.rows : []
    const others = first?.section === "" ? rest : groups
    return (
      <div className="flex flex-col gap-4" {...{ [`data-bot-${tab}`]: true }}>
        {problem && (
          <Banner tone="warning" action={retry && <Retry onRetry={retry} />}>
            {problem}
          </Banner>
        )}
        <Group>
          {/* The row is the page's own lead row, drawn only over a page the host let this app read: a
              refused page says so in its banner and carries no row (#992). */}
          {delegation && subagent.supported && block && (
            <SubagentModelRow profile={profile} record={subagent} own={own} />
          )}
          {!delegation && (
            <ValueRow
              title="Model"
              purpose="The host's main model, on every surface"
              value={own ? fullModel(own) : ""}
              onClick={() => setPick("model")}
              data-setting="model"
            />
          )}
          {!delegation && answers.fallbacks === "yes" && chain.supported && (
            <ValueRow
              title="Fallback providers"
              purpose="The chain Hermes tries after the main model"
              value={
                chain.list.length ? plural(chain.list.length, "provider", "providers") : "None"
              }
              onClick={() => navigate(botSubPath(profile.id, "general", "fallback_providers"))}
              data-setting="fallback_providers"
            />
          )}
          {block && lead.map(row)}
        </Group>
        {others.map((group) => (
          <Fragment key={group.section || "page"}>
            {group.title && <Caption>{group.title}</Caption>}
            <Group>{group.rows.map(row)}</Group>
          </Fragment>
        ))}
        {picked()}
        <ModelPick
          open={pick === "model"}
          title="Model"
          profile={profile}
          choice={own}
          fallback={{ label: "Default", model: info?.model }}
          onPick={(next) => void setDefaultModel(profile, next)}
          onClose={() => setPick(undefined)}
        />
      </div>
    )
  }

  /** One of the host's rows, wherever the card it belongs to is drawn. */
  function row(field: GeneralField) {
    if (!block) return null
    return (
      <GeneralRow
        key={field.key}
        block={block}
        field={field}
        disabled={Boolean(problem) || stale}
        saving={saving === field.key}
        onWrite={write}
        onPick={() => setPick(field.key)}
        onOpen={() => navigate(botSubPath(profile.id, tab, field.key))}
      />
    )
  }

  /** The pick a row opened: its choices in the host's order, Automatic where the key can be cleared. */
  function picked() {
    const field = pick ? block?.fields.find((one) => one.key === pick) : undefined
    if (!block || !field) return null
    const held = String(effective(block, field.key) ?? "")
    return (
      <PickSurface
        open
        onOpenChange={(open) => !open && setPick(undefined)}
        title={fieldLabel(field.key)}
      >
        <PickList
          label={fieldLabel(field.key)}
          searchable={field.searchable}
          selected={held}
          options={(field.options ?? []).map((option) => ({
            id: option,
            label: option ? optionLabel(option) : "Host default",
          }))}
          onPick={(id) => {
            setPick(undefined)
            void write(field.key, id || null)
          }}
        />
        {field.restart && (
          <p className="mt-3 px-1 text-center text-sm text-muted-foreground">{RESTART_NOTE}</p>
        )}
      </PickSurface>
    )
  }
}

// Written on the model's own route, which checks the pick and sets provider and model together,
// so the raw `delegation.*` keys are never rows.
function SubagentModelRow({
  profile,
  record,
  own,
}: {
  profile: Profile
  record: ReturnType<typeof useDelegationModel>
  own: ReturnType<typeof botModel>
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <ValueRow
        title="Subagent model"
        purpose="The model every subagent runs on"
        value={record.pick ? fullModel(record.pick) : record.custom ? "Custom" : "Default model"}
        disabled={record.saving}
        busy={record.saving}
        onClick={() => setOpen(true)}
        data-setting="subagent-model"
      />
      <ModelPick
        open={open}
        title="Subagent model"
        profile={profile}
        choice={record.pick}
        fallback={{ label: "Default model", model: own?.model }}
        onPick={(next) => record.save(next)}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

/** One of the host's rows, drawn by what it holds: a switch writes on its own, everything else opens. */
function GeneralRow({
  block,
  field,
  saving,
  disabled,
  onWrite,
  onPick,
  onOpen,
}: {
  block: GeneralSettings
  field: GeneralField
  saving: boolean
  disabled: boolean
  onWrite: (key: string, value: unknown) => Promise<boolean>
  onPick: () => void
  onOpen: () => void
}) {
  if (field.kind === "switch")
    return (
      <SwitchRow
        id={`general-${field.key}`}
        title={fieldLabel(field.key)}
        checked={rowOn(block, field.key)}
        disabled={disabled || saving}
        onCheckedChange={(next) => void onWrite(field.key, next)}
        data-setting={field.key}
      />
    )
  return (
    <ValueRow
      title={fieldLabel(field.key)}
      // A key whose value reads wrong on its own carries the host's sentence about it.
      purpose={field.note}
      value={generalRowValue(block, field)}
      muted={!explicitly(block, field.key)}
      busy={saving}
      disabled={disabled}
      onClick={() => (field.kind === "pick" ? onPick() : onOpen())}
      data-setting={field.key}
    />
  )
}

/**
 * One of the host's settings, typed in: its value, the host's default behind it as the placeholder,
 * and a reset where the file holds a value — which writes null, so the key leaves the file and the
 * host's default takes over. A number that isn't one, or a list's entry left empty, is refused here
 * before anything is written.
 */
function FieldForm({
  block,
  field,
  saving,
  onWrite,
  onClose,
}: {
  block: GeneralSettings
  field: GeneralField
  saving: boolean
  onWrite: (key: string, value: unknown) => Promise<boolean>
  onClose: () => void
}) {
  const large = useLarge()
  const fallback = block.defaults[field.key]
  return (
    <EditForm
      label={fieldLabel(field.key)}
      busy={saving}
      surface={large ? "card" : "screen"}
      value={draftOf(block, field)}
      kind={field.kind === "number" ? "number" : "text"}
      placeholder={field.kind === "list" ? "comma, separated" : String(fallback ?? "")}
      note={field.restart ? RESTART_NOTE : undefined}
      onSave={(text) => {
        const parsed = draftValue(field, text)
        if (!parsed.ok) {
          toast.error(field.kind === "number" ? "That isn't a number." : "Couldn't save that.")
          return
        }
        void onWrite(field.key, parsed.value).then((ok) => ok && onClose())
      }}
      onReset={
        explicitly(block, field.key)
          ? () => void onWrite(field.key, null).then((ok) => ok && onClose())
          : undefined
      }
      onCancel={onClose}
    />
  )
}

/**
 * What a bot is, on its own page: its switches and the plugin its host runs, then what it looks like
 * and how it connects, then what sits on its Hermes. Every setting is a value that opens its edit or
 * its pick — no card holds a field (ADR 0055) — but the plugin is a fact the page reports, so its
 * row opens nothing (ADR 0143).
 */
function BotCard({ profile, onOpen }: { profile: Profile; onOpen: (id: string) => void }) {
  const linked = Boolean(profile.hostId)
  const [pick, setPick] = useState<string>()
  const character = BOTS.find((bot) => bot.id === profile.botId)
  // The version the bot's host runs, off the `info` read the page already makes for its gates.
  const plugin = usePluginVersion(profile)
  const reported = plugin && (plugin.version ?? "No plugin")
  const save = (patch: Partial<Omit<Profile, "id">>) => void updateProfile(profile.id, patch)

  // What this device keeps follows the Host's own answer, never the copy it cached from an earlier
  // open (ADR 0132), and only when the version moved: the banner and the Settings menu's tag read
  // this field, so they say what the Host said rather than what this device remembered.
  useEffect(() => {
    if (!plugin?.fromHost) return
    // A host that answers without a plugin runs none, so no version is stored and the banner that
    // read one goes; a host whose version moved replaces it. Either way the field follows the host.
    const next = plugin.version ?? undefined
    if (next === profile.pluginVersion) return
    void db.profiles.update(profile.id, { pluginVersion: next })
  }, [profile.id, profile.pluginVersion, plugin])

  return (
    <div className="flex flex-col gap-4" data-bot-card>
      <Group>
        {linked && <EnabledSetting profile={profile} />}
        <MutedSetting profile={profile} />
        <ValueRow
          title="Plugin"
          value={reported}
          muted={!plugin?.version}
          data-setting="plugin"
        />
      </Group>

      <Caption>Bot Profile</Caption>
      <Group>
        <ValueRow
          title="Name"
          value={profile.name}
          onClick={() => onOpen("name")}
          data-setting="name"
        />
        <ValueRow
          title="Image"
          value={character?.name ?? ""}
          onClick={() => setPick("image")}
          trailing={<Bot id={profile.botId} className="size-10" />}
          data-setting="image"
        />
        <RemindersSetting profile={profile} />
      </Group>

      {/* A linked bot's server is not the reader's to see, so the card is the unlinked bot's only: the
          subagent model lives on the Delegation page. */}
      {!linked && (
        <>
          <Caption>Hermes</Caption>
          <Group>
            <ValueRow
              title="API base URL"
              purpose="Where this bot's Hermes server is"
              value={profile.baseUrl}
              onClick={() => onOpen("base-url")}
              data-setting="base-url"
            />
            <ValueRow
              title="Server key"
              purpose="The key this app sends to that server"
              value={profile.apiKey ? "••••••••" : ""}
              onClick={() => onOpen("server-key")}
              data-setting="server-key"
            />
          </Group>
        </>
      )}

      <PickSurface
        open={pick === "image"}
        onOpenChange={(open) => !open && setPick(undefined)}
        title="Image"
      >
        <PickList
          label="Image"
          searchable={false}
          selected={profile.botId}
          options={BOTS.map((bot) => ({
            id: bot.id,
            label: bot.name,
            leading: <Bot id={bot.id} className="size-8 shrink-0" />,
          }))}
          onPick={(id) => {
            save({ botId: id })
            setPick(undefined)
          }}
        />
      </PickSurface>
    </div>
  )
}

/** The Models page: the bot's Hermes models, each a value that opens its pick. */
function ModelsPage({ profile }: { profile: Profile }) {
  const [pick, setPick] = useState<string>()
  const info = useModelInfo(profile)
  const own = botModel(profile, info)

  return (
    <div className="flex flex-col gap-4" data-bot-models>
      <Caption>Hermes</Caption>
      <Group>
        <ValueRow
          title="Model"
          purpose="The model a chat runs when it has no pick of its own"
          value={profile.model}
          onClick={() => setPick("model")}
          data-setting="model"
        />
      </Group>

      <ModelPick
        open={pick === "model"}
        title="Model"
        profile={profile}
        choice={own}
        fallback={{ label: "Default model", model: own?.model }}
        onPick={(next) => (next ? updateProfile(profile.id, { model: next.model }) : undefined)}
        onClose={() => setPick(undefined)}
      />
    </div>
  )
}

/** The chain a bot's host tries after its main model: what the Fallback providers drill-in holds. */
function FallbacksPage({ profile }: { profile: Profile }) {
  const { list, saving, save } = useFallbackModels(profile)
  const info = useModelInfo(profile)
  const providers = info?.providers ?? []
  const [pick, setPick] = useState<number>()
  const cannotEdit = !providers.length || saving

  const write = (next: ModelChoice[]) =>
    void save(next).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error))
    })

  // Adding is the screen's own action, in its header: a row that added was a setting among settings,
  // and this screen holds a chain of picks, not a row to write.
  useHeaderAction(
    "add",
    <Button
      variant="outline"
      size="icon-lg"
      className="size-11 rounded-full"
      aria-label="Add fallback"
      // Hermes holds a chain of two: at the cap the header has nothing left to add.
      disabled={cannotEdit || list.length >= MAX_FALLBACKS}
      onClick={() => setPick(list.length)}
    >
      <PlusIcon />
    </Button>,
  )

  return (
    <div className="flex flex-col gap-4" data-fallbacks>
      {list.length ? (
        <Group>
          {list.map((fallback, index) => (
            <ValueRow
              key={index}
              title={`Fallback ${index + 1}`}
              value={fullModel(fallback)}
              onClick={() => setPick(index)}
              disabled={cannotEdit}
              busy={saving}
              data-fallback={index + 1}
              trailing={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  className="size-11 shrink-0"
                  aria-label={`Remove fallback ${index + 1}`}
                  disabled={saving}
                  onClick={() => write(list.filter((_, at) => at !== index))}
                >
                  <XIcon />
                </Button>
              }
            />
          ))}
        </Group>
      ) : (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          {cannotEdit && !providers.length
            ? "No fallbacks. This bot's Hermes hasn't reported the providers to pick one from."
            : "No fallbacks. Hermes tries the main model alone."}
        </p>
      )}

      <ModelPick
        open={pick !== undefined}
        title="Fallback provider"
        profile={profile}
        choice={pick === undefined ? undefined : list[pick]}
        fallback={{ label: "None" }}
        onPick={(next) => {
          if (pick === undefined) return
          if (next) {
            const kept = [...list]
            kept[pick] = next
            write(kept)
          } else if (pick < list.length) {
            write(list.filter((_, at) => at !== pick))
          }
        }}
        onClose={() => setPick(undefined)}
      />
    </div>
  )
}
