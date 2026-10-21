import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { EyeIcon, EyeOffIcon, PlugZapIcon, Trash2Icon } from "lucide-react"
import { useNavigate } from "react-router"
import { toast } from "sonner"

import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { BOTS } from "@/components/bots"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
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
import { botTabOf, botTabPath, type BotTab } from "@/lib/bot-tabs"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { checkHealth, getPluginVersion, listModels } from "@/lib/hermes"
import { useMcpFeatureAnswers } from "@/lib/mcps"
import { setDefaultModel } from "@/lib/model-info"
import { syncContextWindow } from "@/lib/models"
import { setBotMuted } from "@/lib/push"
import { isOnline, removeHost, setBotEnabled } from "@/lib/registry"
import { useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { MIN_PLUGIN_VERSION, pluginOutdated } from "@/lib/version"
import { McpsTab } from "@/components/mcps-tab"

type Connection =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; plugin: string | null }
  | { state: "error"; message: string }

/** Hermes's default model id; any other advertised id is the profile's name. */
const UNNAMED_MODEL = "hermes-agent"

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
    <Field orientation="horizontal">
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
    <Field orientation="horizontal">
      <FieldLabel htmlFor="muted" className="flex-1">
        Mute notifications
      </FieldLabel>
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

/**
 * A bot's settings, in three tabs of its own screen — General, Models and MCP — with the tab held in
 * the URL, so each is a history entry of its own and back walks the way it was opened.
 *
 * General is what the bot is and how it is reached, the model it answers with is on Models with the
 * default and the fallbacks it falls back to, and MCP is its servers. The MCP tab exists only where
 * the bot's plugin advertises that it can list them, so a bot on an older plugin has two tabs and a
 * URL into a third lands on General rather than on a screen that can't draw.
 *
 * A linked bot's address and key come from its host and aren't shown; a bot added by hand before
 * linking keeps its own.
 */
export function BotEditor({
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
  // The Bot's MCP servers are a tab of its own; the tab exists only where the plugin says it can
  // list them, and a Host that hasn't answered yet shows General rather than flashing a tab away.
  const answers = useMcpFeatureAnswers(profile)
  const mcpServers = answers.list === "yes"
  const shown: BotTab = tab === "mcps" && !mcpServers ? "general" : tab

  // Local drafts so typing isn't fighting the live query; persisted on every change.
  const [name, setName] = useState(profile.name)
  const [baseUrl, setBaseUrl] = useState(profile.baseUrl)
  const [apiKey, setApiKey] = useState(profile.apiKey)
  const [nameTouched, setNameTouched] = useState(false)

  const save = (patch: Partial<Omit<Profile, "id">>) => void updateProfile(profile.id, patch)

  const open = (next: BotTab) => navigate(botTabPath(profile.id, next))

  // A URL into a tab this bot doesn't have: General takes its place, in the history entry it was
  // asked for, rather than the address reading MCP over a screen that isn't. Only an answer of "no"
  // sends anyone anywhere — a Host still reading keeps the address and draws General meanwhile.
  useEffect(() => {
    if (tab === "mcps" && answers.list === "no")
      void navigate(`/settings/bots/${profile.id}`, { replace: true })
  }, [tab, answers.list, navigate, profile.id])

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
    if (shown !== "models") return
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

  return (
    <Tabs
      value={shown}
      onValueChange={(next) => {
        const tab = botTabOf(next)
        if (tab) open(tab)
      }}
      className="gap-4"
      data-bot-tabs
    >
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="models">Models</TabsTrigger>
        {mcpServers && <TabsTrigger value="mcps">MCP</TabsTrigger>}
      </TabsList>

      <TabsContent value="general">
        <FieldGroup>
          {!profile.disabled && pluginOutdated(profile.pluginVersion) && (
            <Banner tone="warning">
              {profile.name}'s Gots plugin is out of date! Update it to {MIN_PLUGIN_VERSION} or
              newer.
            </Banner>
          )}
          {linked && <EnabledSetting profile={profile} />}
          <MutedSetting profile={profile} />

          <Field>
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

          <Field>
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

          {!linked && (
            <>
              <Field>
                <FieldLabel htmlFor="base-url">API base URL</FieldLabel>
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

              <Field>
                <FieldLabel htmlFor="api-key">API key</FieldLabel>
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

          <div className="flex flex-wrap items-center gap-3">
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
            <p className="text-sm text-destructive" role="alert">
              {connection.message}
            </p>
          )}
        </FieldGroup>
      </TabsContent>

      <TabsContent value="models">
        <FieldGroup>
          {models.length > 1 && (
            <Field>
              <FieldLabel htmlFor="model">Model</FieldLabel>
              <Select
                value={profile.model}
                onValueChange={(value) => value && save({ model: value })}
              >
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
          <DelegationModelSetting profile={profile} />
          <TriageModelSetting profile={profile} />
          <FallbackModelsSetting profile={profile} />
        </FieldGroup>
      </TabsContent>

      {mcpServers && (
        <TabsContent value="mcps">
          <McpsTab profile={profile} />
        </TabsContent>
      )}
    </Tabs>
  )
}
