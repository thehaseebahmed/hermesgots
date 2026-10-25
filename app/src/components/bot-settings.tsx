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
import { DictationTab } from "@/components/bot-dictation-tab"
import { ModelPicker } from "@/components/chat/model-picker"
import { McpsTab } from "@/components/mcps-tab"
import { SkillsTab } from "@/components/skills-tab"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Caption,
  EditCard,
  EditForm,
  Group,
  PickList,
  PickSurface,
  SwitchRow,
  ValueRow,
  linkRowClass,
  rowClass,
  useHeaderAction,
} from "@/components/settings-chrome"
import { AFK_PICKS_FEATURE } from "@/lib/afk-picks"
import { botSubPath, type BotSub } from "@/lib/bot-subs"
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
import { checkHealth, getPluginVersion, listModels } from "@/lib/hermes"
import { BOT_PAGES, botTabPath, type BotPage, type BotTab } from "@/lib/bot-tabs"
import { useLarge } from "@/lib/media"
import { MCP_FEATURES } from "@/lib/mcps"
import { botModel, fullModel, setDefaultModel, useModelInfo } from "@/lib/model-info"
import { syncContextWindow } from "@/lib/models"
import { setBotMuted } from "@/lib/push"
import { isOnline, removeHost, setBotEnabled } from "@/lib/registry"
import { SKILL_FEATURES } from "@/lib/skills"
import { useNow } from "@/lib/threads"
import { useTriageModel } from "@/lib/triage-model"
import { cn } from "@/lib/utils"
import { MIN_PLUGIN_VERSION, pluginOutdated } from "@/lib/version"

type Connection =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; plugin: string | null }
  | { state: "error"; message: string }

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

/** What the Chat page's two rows need: the Gots triage pick, and the chain after the main model. */
const CHAT_ANSWERS = { triage: "triage_model", fallbacks: "fallbacks" } as const

