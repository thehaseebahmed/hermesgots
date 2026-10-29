import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  AudioLinesIcon,
  CodeXmlIcon,
  MessagesSquareIcon,
  PlusIcon,
  PlugZapIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"

import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { BOTS } from "@/components/bots"
import { CodingTab } from "@/components/bot-coding-tab"
import { Segmented } from "@/components/segmented"
import { DictationTab } from "@/components/bot-dictation-tab"
import { McpsTab } from "@/components/mcps-tab"
import { SkillsTab } from "@/components/skills-tab"
import {
  Caption,
  ConfirmDestructive,
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
import { AFK_PICKS_FEATURE } from "@/lib/afk-picks"
import { botTabPath, BOT_PAGES, type BotPage, type BotTab } from "@/lib/bot-tabs"
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
import { usePluginFeatureAnswers } from "@/lib/features"
import { formatRelative } from "@/lib/format"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import {
  checkHealth,
  getPluginVersion,
  listModels,
  REMINDER_LEVELS,
  type ReminderLevel,
} from "@/lib/hermes"
import { useLarge } from "@/lib/media"
import { MCP_FEATURES } from "@/lib/mcps"
import { botModel, fullModel, setDefaultModel, useModelInfo } from "@/lib/model-info"
import { syncContextWindow } from "@/lib/models"
import { setBotMuted } from "@/lib/push"
import { useReminders } from "@/lib/reminders"
import { isOnline, removeHost, setBotEnabled } from "@/lib/registry"
import { SKILL_FEATURES } from "@/lib/skills"
import { useNow } from "@/lib/threads"
import { useTriageModel } from "@/lib/triage-model"
import { cn } from "@/lib/utils"
import { MIN_PLUGIN_VERSION, pluginOutdated } from "@/lib/version"

type Connection =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; plugin: string | null; key: string }
  | { state: "error"; message: string; key: string }

/** The pages a plugin can withhold, by the segment naming them: the rest are always there. */
const PAGE_FEATURES = {
  "speech-to-text": DICTATION,
  mcps: MCP_FEATURES.list,
  coding: AFK_PICKS_FEATURE,
  skills: SKILL_FEATURES.list,
} as const

type GatedPage = keyof typeof PAGE_FEATURES

function gated(page: BotTab): page is GatedPage {
  return page in PAGE_FEATURES
}

/**
 * Everything a page asks the plugin about: the pages it can withhold, and the rows it holds only
 * where the plugin advertises them — a linked bot's Hermes side is left with no row at all when the
 * delegation model is withheld.
 */
const PAGE_ANSWERS = { ...PAGE_FEATURES, delegation: "delegation_model" } as const

/** What the Models page's two rows need: the Gots triage pick, and the chain after the main model. */
const MODELS_ANSWERS = { triage: "triage_model", fallbacks: "fallbacks" } as const

/** The icon a page's row, and the screen it opens, wear. */
const PAGE_ICONS: Record<BotTab, LucideIcon> = {
  general: SlidersHorizontalIcon,
  models: MessagesSquareIcon,
  coding: CodeXmlIcon,
  "speech-to-text": AudioLinesIcon,
  mcps: PlugZapIcon,
  skills: WrenchIcon,
}

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
  normal: "Normal",
  frequent: "Frequent",
}

/**
 * How often Gots asks this bot to say what it is doing (`progress.py`, ADR 0066): a value held per
 * bot on its host, set where the switches beside it are set, since a control that acts where it
 * sits is what the row is (ADR 0055).
 *
 * The words name what Gots does, not what the bot will do: however often it is asked, how much it
 * says is the model's own choice, and the line under the row tells the reader so. Nothing here
 * shows a count — twenty calls and ten are the loop's business, not the reader's.
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
  const siblings = useLiveQuery(
    async (): Promise<Profile[]> =>
      profile.hostId
        ? db.profiles.filter((p) => p.hostId === profile.hostId && p.id !== profile.id).toArray()
        : [],
    [profile.hostId, profile.id],
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
  const Icon = PAGE_ICONS[page.segment]
  return (
    <Link
      to={botTabPath(botId, page.segment)}
      replace={replace}
      data-bot-page={page.segment}
      className={linkRowClass}
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title={page.title} subtitle={page.subtitle} />
    </Link>
  )
}

/**
 * A bot's settings as a list of pages: the plugin banner when it is out of date, then the pages in
 * two cards — General on its own, then every other page under it — separated by gaps and carrying no
 * captions (ADR 0055). A page the plugin withholds draws no row. The header's trash deletes the bot,
 * asking first; an unlinked bot is left alone where this device holds no other bot to fall back on.
 */
