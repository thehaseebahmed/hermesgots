import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTheme } from "next-themes"
import { Link, Navigate, useParams } from "react-router"
import {
  ArrowLeftIcon,
  BotIcon,
  BellIcon,
  CheckIcon,
  TerminalIcon,
  ChevronRightIcon,
  DatabaseIcon,
  GaugeIcon,
  MenuIcon,
  MonitorIcon,
  MoonIcon,
  SailboatIcon,
  SunIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { AccountSettings } from "@/components/account-settings"
import { BotSettings } from "@/components/bot-settings"
import { useOpenDrawer } from "@/components/drawer-context"
import { ExperimentalBadge } from "@/components/experimental-badge"
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
import { Switch } from "@/components/ui/switch"
import {
  DEFAULT_SETTINGS,
  clearAllData,
  db,
  getSettings,
  listProfiles,
  saveSettings,
  type Profile,
} from "@/lib/db"
import { useLiveStatus, type LiveStatus } from "@/lib/live"
import { useLarge } from "@/lib/media"
import { isNative, setBackGuard } from "@/lib/native"
import { useNav } from "@/lib/nav"
import { disablePush, enablePush, pushAvailable, usePush } from "@/lib/push"
import { forgetLocalKey, useSyncState } from "@/lib/sync"
import { cn } from "@/lib/utils"

const THEMES = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
]

const SECTIONS: Record<string, { title: string; render: () => ReactNode }> = {
  account: { title: "Account", render: () => <AccountSettings /> },
  bots: { title: "Bots", render: () => <BotSettings /> },
  theme: { title: "Color mode", render: () => <ThemeSettings /> },
  data: { title: "Local data", render: () => <DataSettings /> },
  developer: { title: "Developer", render: () => <DeveloperSettings /> },
}

/** Which section the menu shows as open, and whether picking one swaps it in place. */
const MenuContext = createContext<{ active?: string; replace: boolean }>({ replace: false })

/**
 * Settings: a menu whose rows each open a section. Up to tablet width the menu and a section are
 * separate screens; wider, they sit side by side, with the first section open by default.
 */
export function SettingsPage() {
  const { section } = useParams()
  const large = useLarge()
  const { up } = useNav()
  const { account } = useSyncState()
  const separate = !large && Boolean(section)
  // On its own screen, a section sits under the Settings menu.
  useEffect(() => {
    if (!separate) return
    return setBackGuard(() => {
      up("/settings")
      return true
    })
  }, [separate, up])

  if (section && !SECTIONS[section]) return <Navigate to="/settings" replace />
  if (!large) return section ? <SectionScreen section={section} /> : <MenuScreen />

  const open =
    section ??
    (account.status === "signed-in" || account.status === "signed-out" ? "account" : "bots")
  return (
    <div className="flex min-h-0 flex-1">
      <MenuContext.Provider value={{ active: open, replace: true }}>
        <MenuScreen className="w-90 flex-none border-r min-[1200px]:w-103" />
      </MenuContext.Provider>
      <Screen
        key={open}
        title={SECTIONS[open].title}
        className="duration-200 ease-out motion-safe:animate-in motion-safe:fade-in-0"
      >
        {SECTIONS[open].render()}
      </Screen>
    </div>
  )
}

function MenuScreen({ className }: { className?: string }) {
  const openDrawer = useOpenDrawer()
  const settings = useLiveQuery(
    async () => ({ ...DEFAULT_SETTINGS, ...(await db.settings.get("settings")) }),
    [],
  )
  const bots = useLiveQuery(async () => (await listProfiles()).length, [])
  const { theme } = useTheme()

  return (
    <Screen
      title="Settings"
      className={className}
      leading={
        <Button
          variant="outline"
          size="icon-lg"
          className="size-11 rounded-full md:hidden"
          onClick={openDrawer}
          aria-label="Open conversations"
        >
          <MenuIcon />
        </Button>
      }
    >
      <AccountRow />
      <Group>
        <Row
          to="bots"
          icon={BotIcon}
          title="Bots"
          subtitle={bots === undefined ? undefined : `${bots} ${bots === 1 ? "bot" : "bots"}`}
        />
      </Group>
      <Group>
        <Row
          to="theme"
          icon={MoonIcon}
          title="Color mode"
          subtitle={THEMES.find((t) => t.value === (theme ?? "system"))?.label}
        />
        <SwitchRow
          id="show-stats"
          icon={GaugeIcon}
          title="Reply stats"
          subtitle="Tokens, speed and time under each reply"
          checked={settings?.showStats ?? DEFAULT_SETTINGS.showStats}
          onCheckedChange={(checked) => saveSettings({ showStats: checked })}
        />
        <NotificationsRow />
      </Group>
      <Group>
        <Row to="data" icon={DatabaseIcon} title="Local data" />
        {settings?.developer && <Row to="developer" icon={TerminalIcon} title="Developer" />}
      </Group>
      <VersionLabel developer={Boolean(settings?.developer)} />
    </Screen>
  )
}