/** The icon a page's row, and the screen it opens, wear. */
const PAGE_ICONS: Record<BotTab, LucideIcon> = {
  general: SlidersHorizontalIcon,
  chat: MessagesSquareIcon,
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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {profile.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {linked
              ? `Its host is unlinked${others ? `, and so is every bot it linked: ${others}` : ""}. Its chats stay on your Hermes server, and linking it again brings them back.`
              : "Its chats are removed too. The profile and its sessions on your Hermes server are untouched."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
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
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-base">{page.title}</span>
        <span className="line-clamp-2 text-sm text-muted-foreground">{page.subtitle}</span>
      </span>
    </Link>
  )
}

/**
 * A bot's settings as a list of pages: the plugin banner when it is out of date, then the pages in
 * three cards — General on its own, the Gots plugin's pages, then the bot's Hermes's — separated by
 * gaps and carrying no captions (ADR 0055). A page the plugin withholds draws no row. The header's
 * trash deletes the bot, asking first; an unlinked bot is left alone where this device holds no
 * other bot to fall back on.
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
  const rows = (group: BotPage["group"]) =>
    BOT_PAGES.filter((page) => page.group === group).map((page) => {
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
      <Group>{rows("general")}</Group>
      <Group>{rows("gots")}</Group>
      <Group>{rows("hermes")}</Group>
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

  // The pages with sub-screens of their own draw them; General and Chat draw theirs here.
  if (shown === "speech-to-text") return <DictationTab profile={profile} sub={sub} />
  if (shown === "mcps") return <McpsTab profile={profile} sub={sub} />
  if (shown === "coding") return <CodingTab profile={profile} />
  if (shown === "skills") return <SkillsTab profile={profile} sub={sub} />

  // A detail is the pane's content at either width; below 1024px the route pushed it there, and a
  // page's own edit is the screen the route pushed.
  if (sub && (sub.kind === "detail" || !large))
    return <PageSub profile={profile} tab={shown} sub={sub} close={close} />

  const page =
    shown === "chat" ? (
      <ChatPage profile={profile} />
    ) : (
      <GeneralPage
        profile={profile}
        delegation={answers.delegation === "yes"}
        onOpen={(id) => navigate(botSubPath(profile.id, "general", id))}
      />
    )

  if (!sub) return page
  return (
    <>
      {page}
      <EditCard title={sub.title} onClose={close}>
        <PageSub profile={profile} tab={shown} sub={sub} close={close} />
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
  if (tab === "chat" && sub.id === "fallbacks") return <FallbacksPage profile={profile} />
  if (tab !== "general") return null
  return (
    <EditForm
      label={sub.title}
      value={editValue(profile, sub.id)}
      placeholder={editPlaceholder(sub.id)}
      kind={sub.id === "server-key" ? "secret" : sub.id === "base-url" ? "url" : "text"}
      onSave={(value) => {
        void updateProfile(profile.id, editPatch(sub.id, value))
        close()
      }}
      onCancel={close}
    />
  )
}

/** The field a General edit holds, read from the bot. */
function editValue(profile: Profile, id: string) {
  if (id === "name") return profile.name
  if (id === "base-url") return profile.baseUrl
  if (id === "server-key") return profile.apiKey
  return ""
}

function editPlaceholder(id: string) {
  if (id === "name") return "Hermes profile name"
  if (id === "base-url") return "http://localhost:8642/v1"
  return "API_SERVER_KEY"
}

/** The one write an edit makes, in the field the value belongs to. */
function editPatch(id: string, value: string): Partial<Omit<Profile, "id">> {
  if (id === "name") return { name: value.trim() || "Hermes" }
  if (id === "base-url") return { baseUrl: value.trim() }
  return { apiKey: value.trim() }
}

const TRIAGE_PURPOSE =
  "Decides whether a message sent from Main stays there, continues a thread or starts a new one. It only makes that call, so a small, fast model is enough. Default model uses the bot's own."

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
  const providers = info?.providers ?? []
  const own = botModel(profile, info)
  const record = useDelegationModel(profile)
  const character = BOTS.find((bot) => bot.id === profile.botId)
  const [connection, setConnection] = useState<Connection>({ state: "idle" })
  const save = (patch: Partial<Omit<Profile, "id">>) => void updateProfile(profile.id, patch)

  const test = async () => {
    setConnection({ state: "testing" })
    try {
      await checkHealth(profile)
      const ids = await listModels(profile, AbortSignal.timeout(10_000))
      if (ids.length && !ids.includes(profile.model)) save({ model: ids[0] })
      const plugin = await getPluginVersion(profile)
      setConnection({ state: "ok", plugin })
      if (plugin) await db.profiles.update(profile.id, { pluginVersion: plugin })
      const saved = await db.profiles.get(profile.id)
      if (saved) await syncContextWindow(saved)
    } catch (error) {
      setConnection({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <>
      <Group>
        {linked && <EnabledSetting profile={profile} />}
        <MutedSetting profile={profile} />
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
          value={character?.name}
          onClick={() => setPick("image")}
          data-setting="image"
        />
        <div className={cn(rowClass, "flex-wrap items-center gap-3")} data-setting="test">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-base">Test connection</span>
            <span className="text-sm text-muted-foreground">
              {connection.state === "error"
                ? connection.message
                : "Ask this bot's server how it is"}
            </span>
          </span>
          {connection.state === "ok" && (
            <span className="flex flex-wrap gap-2">
              <Badge className="bg-primary/15 text-primary dark:bg-primary/30 dark:text-sidebar-primary">
                Connected
              </Badge>
              {connection.plugin ? (
                <Badge variant="secondary">Plugin {connection.plugin}</Badge>
              ) : (
                <Badge variant="outline">No plugin</Badge>
              )}
            </span>
          )}
          <Button
            onClick={test}
            disabled={connection.state === "testing" || profile.disabled}
            aria-label="Test connection"
          >
            <PlugZapIcon data-icon="inline-start" />
            {connection.state === "testing" ? "Testing…" : "Test"}
          </Button>
        </div>
        {connection.state === "error" && (
          <p className={cn(rowClass, "text-sm text-destructive")} role="alert">
            {connection.message}
          </p>
        )}
      </Group>

      {(delegation || !linked) && (
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

      <PickSurface
        open={pick === "subagent"}
        onOpenChange={(open) => !open && setPick(undefined)}
        title="Subagent model"
      >
        <ModelPicker
          header={false}
          providers={providers}
          fallback={{ label: "Default model", model: own?.model }}
          recent={profile.recentModels}
          choice={record.pick}
          onChoose={(next) => {
            void record.save(next).catch((error: unknown) => {
              toast.error(error instanceof Error ? error.message : String(error))
            })
            setPick(undefined)
          }}
        />
      </PickSurface>
    </>
  )
}

/** The Chat page: Gots's triage model over the bot's Hermes models, each a value that opens its pick. */
function ChatPage({ profile }: { profile: Profile }) {
  const answers = usePluginFeatureAnswers(profile, CHAT_ANSWERS)
  const triage = answers.triage === "yes"
  const fallbacks = answers.fallbacks === "yes"
  const [pick, setPick] = useState<string>()
  const navigate = useNavigate()
  const info = useModelInfo(profile)
  const providers = info?.providers ?? []
  const own = botModel(profile, info)
  const triageRecord = useTriageModel(profile)
  const chain = useFallbackModels(profile)
  const defaultModel = botModel(profile, info)
  const chains = chain.list.length

  return (
    <div className="flex flex-col gap-4" data-bot-chat>
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
          value={defaultModel ? fullModel(defaultModel) : ""}
          onClick={() => setPick("default-model")}
          data-setting="default-model"
        />
        {fallbacks && chain.supported && (
          <ValueRow
            title="Fallback providers"
            purpose="The chain Hermes tries after the main model"
            value={chains ? `${chains} ${chains === 1 ? "provider" : "providers"}` : "None"}
            onClick={() => navigate(botSubPath(profile.id, "chat", "fallbacks"))}
            data-setting="fallbacks"
          />
        )}
      </Group>

      <PickSurface
        open={pick === "model"}
        onOpenChange={(open) => !open && setPick(undefined)}
        title="Model"
      >
        {!providers.length && <NoModels />}
        <ModelPicker
          header={false}
          providers={providers}
          fallback={{ label: "Default model", model: own?.model }}
          recent={profile.recentModels}
          choice={profile.model ? { provider: "", model: profile.model } : undefined}
          onChoose={(next) => {
            if (next) void updateProfile(profile.id, { model: next.model })
            setPick(undefined)
          }}
        />
      </PickSurface>

      <PickSurface
        open={pick === "default-model"}
        onOpenChange={(open) => !open && setPick(undefined)}
        title="Default model"
      >
        {!providers.length && <NoModels />}
        <ModelPicker
          header={false}
          providers={providers}
          fallback={{ label: "Default", model: info?.model }}
          recent={profile.recentModels}
          choice={profile.modelChoice}
          onChoose={(next) => {
            void setDefaultModel(profile, next).catch((error: unknown) => {
              toast.error(error instanceof Error ? error.message : String(error))
            })
            setPick(undefined)
          }}
        />
      </PickSurface>

      <PickSurface
        open={pick === "triage-model"}
        onOpenChange={(open) => !open && setPick(undefined)}
        title="Triage model"
      >
        <ModelPicker
          header={false}
          providers={providers}
          fallback={{ label: "Default model", model: own?.model }}
          recent={profile.recentModels}
          choice={triageRecord.pick}
          onChoose={(next) => {
            void triageRecord.save(next).catch((error: unknown) => {
              toast.error(error instanceof Error ? error.message : String(error))
            })
            setPick(undefined)
          }}
        />
      </PickSurface>
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
          <div key={index} className="flex items-center gap-1 bg-card">
            <button
              type="button"
              disabled={cannotEdit}
              aria-busy={saving || undefined}
              onClick={() => setPick(index)}
              className="flex min-h-14 min-w-0 flex-1 flex-col justify-center gap-0.5 px-5 py-3 text-left transition-colors hover:bg-muted disabled:opacity-60"
              data-fallback={index + 1}
            >
              <span className="text-base">Fallback {index + 1}</span>
              <span className="truncate text-sm text-primary">{fullModel(fallback)}</span>
            </button>
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
          </div>
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

      <PickSurface
        open={pick !== undefined}
        onOpenChange={(open) => !open && setPick(undefined)}
        title="Fallback provider"
      >
        <ModelPicker
          header={false}
          providers={providers}
          fallback={{ label: "None" }}
          recent={profile.recentModels}
          choice={pick === undefined ? undefined : list[pick]}
          onChoose={(next) => {
            if (pick === undefined) {
              setPick(undefined)
              return
            }
            if (next) {
              const kept = [...list]
              kept[pick] = next
              write(kept)
            } else if (pick < list.length) {
              write(list.filter((_, at) => at !== pick))
            }
            setPick(undefined)
          }}
        />
      </PickSurface>
    </div>
  )
}

/** What a pick says where the bot's host answered no models at all. */
function NoModels() {
  return <p className="px-1 py-2 text-sm text-muted-foreground">Couldn't read this bot's models.</p>
}
