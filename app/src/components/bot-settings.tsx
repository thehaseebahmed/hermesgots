import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  AudioLinesIcon,
  ChevronRightIcon,
  CodeXmlIcon,
  EyeIcon,
  EyeOffIcon,
  MessagesSquareIcon,
  PlugZapIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react"
import { Link, useNavigate } from "react-router"
import { toast } from "sonner"

import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { BOTS } from "@/components/bots"
import { CodingTab } from "@/components/bot-coding-tab"
import { DictationTab } from "@/components/bot-dictation-tab"
import {
  DefaultModelSetting,
  DelegationModelSetting,
  TriageModelSetting,
  FallbackModelsSetting,
} from "@/components/chat/model-picker"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Group, GroupHeading, RowText, linkRowClass } from "@/components/settings-chrome"
import { AFK_PICKS_FEATURE } from "@/lib/afk-picks"
import {
  db,
  deleteProfile,
  getActiveProfile,
  getSettings,
  setActiveProfile,
  updateProfile,
  type Profile,
} from "@/lib/db"
import { connectionKey } from "@/lib/connection"
import { formatRelative } from "@/lib/format"
import { BOT_PAGES, botTabPath, type BotPage, type BotTab } from "@/lib/bot-tabs"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { DICTATION } from "@/lib/dictation"
import { usePluginFeatureAnswers } from "@/lib/features"
import { checkHealth, getPluginVersion, listModels } from "@/lib/hermes"
import { MCP_FEATURES } from "@/lib/mcps"
import { setDefaultModel } from "@/lib/model-info"
import { syncContextWindow } from "@/lib/models"
import { setBotMuted } from "@/lib/push"
import { isOnline, removeHost, setBotEnabled } from "@/lib/registry"
import { SKILL_FEATURES } from "@/lib/skills"
import { useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { MIN_PLUGIN_VERSION, pluginOutdated } from "@/lib/version"
import { McpsTab } from "@/components/mcps-tab"
import { SkillsTab } from "@/components/skills-tab"

type Connection =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; plugin: string | null }
  | { state: "error"; message: string }

/** Hermes's default model id; any other advertised id is the profile's name. */
const UNNAMED_MODEL = "hermes-agent"

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

/** The icon a page's row, and the screen it opens, wear. */
const PAGE_ICONS: Record<BotTab, LucideIcon> = {
  general: SlidersHorizontalIcon,
  chat: MessagesSquareIcon,
  coding: CodeXmlIcon,
  "speech-to-text": AudioLinesIcon,
  mcps: PlugZapIcon,
  skills: WrenchIcon,
}

/**
 * A setting's row inside one of a page's Group cards: the card's own surface, inset like a row.
 * Rows read as a title over the line saying what the setting is for.
 */
const rowSurface = "bg-card px-5 py-3"

/** The block holding what a bot looks like and how it connects, inside General's Gots side. */
const PROFILE_GROUP = {
  title: "Bot Profile",
  subtitle: "How this bot looks and connects",
} as const

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
    <Field orientation="horizontal" className={rowSurface}>
      <div className="flex-1 space-y-1">
        <FieldLabel htmlFor="enabled">Enabled</FieldLabel>
        <FieldDescription>{profile.disabled ? "Hidden in Gots" : seen}</FieldDescription>
      </div>
      <Switch
        id="enabled"
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
    </Field>
  )
}

/** Mutes every push from the bot, on every device. */
function MutedSetting({ profile }: { profile: Profile }) {
  return (
    <Field orientation="horizontal" className={rowSurface}>
      <div className="flex-1 space-y-1">
        <FieldLabel htmlFor="muted">Mute notifications</FieldLabel>
        <FieldDescription>Every push from this bot, on every device</FieldDescription>
      </div>
      <Switch
        id="muted"
        checked={Boolean(profile.muted)}
        onCheckedChange={(checked) => void setBotMuted(profile.id, checked)}
      />
    </Field>
  )
}