function NotificationsRow() {
  const { permission, on } = usePush()
  if (!pushAvailable()) return null
  const toggle = async (checked: boolean) => {
    try {
      if (!checked) return await disablePush()
      if ((await enablePush()) === "denied")
        toast(
          isNative
            ? "Notifications are blocked in system settings"
            : "Notifications are blocked in your browser",
        )
    } catch (error) {
      toast(error instanceof Error ? error.message : "Couldn't turn on notifications")
    }
  }
  return (
    <SwitchRow
      id="notifications"
      icon={BellIcon}
      title="Notifications"
      subtitle={
        permission === "denied"
          ? isNative
            ? "Blocked in system settings"
            : "Blocked in browser settings"
          : "A session needs you"
      }
      checked={on}
      onCheckedChange={toggle}
    />
  )
}

const TAPS_TO_UNLOCK = 5
const TAP_WINDOW_MS = 2000

function VersionLabel({ developer }: { developer: boolean }) {
  const taps = useRef<number[]>([])
  const tap = () => {
    const now = Date.now()
    taps.current = [...taps.current.filter((at) => now - at < TAP_WINDOW_MS), now]
    if (developer || taps.current.length < TAPS_TO_UNLOCK) return
    taps.current = []
    void saveSettings({ developer: true })
    toast("Developer settings on")
  }
  return (
    <button
      type="button"
      onClick={tap}
      className="min-h-11 text-center text-xs text-muted-foreground select-none"
    >
      Memento v{__APP_VERSION__}
      <br />
      Built {new Date(__BUILD_TIME__).toLocaleString()}
    </button>
  )
}

const LIVE_LABELS: Record<LiveStatus, { label: string; detail: string }> = {
  push: { label: "Push", detail: "Stream open" },
  connecting: { label: "Polling", detail: "Stream connecting" },
  unsupported: { label: "Polling", detail: "Plugin has no stream" },
  off: { label: "Polling", detail: "No stream open" },
}

function DeveloperSettings() {
  const bots = useLiveQuery(listProfiles, [])
  const settings = useLiveQuery(getSettings, [])
  return (
    <>
      <Group>
        <SwitchRow
          id="theseus"
          icon={SailboatIcon}
          title={
            <span className="flex items-center gap-2">
              Theseus mode
              <ExperimentalBadge />
            </span>
          }
          subtitle="Very unstable"
          checked={Boolean(settings?.theseus)}
          onCheckedChange={(checked) => saveSettings({ theseus: checked })}
        />
      </Group>
      <Group>
        {bots?.map((bot) => (
          <LiveRow key={bot.id} bot={bot} />
        ))}
      </Group>
      <Button variant="outline" onClick={() => saveSettings({ developer: false })}>
        Hide developer settings
      </Button>
    </>
  )
}

function LiveRow({ bot }: { bot: Profile }) {
  const status = useLiveStatus(bot)
  const { label, detail } = LIVE_LABELS[status]
  return (
    <div className={rowClass}>
      <RowText title={bot.name} subtitle={detail} />
      <span
        className={cn("text-sm", status === "push" ? "text-foreground" : "text-muted-foreground")}
      >
        {label}
      </span>
    </div>
  )
}

function SectionScreen({ section }: { section: string }) {
  const { up } = useNav()
  const page = SECTIONS[section]
  return (
    <Screen
      title={page.title}
      leading={
        <Button
          variant="outline"
          size="icon-lg"
          className="size-11 rounded-full"
          onClick={() => up("/settings")}
          aria-label="Back"
        >
          <ArrowLeftIcon />
        </Button>
      }
    >
      {page.render()}
    </Screen>
  )
}

