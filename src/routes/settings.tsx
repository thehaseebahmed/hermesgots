import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTheme } from "next-themes"
import {
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  PlugZapIcon,
  SunIcon,
} from "lucide-react"
import { toast } from "sonner"

import { useOpenDrawer } from "@/components/drawer-context"
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
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { DEFAULT_SETTINGS, clearAllData, db, saveSettings, type Settings } from "@/lib/db"
import { checkHealth, listModels } from "@/lib/hermes"

type Connection =
  { state: "idle" } | { state: "testing" } | { state: "ok" } | { state: "error"; message: string }

function SetupSnippet() {
  const [copied, setCopied] = useState(false)
  const snippet = [
    "API_SERVER_ENABLED=true",
    "API_SERVER_KEY=<openssl rand -hex 32>",
    `API_SERVER_CORS_ORIGINS=${window.location.origin}`,
  ].join("\n")

  return (
    <div className="relative rounded-2xl bg-muted">
      <pre className="overflow-x-auto px-4 py-3 pr-12 font-mono text-xs leading-relaxed">
        {snippet}
      </pre>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-1.5 right-1.5"
        aria-label="Copy"
        onClick={async () => {
          await navigator.clipboard?.writeText(snippet).catch(() => {})
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  )
}

export function SettingsPage() {
  const stored = useLiveQuery(async () => (await db.settings.get("settings")) ?? null, [])
  if (stored === undefined) return null
  return <SettingsForm stored={stored} />
}

function SettingsForm({ stored }: { stored: Settings | null }) {
  const openDrawer = useOpenDrawer()
  const settings = { ...DEFAULT_SETTINGS, ...stored }
  const { theme, setTheme } = useTheme()
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [connection, setConnection] = useState<Connection>({ state: "idle" })

  // Local drafts so typing isn't fighting the live query; persisted on every change.
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [apiKey, setApiKey] = useState(settings.apiKey)

  const test = async () => {
    setConnection({ state: "testing" })
    const config = { baseUrl, apiKey }
    try {
      await checkHealth(config)
      const ids = await listModels(config)
      setModels(ids)
      if (ids.length && !ids.includes(settings.model)) await saveSettings({ model: ids[0] })
      setConnection({ state: "ok" })
    } catch (error) {
      setConnection({
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const modelOptions = Array.from(new Set([settings.model, ...models])).filter(Boolean)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full md:hidden"
            onClick={openDrawer}
            aria-label="Open conversations"
          >
            <MenuIcon />
          </Button>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <Card className="rounded-3xl">
          <CardHeader>
            <CardTitle>Hermes connection</CardTitle>
            <CardDescription>
              Memento talks to your Hermes Agent's OpenAI-compatible API server.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
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
                    void saveSettings({ baseUrl: e.target.value.trim() })
                  }}
                />
                <FieldDescription>
                  Hermes listens on port 8642 by default. From this HTTPS site, anything other than
                  localhost must be served over HTTPS.
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
                      void saveSettings({ apiKey: e.target.value.trim() })
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
                  Stored only in this browser. Required for Hermes to keep one session per chat.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="model">Model</FieldLabel>
                <Select
                  value={settings.model}
                  onValueChange={(value) => value && saveSettings({ model: value })}
                >
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
              </div>
              {connection.state === "error" && (
                <p className="text-sm text-destructive" role="alert">
                  {connection.message}
                </p>
              )}
            </FieldGroup>
          </CardContent>
        </Card>

        <Card className="rounded-3xl">
          <CardHeader>
            <CardTitle>Hermes setup</CardTitle>
            <CardDescription>
              Add these to <code className="font-mono">~/.hermes/.env</code> and restart the gateway
              so this site is allowed to connect.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SetupSnippet />
          </CardContent>
        </Card>

        <Card className="rounded-3xl">
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel>Theme</FieldLabel>
                <ToggleGroup
                  variant="outline"
                  value={[theme ?? "system"]}
                  onValueChange={(value) => value[0] && setTheme(value[0])}
                >
                  <ToggleGroupItem value="system" aria-label="System">
                    <MonitorIcon /> System
                  </ToggleGroupItem>
                  <ToggleGroupItem value="light" aria-label="Light">
                    <SunIcon /> Light
                  </ToggleGroupItem>
                  <ToggleGroupItem value="dark" aria-label="Dark">
                    <MoonIcon /> Dark
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
              <Field orientation="horizontal">
                <div className="flex-1 space-y-1">
                  <FieldLabel htmlFor="show-stats">Show reply stats</FieldLabel>
                  <FieldDescription>
                    Estimated tokens, speed and time under each reply.
                  </FieldDescription>
                </div>
                <Switch
                  id="show-stats"
                  checked={settings.showStats}
                  onCheckedChange={(checked) => saveSettings({ showStats: checked })}
                />
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        <Card className="rounded-3xl">
          <CardHeader>
            <CardTitle>Data</CardTitle>
            <CardDescription>
              Chats and settings are cached on this device in IndexedDB.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="destructive" />}>
                Clear local data
              </AlertDialogTrigger>
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear everything?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Deletes all chats and settings stored in this browser. Sessions on your Hermes
                    server are untouched.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={async () => {
                      await clearAllData()
                      setBaseUrl(DEFAULT_SETTINGS.baseUrl)
                      setApiKey("")
                      toast.success("Local data cleared")
                    }}
                  >
                    Clear
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
