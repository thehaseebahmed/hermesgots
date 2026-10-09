import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useSearchParams } from "react-router"
import { EyeIcon, EyeOffIcon, PlugZapIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { BotCard } from "@/components/bot-card"
import { BOTS } from "@/components/bots"
import { DefaultModelSetting } from "@/components/chat/model-picker"
import { LinkSheet } from "@/components/link-bots"
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
import { Card, CardContent } from "@/components/ui/card"
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
import {
  db,
  deleteProfile,
  getActiveProfile,
  getSettings,
  listProfiles,
  saveSettings,
  setActiveProfile,
  updateProfile,
  type Profile,
} from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { checkHealth, getPluginVersion, listModels } from "@/lib/hermes"
import { setDefaultModel } from "@/lib/model-info"
import { syncContextWindow } from "@/lib/models"
import { isOnline, removeHost, setBotEnabled } from "@/lib/registry"
import { useSyncState } from "@/lib/sync"
import { cn } from "@/lib/utils"
import { MIN_PLUGIN_VERSION, pluginOutdated } from "@/lib/version"

type Connection =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; plugin: string | null }
  | { state: "error"; message: string }

/** Hermes's default model id; any other advertised id is the profile's name. */
const UNNAMED_MODEL = "hermes-agent"

/** A bot added by hand before linking, as opposed to the untouched seed of a fresh install. */
function handAdded(profile: Profile) {
  return !profile.hostId && (Boolean(profile.apiKey) || profile.updatedAt !== profile.createdAt)
}

/** Bots are Hermes profiles, linked from their hosts. Tap one to edit it. */
export function BotSettings() {
  const profiles = useLiveQuery(listProfiles, [])
  const active = useLiveQuery(getActiveProfile, [])
  const settings = useLiveQuery(getSettings, [])
  const [editingId, setEditingId] = useState<string>()
  const [params, setParams] = useSearchParams()
  const editing = profiles?.find((p) => p.id === editingId) ?? active
  const { chatStores, registryError } = useSyncState()
  const now = useNow()
  const linking = params.get("link") === "1"
  const setLinking = (open: boolean) =>
    setParams(open ? { link: "1" } : {}, { replace: true, state: { quiet: true } })
  const unlinked = settings && !settings.linkNoticeSeen && profiles?.some(handAdded)

  return (
    <Card className="rounded-3xl">
      <CardContent className="flex flex-col gap-6">
        {registryError && <Banner tone="error">Couldn't refresh bots. {registryError}</Banner>}
        {unlinked && (
          <Banner
            action={
              <Button
                variant="ghost"
                size="icon-lg"
                className="size-11"
                aria-label="Dismiss"
                onClick={() => void saveSettings({ linkNoticeSeen: true })}
              >
                <XIcon />
              </Button>
            }
          >
            Bots added by hand can't be added any more.{" "}
            <button type="button" className="underline" onClick={() => setLinking(true)}>
              Link them
            </button>{" "}
            to keep them up to date.
          </Banner>
        )}
        <div className="-mx-6 flex [scrollbar-width:none] gap-2 overflow-x-auto px-6 py-1 [&::-webkit-scrollbar]:hidden">
          {profiles?.map((profile) => (
            <BotCard
              key={profile.id}
              botId={profile.botId}
              name={profile.name}
              selected={profile.id === editing?.id}
              dimmed={profile.disabled}
              online={profile.hostId && !profile.disabled ? isOnline(profile, now) : undefined}
              warning={
                profile.disabled
                  ? undefined
                  : !profile.hostId && handAdded(profile)
                    ? "Not linked"
                    : chatStores[profile.id] === "unreachable"
                      ? "Can't reach its Memento plugin"
                      : pluginOutdated(profile.pluginVersion)
                        ? "Plugin out of date"
                        : undefined
              }
              onClick={() => setEditingId(profile.id)}
            />
          ))}
          <BotCard
            name="Link a bot"
            icon={<PlusIcon className="size-5" />}
            className="border border-dashed border-foreground/25 bg-transparent ring-0"
            onClick={() => setLinking(true)}
          />
        </div>
        {editing && (
          <BotEditor
            key={editing.id}
            profile={editing}
            canDelete={(profiles?.length ?? 0) > 1}
            onDeleted={() => setEditingId(undefined)}
          />
        )}
      </CardContent>
      <LinkSheet open={linking} onOpenChange={setLinking} />
    </Card>
  )
}

/** The time now, ticking each minute, for "last seen" and online dots. */
function useNow() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return now
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
    <Field orientation="horizontal">
      <div className="flex-1 space-y-1">
        <FieldLabel htmlFor="enabled">Enabled</FieldLabel>
        <FieldDescription>{profile.disabled ? "Hidden in Memento" : seen}</FieldDescription>
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
 * A bot's settings. A linked bot's address and key come from its host; a bot added by hand before
 * linking keeps its own.
 */
export function BotEditor({
  profile,
  canDelete = false,
  onDeleted,
}: {
  profile: Profile
  canDelete?: boolean
  onDeleted?: () => void
}) {
  const linked = Boolean(profile.hostId)
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [connection, setConnection] = useState<Connection>({ state: "idle" })

  // Local drafts so typing isn't fighting the live query; persisted on every change.
  const [name, setName] = useState(profile.name)
  const [baseUrl, setBaseUrl] = useState(profile.baseUrl)
  const [apiKey, setApiKey] = useState(profile.apiKey)
  const [nameTouched, setNameTouched] = useState(false)

  const save = (patch: Partial<Omit<Profile, "id">>) => void updateProfile(profile.id, patch)

  const test = async () => {
    setConnection({ state: "testing" })
    const config = linked ? profile : { baseUrl, apiKey }
    try {
      await checkHealth(config)
      const ids = await listModels(config)
      setModels(ids)
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
    <FieldGroup>
      {!profile.disabled && pluginOutdated(profile.pluginVersion) && (
        <Banner tone="warning">
          Its Memento plugin is {profile.pluginVersion}, and Memento needs {MIN_PLUGIN_VERSION} or
          newer.
        </Banner>
      )}
      {linked && <EnabledSetting profile={profile} />}

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

      {linked ? (
        <Field>
          <FieldLabel htmlFor="base-url">Address</FieldLabel>
          <Input id="base-url" readOnly value={profile.baseUrl.replace(/\/v1\/?$/, "")} />
        </Field>
      ) : (
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
                  Its chats are removed too. The profile and its sessions on your Hermes server are
                  untouched.
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
  )
}
