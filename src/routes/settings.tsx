import { useLiveQuery } from "dexie-react-hooks"
import { useTheme } from "next-themes"
import { MenuIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { toast } from "sonner"

import { BotSettings } from "@/components/bot-settings"
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
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { DEFAULT_SETTINGS, clearAllData, db, saveSettings, type Settings } from "@/lib/db"

export function SettingsPage() {
  const stored = useLiveQuery(async () => (await db.settings.get("settings")) ?? null, [])
  if (stored === undefined) return null
  return <SettingsForm stored={stored} />
}

function SettingsForm({ stored }: { stored: Settings | null }) {
  const openDrawer = useOpenDrawer()
  const settings = { ...DEFAULT_SETTINGS, ...stored }
  const { theme, setTheme } = useTheme()

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
        <BotSettings />

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
              Bots, chats and settings are cached on this device in IndexedDB.
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
                    Deletes all bots, chats and settings stored in this browser. Sessions on your
                    Hermes server are untouched.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={async () => {
                      await clearAllData()
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

        <p className="text-center text-xs text-muted-foreground">
          Memento v{__APP_VERSION__}
          <br />
          Built {new Date(__BUILD_TIME__).toLocaleString()}
        </p>
      </div>
    </div>
  )
}