/** Unlinks the bot's host, which takes every bot it linked with it. */
function RemoveBot({ profile, onDeleted }: { profile: Profile; onDeleted?: () => void }) {
  const siblings = useLiveQuery(
    () => db.profiles.filter((p) => p.hostId === profile.hostId && p.id !== profile.id).toArray(),
    [profile.hostId, profile.id],
  )
  const others = siblings?.map((p) => p.name).join(", ")

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button variant="outline" className="ml-auto" />}>
        <Trash2Icon data-icon="inline-start" />
        Remove
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {profile.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its host is unlinked{others ? `, and so is every bot it linked: ${others}` : ""}. Its
            chats stay on your Hermes server, and linking it again brings them back.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={async () => {
              try {
                await removeHost(profile.hostId!)
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Couldn't remove it.")
                return
              }
              const next = await getActiveProfile()
              if (next) await setActiveProfile(next.id)
              onDeleted?.()
            }}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The two ownership headings the list wears; every page under one repeats it. */
const GROUP_TITLES = {
  gots: "Gots Specific Settings",
  hermes: "Hermes Settings",
} as const

/** A page's row: its icon, its name over what it holds, and the chevron into it. */
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
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  )
}

/**
 * A bot's settings as a list of pages: the plugin banner when it is out of date, then General on
 * its own, then the Gots plugin's pages and the bot's Hermes's, each under its ownership heading. A
 * page the plugin withholds draws no row — there is nothing behind it to open.
 */
export function BotSettingsList({ profile, replace }: { profile: Profile; replace?: boolean }) {
  const answers = usePluginFeatureAnswers(profile, PAGE_FEATURES)
  const rows = (group: BotPage["group"]) =>
    BOT_PAGES.filter((page) => page.group === group).map((page) => {
      const segment = page.segment
      if (gated(segment) && answers[segment] !== "yes") return null
      return <PageRow key={segment} page={page} botId={profile.id} replace={replace} />
    })

  return (
    <div className="flex flex-col gap-4" data-bot-settings-list>
      {!profile.disabled && pluginOutdated(profile.pluginVersion) && (
        <Banner tone="warning">
          {`This bot's plugin is out of date! Update it to ${MIN_PLUGIN_VERSION} or newer.`}
        </Banner>
      )}
      <Group>{rows("general")}</Group>
      <GroupHeading title={GROUP_TITLES.gots} />
      <Group>{rows("gots")}</Group>
      <GroupHeading title={GROUP_TITLES.hermes} />
      <Group>{rows("hermes")}</Group>
    </div>
  )
}

/**
 * One page of a bot's settings, drawing what its tab drew before the list: no tab strip, and a page
 * the plugin withholds is never shown — its address is given General's, in the entry it was asked
 * for.
 */
