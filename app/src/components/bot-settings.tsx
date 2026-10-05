import { useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  EyeIcon,
  EyeOffIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"

import { Bot } from "@/components/bot"
import { BotCard } from "@/components/bot-card"
import { BOTS } from "@/components/bots"
import { CopyBlock } from "@/components/copy-block"
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
  addProfile,
  db,
  deleteProfile,
  getActiveProfile,
  listProfiles,
  setActiveProfile,
  updateProfile,
  type Profile,
} from "@/lib/db"
import { checkHealth, INSTALL_PLUGIN, listModels } from "@/lib/hermes"
import { syncContextWindow } from "@/lib/models"
import { recheckChatStores, stopUsingPlugin, useSyncState } from "@/lib/sync"
import { cn } from "@/lib/utils"

type Connection =
  { state: "idle" } | { state: "testing" } | { state: "ok" } | { state: "error"; message: string }

/** Hermes's default model id; any other advertised id is the profile's name. */
const UNNAMED_MODEL = "hermes-agent"

/** Bots are Hermes profiles. Hermes can't list them, so each one is added here by hand. */
export function BotSettings() {
  const profiles = useLiveQuery(listProfiles, [])
  const active = useLiveQuery(getActiveProfile, [])
  const [editingId, setEditingId] = useState<string>()
  const editing = profiles?.find((p) => p.id === editingId) ?? active
  const { chatStores } = useSyncState()
  const section = useRef<HTMLDivElement>(null)

  // The sidebar's "Add bot" card links to #bots.
  useEffect(() => {
    if (window.location.hash === "#bots") section.current?.scrollIntoView({ block: "start" })
  }, [])

  return (
    <Card ref={section} id="bots" className="scroll-mt-20 rounded-3xl">
      <CardHeader>
        <CardTitle>Bots</CardTitle>
        <CardDescription>
          Each bot is a Hermes profile with its own API server and key. Tap one to edit it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="-mx-6 flex [scrollbar-width:none] gap-2 overflow-x-auto px-6 py-1 [&::-webkit-scrollbar]:hidden">
          {profiles?.map((profile) => (
            <BotCard
              key={profile.id}
              botId={profile.botId}
              name={profile.name}
              selected={profile.id === editing?.id}
              warning={
                chatStores[profile.id] === "fallback"
                  ? "Chats aren't saved on its Hermes server"
                  : chatStores[profile.id] === "unreachable"
                    ? "Can't reach its Memento plugin"
                    : undefined
              }
              onClick={() => setEditingId(profile.id)}
            />
          ))}
          <BotCard
            name="Add bot"
            icon={<PlusIcon className="size-5" />}
            className="border border-dashed border-foreground/25 bg-transparent ring-0"
            onClick={async () => {
              const profile = await addProfile({ name: "New bot" })
              setEditingId(profile.id)
            }}
          />
        </div>
        {editing && <ChatStoreSettings profile={editing} />}
        {editing && (
          <BotEditor
            key={editing.id}
            profile={editing}
            canDelete={(profiles?.length ?? 0) > 1}
            onDeleted={() => setEditingId(undefined)}
          />
        )}
      </CardContent>
    </Card>
  )
}

/** Whether the bot's chats are on its server's Memento plugin, and a warning when they aren't. */
function ChatStoreSettings({ profile }: { profile: Profile }) {
  const sync = useSyncState()
  const [checking, setChecking] = useState(false)
  const store = sync.chatStores[profile.id]
  if (profile.pluginChats) {
    return (
      <FieldGroup>
        {store === "unreachable" && (
          <Alert>
            <TriangleAlertIcon />
            <AlertTitle>Can't reach the Memento plugin</AlertTitle>
            <AlertDescription>
              This bot's chats sync again once its server answers. If you removed the plugin, turn
              it off below.
            </AlertDescription>
          </Alert>
        )}
        <Field orientation="horizontal">
          <div className="flex-1 space-y-1">
            <FieldLabel htmlFor="plugin-chats">Memento plugin</FieldLabel>
            <FieldDescription>This bot's chats are saved on its Hermes server.</FieldDescription>
          </div>
          <Switch
            id="plugin-chats"
            checked
            onCheckedChange={(checked) => {
              if (!checked) void stopUsingPlugin(profile.id)
            }}
          />
        </Field>
      </FieldGroup>
    )
  }
  if (store !== "fallback") return null
  return (
    <Alert>
      <TriangleAlertIcon />
      <AlertTitle>Chats aren't saved on this Hermes server</AlertTitle>
      <AlertDescription className="flex flex-col gap-3 [&_p:not(:last-child)]:mb-0">
        <p>
          Install the Memento plugin to keep this bot's chats there. Until then,{" "}
          {sync.vault === "unlocked"
            ? "they sync through your Memento account."
            : "they're only on this device."}
        </p>
        <CopyBlock label="Copy install commands" text={INSTALL_PLUGIN} />
        <Button
          variant="outline"
          size="lg"
          className="h-11 w-fit"
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            await recheckChatStores().finally(() => setChecking(false))
          }}
        >
          <RefreshCwIcon data-icon="inline-start" />
          {checking ? "Checking…" : "Check again"}
        </Button>
      </AlertDescription>
    </Alert>
  )
}