function Screen({
  title,
  leading,
  className,
  children,
}: {
  title: string
  leading?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", className)}>
      <header className="sticky top-0 z-10 bg-background/80 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="mx-auto flex min-h-11 max-w-2xl items-center gap-3">
          {leading}
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {children}
      </div>
    </div>
  )
}

function Group({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-px overflow-hidden rounded-3xl bg-border ring-1 ring-foreground/10 *:rounded-none">
      {children}
    </div>
  )
}

const rowClass =
  "flex min-h-14 w-full items-center gap-4 bg-card px-5 py-3 text-left text-card-foreground"

function RowText({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-base">{title}</span>
      {subtitle && <span className="line-clamp-2 text-sm text-muted-foreground">{subtitle}</span>}
    </span>
  )
}

function Row({
  to,
  icon: Icon,
  image,
  title,
  subtitle,
}: {
  to: string
  icon: LucideIcon
  image?: string
  title: ReactNode
  subtitle?: ReactNode
}) {
  const { active, replace } = useContext(MenuContext)
  return (
    <Link
      to={`/settings/${to}`}
      replace={replace}
      aria-current={active === to ? "page" : undefined}
      className={cn(rowClass, "transition-colors hover:bg-muted aria-[current=page]:bg-muted")}
    >
      {image ? (
        <img
          src={image}
          alt=""
          className="size-8 shrink-0 rounded-full ring-1 ring-foreground/10"
        />
      ) : (
        <Icon className="size-5 shrink-0 text-muted-foreground" />
      )}
      <RowText title={title} subtitle={subtitle} />
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  )
}

function SwitchRow({
  id,
  icon: Icon,
  title,
  subtitle,
  checked,
  onCheckedChange,
}: {
  id: string
  icon: LucideIcon
  title: ReactNode
  subtitle?: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label htmlFor={id} className={cn(rowClass, "cursor-pointer")}>
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title={title} subtitle={subtitle} />
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  )
}

/** The signed-in account on top, like the Claude app; hidden where there's no sign-in at all. */
function AccountRow() {
  const sync = useSyncState()
  const { account } = sync
  if (account.status === "loading" || account.status === "unavailable") return null
  if (account.status === "signed-out")
    return (
      <Group>
        <Row to="account" icon={UserIcon} title="Account" subtitle="Signed out" />
      </Group>
    )
  const status =
    sync.vault === "locked" ? "Sync locked" : sync.vault === "missing" ? "Sync off" : undefined
  return (
    <Group>
      <Row
        to="account"
        icon={UserIcon}
        image={account.user.pictureUrl}
        title={account.user.name ?? account.user.email}
        subtitle={status ?? (account.user.name ? account.user.email : undefined)}
      />
    </Group>
  )
}

function ThemeSettings() {
  const { theme, setTheme } = useTheme()
  const current = theme ?? "system"
  return (
    <Group>
      {THEMES.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          className={cn(rowClass, "transition-colors hover:bg-muted")}
          aria-pressed={current === value}
          onClick={() => setTheme(value)}
        >
          <Icon className="size-5 shrink-0 text-muted-foreground" />
          <RowText title={label} />
          {current === value && <CheckIcon className="size-5 shrink-0" />}
        </button>
      ))}
    </Group>
  )
}

function DataSettings() {
  const [clearing, setClearing] = useState(false)
  return (
    <Card className="rounded-3xl">
      <CardHeader>
        <CardTitle>Data</CardTitle>
        <CardDescription>
          Bots, chats and settings are cached on this device in IndexedDB.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog open={clearing} onOpenChange={setClearing}>
          <AlertDialogTrigger render={<Button variant="destructive" />}>
            Clear local data
          </AlertDialogTrigger>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Clear everything?</AlertDialogTitle>
              <AlertDialogDescription>
                Deletes all bots, chats and settings stored in this browser. Sessions on your Hermes
                server are untouched.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={async () => {
                  await clearAllData()
                  forgetLocalKey()
                  setClearing(false)
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
  )
}