export function BotSettingsPage({
  profile,
  tab = "general",
  canDelete = false,
  onDeleted,
}: {
  profile: Profile
  tab?: BotTab
  canDelete?: boolean
  onDeleted?: () => void
}) {
  const linked = Boolean(profile.hostId)
  const navigate = useNavigate()
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [modelsFailed, setModelsFailed] = useState(false)
  const [connection, setConnection] = useState<Connection>({ state: "idle" })
  const answers = usePluginFeatureAnswers(profile, PAGE_FEATURES)
  const gate = gated(tab) ? answers[tab] : undefined
  const shown: BotTab = gate !== undefined && gate !== "yes" ? "general" : tab

  // Local drafts so typing isn't fighting the live query; persisted on every change.
  const [name, setName] = useState(profile.name)
  const [baseUrl, setBaseUrl] = useState(profile.baseUrl)
  const [apiKey, setApiKey] = useState(profile.apiKey)
  const [nameTouched, setNameTouched] = useState(false)

  const save = (patch: Partial<Omit<Profile, "id">>) => void updateProfile(profile.id, patch)

  // A URL into a page this bot doesn't have: General takes its place, in the history entry it was
  // asked for, rather than the address reading MCP over a screen that isn't. Only an answer of "no"
  // sends anyone anywhere — a Host still reading keeps the address and draws General meanwhile.
  useEffect(() => {
    if (gate === "no") void navigate(botTabPath(profile.id, "general"), { replace: true })
  }, [gate, navigate, profile.id])

  // One read of the host's model list, for both the tab's own open and General's Test connection.
  const readModels = useCallback(
    (config: Pick<Profile, "baseUrl" | "apiKey">) =>
      listModels(config, AbortSignal.timeout(READ_TIMEOUT_MS)),
    [],
  )

  // The Models tab reads the list itself when it opens: the choice is what the tab is for, and the
  // General tab's Test connection is the health check rather than the way to fill it. The
  // connection's own key is the dependency, so an edited address or key asks the new host rather
  // than showing the last one's models.
  const hostBaseUrl = linked ? profile.baseUrl : baseUrl
  const hostApiKey = linked ? profile.apiKey : apiKey
  const modelsKey = connectionKey({ baseUrl: hostBaseUrl, apiKey: hostApiKey })
  useEffect(() => {
    if (shown !== "chat") return
    let cancelled = false
    void readModels({ baseUrl: hostBaseUrl, apiKey: hostApiKey })
      .then((ids) => {
        if (cancelled) return
        setModels(ids)
        setModelsFailed(false)
      })
      .catch(() => {
        // The tab says it couldn't read them; Test connection in General says why in the Host's words.
        if (!cancelled) setModelsFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [shown, modelsKey, hostBaseUrl, hostApiKey, readModels])

  const test = async () => {
    setConnection({ state: "testing" })
    const config = linked ? profile : { baseUrl, apiKey }
    try {
      await checkHealth(config)
      const ids = await readModels(config)
      setModels(ids)
      setModelsFailed(false)
      if (ids.length && !ids.includes(profile.model)) save({ model: ids[0] })
      // A named profile advertises its name as the model id.
      const advertised = ids.find((id) => id !== UNNAMED_MODEL)
      if (advertised && !nameTouched && !linked) {
        setName(advertised)
        save({ name: advertised })
      }
      const plugin = await getPluginVersion(config)
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

  // Each page draws what its tab drew, and nothing of the others: the state above belongs to the
  // page on screen, since a phone shows one and a wide screen keys the pane by the page.
  if (shown === "chat")
    return <ChatPage profile={profile} models={models} modelsFailed={modelsFailed} save={save} />
  if (shown === "speech-to-text") return <DictationTab profile={profile} />
  if (shown === "mcps") return <McpsTab profile={profile} />
  if (shown === "coding") return <CodingTab profile={profile} />
  if (shown === "skills") return <SkillsTab profile={profile} />

  // General, by ownership: the Gots plugin's own switches, then what the bot looks like and how it
  // connects, then what sits on the bot's Hermes. A linked bot's address and key come from its host
  // and aren't shown; a bot added by hand before linking keeps its own.
  return (
    <>
      <GroupHeading title={GROUP_TITLES.gots} />
      <Group>
        {linked && <EnabledSetting profile={profile} />}
        <MutedSetting profile={profile} />
      </Group>

      <GroupHeading title={PROFILE_GROUP.title} subtitle={PROFILE_GROUP.subtitle} />
      <Group>
        <Field className={rowSurface}>
          <FieldLabel htmlFor="bot-name">Name</FieldLabel>
          <Input
            id="bot-name"
            autoComplete="off"
            placeholder="Hermes profile name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setNameTouched(true)
              save({ name: e.target.value.trim() || "Hermes" })
            }}
          />
        </Field>

        <Field className={rowSurface}>
          <FieldLabel id="bot-image-label">Image</FieldLabel>
          <div
            role="radiogroup"
            aria-labelledby="bot-image-label"
            className="grid grid-cols-4 gap-2 sm:grid-cols-8"
          >
            {BOTS.map((bot) => {
              const checked = bot.id === profile.botId
              return (
                <button
                  key={bot.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={bot.name}
                  onClick={() => save({ botId: bot.id })}
                  className={cn(
                    "flex aspect-square min-h-11 items-center justify-center rounded-2xl ring-1 ring-foreground/10 transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50",
                    checked && "bg-primary/10 ring-2 ring-primary hover:bg-primary/15",
                  )}
                >
                  <Bot id={bot.id} className="size-3/5" />
                </button>
              )
            })}
          </div>
        </Field>

        <div className={cn(rowSurface, "flex flex-wrap items-center gap-3")}>
          <Button onClick={test} disabled={connection.state === "testing" || profile.disabled}>
            <PlugZapIcon data-icon="inline-start" />
            {connection.state === "testing" ? "Testing…" : "Test connection"}
          </Button>
          {connection.state === "ok" && (
            <div className="flex flex-wrap gap-2">
              <Badge className="bg-primary/15 text-primary dark:bg-primary/30 dark:text-sidebar-primary">
                Connected
              </Badge>
              {connection.plugin ? (
                <Badge variant="secondary">Plugin {connection.plugin}</Badge>
              ) : (
                <Badge variant="outline">No plugin</Badge>
              )}
            </div>
          )}
          {linked ? (
            <RemoveBot profile={profile} onDeleted={onDeleted} />
          ) : (
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button variant="outline" className="ml-auto" disabled={!canDelete} />}
              >
                <Trash2Icon data-icon="inline-start" />
                Delete bot
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {profile.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Its chats are removed too. The profile and its sessions on your Hermes server
                    are untouched.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={async () => {
                      await deleteProfile(profile.id)
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
          )}
        </div>
        {connection.state === "error" && (
          <p className={cn(rowSurface, "text-sm text-destructive")} role="alert">
            {connection.message}
          </p>
        )}
      </Group>

      <GroupHeading title={GROUP_TITLES.hermes} />
      <Group>
        <div className={rowSurface}>
          <DelegationModelSetting profile={profile} subtitle="The model every subagent runs on" />
        </div>

        {!linked && (
          <>
            <Field className={rowSurface}>
              <FieldLabel htmlFor="base-url">API base URL</FieldLabel>
              <FieldDescription>Where this bot's Hermes server is</FieldDescription>
              <Input
                id="base-url"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="http://localhost:8642/v1"
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value)
                  setConnection({ state: "idle" })
                  save({ baseUrl: e.target.value.trim() })
                }}
              />
            </Field>

            <Field className={rowSurface}>
              <FieldLabel htmlFor="api-key">Server key</FieldLabel>
              <FieldDescription>The key this app sends to that server</FieldDescription>
              <InputGroup>
                <InputGroupInput
                  id="api-key"
                  type={showKey ? "text" : "password"}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="API_SERVER_KEY"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value)
                    setConnection({ state: "idle" })
                    save({ apiKey: e.target.value.trim() })
                  }}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label={showKey ? "Hide key" : "Show key"}
                    onClick={() => setShowKey((v) => !v)}
                  >
                    {showKey ? <EyeOffIcon /> : <EyeIcon />}
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>
          </>
        )}
      </Group>
    </>
  )
}