/**
 * `setup` trims it to the connection fields for first-run setup. `onConnectionChange` reports
 * whether the current URL and key passed Test connection.
 */
export function BotEditor({
  profile,
  canDelete = false,
  onDeleted,
  setup = false,
  onConnectionChange,
}: {
  profile: Profile
  canDelete?: boolean
  onDeleted?: () => void
  setup?: boolean
  onConnectionChange?: (ok: boolean) => void
}) {
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [connection, setConnection] = useState<Connection>({ state: "idle" })

  useEffect(() => onConnectionChange?.(connection.state === "ok"), [connection, onConnectionChange])

  // Local drafts so typing isn't fighting the live query; persisted on every change.
  const [name, setName] = useState(profile.name)
  const [baseUrl, setBaseUrl] = useState(profile.baseUrl)
  const [apiKey, setApiKey] = useState(profile.apiKey)
  const [contextWindow, setContextWindow] = useState(profile.contextWindow?.toString() ?? "")
  const [nameTouched, setNameTouched] = useState(false)

  const save = (patch: Partial<Omit<Profile, "id">>) => void updateProfile(profile.id, patch)

  const test = async () => {
    setConnection({ state: "testing" })
    const config = { baseUrl, apiKey }
    try {
      await checkHealth(config)
      const ids = await listModels(config)
      setModels(ids)
      if (ids.length && !ids.includes(profile.model)) save({ model: ids[0] })
      // A named profile advertises its name as the model id.
      const advertised = ids.find((id) => id !== UNNAMED_MODEL)
      if (advertised && !nameTouched) {
        setName(advertised)
        save({ name: advertised })
      }
      setConnection({ state: "ok" })
      const saved = await db.profiles.get(profile.id)
      if (saved) await syncContextWindow(saved)
      const synced = await db.profiles.get(profile.id)
      setContextWindow(synced?.contextWindow?.toString() ?? "")
    } catch (error) {
      setConnection({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <FieldGroup>
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

      {!setup && (
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
      )}

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
        <FieldDescription>
          Hermes listens on port 8642 by default. A gateway serving several profiles puts the others
          under <code className="font-mono">/p/&lt;profile&gt;/v1</code>. From this HTTPS site,
          anything other than localhost must be served over HTTPS.
        </FieldDescription>
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
        <FieldDescription>
          The profile's own key. Required for Hermes to keep one session per chat.
        </FieldDescription>
      </Field>

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

      {!setup && (
        <Field>
          <FieldLabel htmlFor="context-window">Context window</FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="context-window"
              inputMode="numeric"
              autoComplete="off"
              placeholder="200000"
              value={contextWindow}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, "")
                setContextWindow(digits)
                save({ contextWindow: Number(digits) || undefined, contextSource: "manual" })
              }}
            />
            <InputGroupAddon align="inline-end">tokens</InputGroupAddon>
          </InputGroup>
          <FieldDescription>
            <ContextWindowHint profile={profile} />
          </FieldDescription>
        </Field>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={test} disabled={connection.state === "testing"}>
          <PlugZapIcon data-icon="inline-start" />
          {connection.state === "testing" ? "Testing…" : "Test connection"}
        </Button>
        {connection.state === "ok" && (
          <Badge className="bg-primary/15 text-primary dark:bg-primary/30 dark:text-sidebar-primary">
            Connected
          </Badge>
        )}
        {!setup && (
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

function ContextWindowHint({ profile }: { profile: Profile }) {
  const model = profile.contextModel && (
    <code className="font-mono break-all">{profile.contextModel}</code>
  )
  if (!model) {
    return (
      <>
        The model's context size, to see how full a chat is. Test the connection to look it up on
        models.dev.
      </>
    )
  }
  if (profile.contextSource === "models.dev" && profile.contextWindow) {
    return <>Found on models.dev for {model}. It resets when the bot's model changes.</>
  }
  if (profile.contextSource === "manual" && profile.contextWindow) {
    return <>Set by hand for {model}. It resets when the bot's model changes.</>
  }
  return <>{model} isn't on models.dev, so set its context size by hand.</>
}