export function BotSettingsList({
  profile,
  replace,
  canDelete = false,
  onDeleted,
}: {
  profile: Profile
  /** Whether the row swaps the pane beside it rather than opening a screen of its own. */
  replace?: boolean
  /** Whether this device holds a bot to fall back on: an unlinked bot can't be the last one. */
  canDelete?: boolean
  onDeleted?: () => void
}) {
  const answers = usePluginFeatureAnswers(profile, PAGE_FEATURES)
  const [confirming, setConfirming] = useState(false)
  const linked = Boolean(profile.hostId)
  const rows = (pages: readonly BotPage[]) =>
    pages.map((page) => {
      const segment = page.segment
      if (gated(segment) && answers[segment] !== "yes") return null
      return <PageRow key={segment} page={page} botId={profile.id} replace={replace} />
    })

  // The trash is the screen's own action, and its handler is the setter: the header reads the node
  // it was published with, and never re-renders for a change in the list below it.
  useHeaderAction(
    "delete",
    <Button
      variant="outline"
      size="icon-lg"
      className="size-11 rounded-full"
      aria-label={`Delete ${profile.name}`}
      title={`Delete ${profile.name}`}
      disabled={!linked && !canDelete}
      onClick={() => setConfirming(true)}
    >
      <Trash2Icon />
    </Button>,
  )

  return (
    <div className="flex flex-col gap-4" data-bot-settings-list>
      {!profile.disabled && pluginOutdated(profile.pluginVersion) && (
        <Banner tone="warning">
          {`This bot's plugin is out of date! Update it to ${MIN_PLUGIN_VERSION} or newer.`}
        </Banner>
      )}
      <Group>{rows(BOT_PAGES.slice(0, 1))}</Group>
      <Group>{rows(BOT_PAGES.slice(1))}</Group>
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
  const answers = usePluginFeatureAnswers(profile, PAGE_ANSWERS)
  const gate = gated(tab) ? answers[tab] : undefined
  const shown: BotTab = gate !== undefined && gate !== "yes" ? "general" : tab
  const large = useLarge()
  const navigate = useNavigate()
  // Only the page on screen owns its sub: an address into a page this bot doesn't have draws the
  // page it fell back to, never the other page's edit — and never a write to a field it doesn't hold.
  const own = tab === shown ? sub : undefined

  // A URL into a page this bot doesn't have: General takes its place, in the history entry it was
  // asked for, rather than the address reading MCP over a screen that isn't. Only an answer of "no"
  // sends anyone anywhere — a Host still reading keeps the address and draws General meanwhile.
  useEffect(() => {
    if (gate === "no") void navigate(botTabPath(profile.id, "general"), { replace: true })
  }, [gate, navigate, profile.id])

  const close = useCallback(
    () => navigate(botTabPath(profile.id, shown), { replace: true }),
    [navigate, profile.id, shown],
  )

  // The pages with sub-screens of their own draw them; General and Models draw theirs here.
  if (shown === "speech-to-text") return <DictationTab profile={profile} sub={own} />
  if (shown === "mcps") return <McpsTab profile={profile} sub={own} />
  if (shown === "coding") return <CodingTab profile={profile} />
  if (shown === "skills") return <SkillsTab profile={profile} sub={own} />

  // A detail is the pane's content at either width; below 1024px the route pushed it there, and a
  // page's own edit is the screen the route pushed.
  if (own && (own.kind === "detail" || !large))
    return <PageSub profile={profile} tab={shown} sub={own} close={close} />

  const page =
    shown === "models" ? (
      <ModelsPage profile={profile} />
    ) : (
      <GeneralPage
        profile={profile}
        delegation={answers.delegation === "yes"}
        onOpen={(id) => navigate(botSubPath(profile.id, "general", id))}
      />
    )

  if (!own) return page
  return (
    <>
      {page}
      <EditCard title={own.title} onClose={close}>
        <PageSub profile={profile} tab={shown} sub={own} close={close} />
      </EditCard>
    </>
  )
}

/** The body of a page's sub-screen, wherever it is drawn: a pushed screen, a card, or the pane. */
function PageSub({
  profile,
  tab,
  sub,
  close,
}: {
  profile: Profile
  tab: BotTab
  sub: BotSub
  close: () => void
}) {
  if (tab === "models") return <FallbacksPage profile={profile} />
  const edit = generalEdit(sub.id)
  // A segment the router refused never reaches here; one the table doesn't name holds no field, so
  // no id can fall through to a write the page doesn't mean.
  if (!edit) return null
  return (
    <EditForm
      label={sub.title}
      value={edit.read(profile)}
      placeholder={edit.placeholder}
      kind={edit.kind}
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

/** A General edit: the field it holds on the bot, and the one write it makes. */
type GeneralEdit = {
  read: (profile: Profile) => string
  placeholder: string
  kind: "text" | "url" | "secret"
  patch: (value: string) => Partial<Omit<Profile, "id">>
}

const GENERAL_EDITS = {
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
} satisfies Record<string, GeneralEdit>

function generalEdit(id: string): GeneralEdit | undefined {
  return id in GENERAL_EDITS ? GENERAL_EDITS[id as keyof typeof GENERAL_EDITS] : undefined
}

const TRIAGE_PURPOSE = "Whether a message from Main starts a new thread or continues one"

/**
 * General, by ownership: the bot's own switches, then what it looks like and how it connects, then
 * what sits on its Hermes. Every setting is a value that opens its edit or its pick — no card holds
 * a field (ADR 0055).
 */
function GeneralPage({
  profile,
  delegation,
  onOpen,
}: {
  profile: Profile
  /** Whether the bot's Hermes advertises the delegation model row. */
  delegation: boolean
  onOpen: (id: string) => void
}) {
  const linked = Boolean(profile.hostId)
  const [pick, setPick] = useState<string>()
  const info = useModelInfo(profile)
  const own = botModel(profile, info)
  const record = useDelegationModel(profile)
  const character = BOTS.find((bot) => bot.id === profile.botId)
  const [connection, setConnection] = useState<Connection>({ state: "idle" })
  // The answer belongs to the connection it tested: an edited address or key is a connection nothing
  // has asked yet, so the row reads idle rather than claiming a server it never reached.
  const key = connectionKey(profile)
  const tested = connection.state === "ok" || connection.state === "error" ? connection : undefined
  const answer = tested?.key === key ? tested : undefined
  const save = (patch: Partial<Omit<Profile, "id">>) => void updateProfile(profile.id, patch)

  const test = async () => {
    // Bounded like every read: a host that stops answering mid-way leaves no row testing.
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS)
    setConnection({ state: "testing" })
    try {
      await checkHealth(profile, signal)
      const ids = await listModels(profile, signal)
      if (ids.length && !ids.includes(profile.model)) save({ model: ids[0] })
      const plugin = await getPluginVersion(profile)
      setConnection({ state: "ok", plugin, key })
      if (plugin) await db.profiles.update(profile.id, { pluginVersion: plugin })
      const saved = await db.profiles.get(profile.id)
      if (saved) await syncContextWindow(saved)
    } catch (error) {
      setConnection({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
        key,
      })
    }
  }

  return (
    <>
      <Group>
        {linked && <EnabledSetting profile={profile} />}
        <MutedSetting profile={profile} />
        <RemindersSetting profile={profile} />
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
        <ValueRow
          title="Test connection"
          purpose="Ask this bot's server how it is"
          // The answer takes the value's place under the purpose: the accent where it connected, the
          // host's own sentence in red where it didn't.
          trailing={
            <Button
              onClick={test}
              disabled={connection.state === "testing" || profile.disabled}
              aria-label="Test connection"
            >
              <PlugZapIcon data-icon="inline-start" />
              {connection.state === "testing" ? "Testing…" : "Test"}
            </Button>
          }
          data-setting="test"
        >
          {answer && (
            <span
              role={answer.state === "error" ? "alert" : "status"}
              className={cn(
                "line-clamp-2 text-sm",
                answer.state === "error" ? "text-destructive" : "text-primary",
              )}
            >
              {answer.state === "error"
                ? answer.message
                : answer.plugin
                  ? `Connected · Plugin ${answer.plugin}`
                  : "Connected · No plugin"}
            </span>
          )}
        </ValueRow>
      </Group>

      {/* The caption and its rows read one gate: a bot whose host withholds the row, or hasn't
          answered, draws no card at all rather than one with a caption over nothing. */}
      {((delegation && record.supported) || !linked) && (
        <>
          <Caption>Hermes</Caption>
          <Group>
            {record.supported && (
              <ValueRow
                title="Subagent model"
                purpose="The model every subagent runs on"
                value={record.pick ? fullModel(record.pick) : "Default model"}
                disabled={record.saving}
                busy={record.saving}
                onClick={() => setPick("subagent")}
                data-setting="subagent-model"
              />
            )}
            {!linked && (
              <>
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
              </>
            )}
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

      <ModelPick
        open={pick === "subagent"}
        title="Subagent model"
        profile={profile}
        choice={record.pick}
        fallback={{ label: "Default model", model: own?.model }}
        onPick={(next) => record.save(next)}
        onClose={() => setPick(undefined)}
      />
    </>
  )
}

/** The Models page: Gots's triage model over the bot's Hermes models, each a value that opens its pick. */
function ModelsPage({ profile }: { profile: Profile }) {
  const answers = usePluginFeatureAnswers(profile, MODELS_ANSWERS)
  const triage = answers.triage === "yes"
  const fallbacks = answers.fallbacks === "yes"
  const [pick, setPick] = useState<string>()
  const navigate = useNavigate()
  const info = useModelInfo(profile)
  const own = botModel(profile, info)
  const triageRecord = useTriageModel(profile)
  const chain = useFallbackModels(profile)
  const chains = chain.list.length

  return (
    <div className="flex flex-col gap-4" data-bot-models>
      {triage && triageRecord.supported && (
        <>
          <Caption>Gots</Caption>
          <Group>
            <ValueRow
              title="Triage model"
              purpose={TRIAGE_PURPOSE}
              value={triageRecord.pick ? fullModel(triageRecord.pick) : "Default model"}
              disabled={triageRecord.saving}
              busy={triageRecord.saving}
              onClick={() => setPick("triage-model")}
              data-setting="triage-model"
            />
            {triageRecord.withheld && (
              <Banner>
                This host doesn't let Gots pick the model. Allow it with{" "}
                <code className="font-mono text-[13px]">hermes plugins enable memento</code>.
              </Banner>
            )}
          </Group>
        </>
      )}

      <Caption>Hermes</Caption>
      <Group>
        <ValueRow
          title="Model"
          purpose="The model a chat runs when it has no pick of its own"
          value={profile.model}
          onClick={() => setPick("model")}
          data-setting="model"
        />
        <ValueRow
          title="Default model"
          purpose="The host's main model, on every surface"
          value={own ? fullModel(own) : ""}
          onClick={() => setPick("default-model")}
          data-setting="default-model"
        />
        {fallbacks && chain.supported && (
          <ValueRow
            title="Fallback providers"
            purpose="The chain Hermes tries after the main model"
            value={chains ? `${chains} ${chains === 1 ? "provider" : "providers"}` : "None"}
            onClick={() => navigate(botSubPath(profile.id, "models", "fallbacks"))}
            data-setting="fallbacks"
          />
        )}
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

      <ModelPick
        open={pick === "default-model"}
        title="Default model"
        profile={profile}
        choice={profile.modelChoice}
        fallback={{ label: "Default", model: info?.model }}
        onPick={(next) => setDefaultModel(profile, next)}
        onClose={() => setPick(undefined)}
      />

      <ModelPick
        open={pick === "triage-model"}
        title="Triage model"
        profile={profile}
        choice={triageRecord.pick}
        fallback={{ label: "Default model", model: own?.model }}
        onPick={(next) => triageRecord.save(next)}
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

  return (
    <div className="flex flex-col gap-4" data-fallbacks>
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
                className="mr-3 size-11 shrink-0"
                aria-label={`Remove fallback ${index + 1}`}
                disabled={saving}
                onClick={() => write(list.filter((_, at) => at !== index))}
              >
                <XIcon />
              </Button>
            }
          />
        ))}
        {list.length < MAX_FALLBACKS && (
          <button
            type="button"
            className={cn(linkRowClass, "gap-2 text-primary")}
            disabled={cannotEdit}
            onClick={() => setPick(list.length)}
          >
            <PlusIcon className="size-5 shrink-0" />
            <span className="text-base">Add fallback</span>
          </button>
        )}
      </Group>

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