/** The Chat page: which model this bot talks with, its triage model, and its fallbacks. */
function ChatPage({
  profile,
  models,
  modelsFailed,
  save,
}: {
  profile: Profile
  /** The host's model ids, read by the page that owns the connection's drafts. */
  models: string[]
  modelsFailed: boolean
  save: (patch: Partial<Omit<Profile, "id">>) => void
}) {
  return (
    <FieldGroup>
      {models.length > 1 && (
        <Field>
          <FieldLabel htmlFor="model">Model</FieldLabel>
          <Select value={profile.model} onValueChange={(value) => value && save({ model: value })}>
            <SelectTrigger id="model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {models.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      {modelsFailed && models.length === 0 && (
        <p className="text-sm text-muted-foreground">Couldn't read this bot's models.</p>
      )}
      {profile.baseUrl.trim() && (
        <Field>
          <FieldLabel htmlFor="default-model">Default model</FieldLabel>
          <DefaultModelSetting
            profile={profile}
            onChoose={(modelChoice) =>
              setDefaultModel(profile, modelChoice).catch((error: unknown) => {
                toast.error(error instanceof Error ? error.message : String(error))
              })
            }
          />
        </Field>
      )}
      <TriageModelSetting profile={profile} />
      <FallbackModelsSetting profile={profile} />
    </FieldGroup>
  )
}
