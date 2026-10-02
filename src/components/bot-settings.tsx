import { useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { EyeIcon, EyeOffIcon, PlugZapIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { Bot } from "@/components/bot"
import { BotCard } from "@/components/bot-card"
import { BOTS } from "@/components/bots"
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
  deleteProfile,
  getActiveProfile,
  listProfiles,
  setActiveProfile,
  updateProfile,
  type Profile,
} from "@/lib/db"
import { checkHealth, listModels } from "@/lib/hermes"
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

function BotEditor({
  profile,
  canDelete,
  onDeleted,
}: {
  profile: Profile
  canDelete: boolean
  onDeleted: () => void
}) {
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
    } catch (error) {
      setConnection({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const modelOptions = Array.from(new Set([profile.model, ...models])).filter(Boolean)

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
          The profile's own key, stored only in this browser. Required for Hermes to keep one
          session per chat.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="model">Model</FieldLabel>
        <Select value={profile.model} onValueChange={(value) => value && save({ model: value })}>
          <SelectTrigger id="model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          Test the connection to load the models Hermes advertises.
        </FieldDescription>
      </Field>

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
                Its chats are removed from this device too. The profile and its sessions on your
                Hermes server are untouched.
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
                  onDeleted()
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {connection.state === "error" && (
        <p className="text-sm text-destructive" role="alert">
          {connection.message}
        </p>
      )}
    </FieldGroup>
  )
}
