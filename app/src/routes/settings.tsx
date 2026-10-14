import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTheme } from "next-themes"
import { Link, Navigate, useParams, useSearchParams } from "react-router"
import {
  ArrowLeftIcon,
  BellIcon,
  BellRingIcon,
  BookOpenCheckIcon,
  CalendarXIcon,
  CheckIcon,
  ClipboardCheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CodeXmlIcon,
  FolderXIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  MessageCircleQuestionIcon,
  SlidersHorizontalIcon,
  TerminalIcon,
  ChevronRightIcon,
  CornerDownRightIcon,
  DatabaseIcon,
  MenuIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  MessageSquareTextIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  PlusIcon,
  SailboatIcon,
  SunIcon,
  TelescopeIcon,
  TimerIcon,
  UserIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { AccountSettings } from "@/components/account-settings"
import { BotEditor } from "@/components/bot-settings"
import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { LinkSheet } from "@/components/link-bots"
import { useOpenDrawer } from "@/components/drawer-context"
import { ExperimentalBadge } from "@/components/experimental-badge"
import { FeedbackSheet } from "@/components/feedback"
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
import {
  disablePush,
  enablePush,
  pushAvailable,
  sendTestPush,
  setPushCategory,
  setPushFeature,
  usePush,
  usePushFeatures,
} from "@/lib/push"
import type { PushCategory, PushFeature } from "@/lib/push-kinds"
import { isOnline } from "@/lib/registry"
import { forgetLocalKey, useSyncState } from "@/lib/sync"
import { useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { APP_VERSION } from "@/lib/version"

const THEMES = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
]

const SECTIONS: Record<string, { title: string; render: () => ReactNode }> = {
  account: { title: "Account", render: () => <AccountSettings /> },
  appearance: { title: "Appearance", render: () => <AppearanceSettings /> },
  notifications: { title: "Notification types", render: () => <NotificationTypes /> },
  data: { title: "Local data", render: () => <DataSettings /> },
  developer: { title: "Developer", render: () => <DeveloperSettings /> },
}

/** A bot added by hand before linking, as opposed to the untouched seed of a fresh install. */
function handAdded(profile: Profile) {
  return !profile.hostId && (Boolean(profile.apiKey) || profile.updatedAt !== profile.createdAt)
}

/** Which section the menu shows as open, and whether picking one swaps it in place. */
const MenuContext = createContext<{ active?: string; replace: boolean }>({ replace: false })

/**
 * Settings: a menu whose rows each open a section, with the bots listed on it. Up to tablet width
 * the menu and a section are separate screens; wider, they sit side by side, with the first section
 * open by default.
 */
export function SettingsPage() {
  const { section, botId } = useParams()
  const large = useLarge()
  const { up, root } = useNav()
  const { account } = useSyncState()
  // The bots live on the menu itself now, so /settings/bots without a bot is the menu.
  const screen = section === "bots" && !botId ? undefined : section
  const separate = !large && Boolean(screen)
  const botName = useBotName(botId)
  // On its own screen, a section sits under the Settings menu.
  useEffect(() => {
    if (!separate) return
    return setBackGuard(() => {
      up("/settings")
      return true
    })
  }, [separate, up])

  if (section && section !== "bots" && !SECTIONS[section])
    return <Navigate to="/settings" replace />
  if (!large) return screen ? <SectionScreen section={screen} botName={botName} /> : <MenuScreen />

  const open =
    screen ??
    (account.status === "signed-in" || account.status === "signed-out" ? "account" : "appearance")
  return (
    <div className="flex min-h-0 flex-1">
      <MenuContext.Provider value={{ active: open, replace: true }}>
        <MenuScreen className="w-90 flex-none border-r min-[1200px]:w-103" />
      </MenuContext.Provider>
      <Screen
        key={open}
        title={open === "bots" ? (botName ?? "Bot") : SECTIONS[open].title}
        className="duration-200 ease-out motion-safe:animate-in motion-safe:fade-in-0"
      >
        {open === "bots" ? (
          <BotSection botId={botId!} onDeleted={() => root("/settings")} />
        ) : (
          SECTIONS[open].render()
        )}
      </Screen>
    </div>
  )
}

/** The name of the bot whose settings are open, for the screen's title. */
function useBotName(botId: string | undefined) {
  const profiles = useLiveQuery(listProfiles, [])
  return botId ? profiles?.find((p) => p.id === botId)?.name : undefined
}

/** One bot's settings, as a section screen's content or the side pane's. */
function BotSection({ botId, onDeleted }: { botId: string; onDeleted: () => void }) {
  const profiles = useLiveQuery(listProfiles, [])
  const bot = profiles?.find((p) => p.id === botId)
  if (profiles === undefined) return null
  if (!bot) return <Navigate to="/settings" replace />
  return (
    <BotEditor
      key={bot.id}
      profile={bot}
      canDelete={profiles.length > 1}
      onDeleted={onDeleted}
    />
  )
}

function MenuScreen({ className }: { className?: string }) {
  const openDrawer = useOpenDrawer()
  const settings = useLiveQuery(
    async () => ({ ...DEFAULT_SETTINGS, ...(await db.settings.get("settings")) }),
    [],
  )
  const profiles = useLiveQuery(listProfiles, [])
  const now = useNow()
  const { registryError } = useSyncState()
  const { theme } = useTheme()
  const [params, setParams] = useSearchParams()
  const linking = params.get("link") === "1"
  const setLinking = (open: boolean) =>
    setParams(open ? { link: "1" } : {}, { replace: true, state: { quiet: true } })
  const unlinked = settings && !settings.linkNoticeSeen && profiles?.some(handAdded)

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
      <Group>
        {profiles?.map((profile) => (
          <BotRow key={profile.id} profile={profile} now={now} />
        ))}
        <AddBotRow onAdd={() => setLinking(true)} />
      </Group>
      <Group>
        <Row
          to="appearance"
          icon={PaletteIcon}
          title="Appearance"
          subtitle={THEMES.find((t) => t.value === (theme ?? "system"))?.label}
        />
        <NotificationsRow />
        <NotificationTypesRow />
      </Group>
      <Group>
        <FeedbackRow />
      </Group>
      <Group>
        <Row to="data" icon={DatabaseIcon} title="Local data" />
        {settings?.developer && <Row to="developer" icon={TerminalIcon} title="Developer" />}
      </Group>
      <VersionLabel developer={Boolean(settings?.developer)} />
      <LinkSheet open={linking} onOpenChange={setLinking} />
    </Screen>
  )
}

/** A bot in the menu: its connectivity dot, then the bot itself, then its name. */
function BotRow({ profile, now }: { profile: Profile; now: number }) {
  const online = profile.hostId && !profile.disabled ? isOnline(profile, now) : undefined
  const { replace } = useContext(MenuContext)
  return (
    <Link
      to={`/settings/bots/${profile.id}`}
      replace={replace}
      className={cn(rowClass, "transition-colors hover:bg-muted")}
    >
      <span className="flex size-3 shrink-0 items-center justify-center">
        {online !== undefined && (
          <>
            <span
              aria-hidden
              className={cn(
                "size-2.5 rounded-full",
                online ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
            <span className="sr-only">{online ? "Online" : "Offline"}</span>
          </>
        )}
      </span>
      <Bot id={profile.botId} className={cn("size-8 shrink-0", profile.disabled && "opacity-40")} />
      <RowText title={profile.name} />
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  )
}

/** The row that opens the link sheet, at the end of the bots. */
function AddBotRow({ onAdd }: { onAdd: () => void }) {
  return (
    <button
      type="button"
      onClick={onAdd}
      className={cn(rowClass, "transition-colors hover:bg-muted")}
    >
      <PlusIcon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title="Add bot" />
    </button>
  )
}

function NotificationsRow() {
  const { permission, on } = usePush()
  const [busy, setBusy] = useState(false)
  if (!pushAvailable()) return null
  const toggle = async (checked: boolean) => {
    setBusy(true)
    try {
      if (!checked) return await disablePush()
      if ((await enablePush()) === "denied")
        toast.error(
          isNative
            ? "Notifications are blocked in system settings"
            : "Notifications are blocked in your browser",
        )
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? `Couldn't turn on notifications. ${error.message}`
          : "Couldn't turn on notifications",
      )
    } finally {
      setBusy(false)
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
      disabled={busy}
      onCheckedChange={toggle}
    />
  )
}

function NotificationTypesRow() {
  const { on } = usePush()
  if (!pushAvailable() || !on) return null
  return <Row to="notifications" icon={SlidersHorizontalIcon} title="Notification types" />
}

const CATEGORY_ICONS: Record<PushCategory, LucideIcon> = {
  chat_input: MessageCircleQuestionIcon,
  chat_run_failed: CircleAlertIcon,
  chat_run_done: CircleCheckIcon,
  code_input: MessageCircleQuestionIcon,
  code_theseus: SailboatIcon,
  code_run_failed: CircleAlertIcon,
  code_run_done: CircleCheckIcon,
  code_pr_checks: GitPullRequestIcon,
  code_pr_merged: GitMergeIcon,
  code_setup_failed: FolderXIcon,
  routine_failed: CalendarXIcon,
  research_input: ClipboardCheckIcon,
  research_done: BookOpenCheckIcon,
  research_failed: CircleAlertIcon,
}

const FEATURE_ICONS: Record<PushFeature, LucideIcon> = {
  chats: MessagesSquareIcon,
  code: CodeXmlIcon,
  routines: TimerIcon,
  research: TelescopeIcon,
}

/**
 * Which pushes this device gets, by feature: a switch for the whole feature and one for each kind
 * in it. Each kind is a channel of its own in Android's settings too.
 */
function NotificationTypes() {
  const features = usePushFeatures()
  const failed = (error: unknown) =>
    toast.error(
      error instanceof Error && error.message
        ? `Couldn't change that. ${error.message}`
        : "Couldn't change that",
    )
  return (
    <div className="flex flex-col gap-4">
      {features.map((feature) => {
        const [only] = feature.categories
        const single = feature.categories.length === 1
        return (
          <Group key={feature.id}>
            <SwitchRow
              id={`push-${feature.id}`}
              variant="header"
              icon={FEATURE_ICONS[feature.id]}
              title={feature.title}
              subtitle={single ? only.title : `${feature.on} of ${feature.categories.length} on`}
              checked={feature.on > 0}
              onCheckedChange={(checked) => void setPushFeature(feature.id, checked).catch(failed)}
            />
            {!single &&
              feature.categories.map((category) => (
                <SwitchRow
                  key={category.id}
                  id={`push-${category.id}`}
                  variant="nested"
                  icon={CATEGORY_ICONS[category.id]}
                  title={category.title}
                  checked={category.checked}
                  onCheckedChange={(checked) =>
                    void setPushCategory(category.id, checked).catch(failed)
                  }
                />
              ))}
          </Group>
        )
      })}
    </div>
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
      Memento v{APP_VERSION}
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
        <SwitchRow
          id="bot-threads"
          icon={MessagesSquareIcon}
          title={
            <span className="flex items-center gap-2">
              Bot threads
              <ExperimentalBadge />
            </span>
          }
          subtitle="Bots in the sidebar, chats as threads"
          checked={Boolean(settings?.botThreads)}
          onCheckedChange={(checked) => saveSettings({ botThreads: checked })}
        />
      </Group>
      {isNative && pushAvailable() && <TestPushRow />}
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

function TestPushRow() {
  const { on } = usePush()
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setBusy(true)
    try {
      await sendTestPush()
      toast("Test notification sent")
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? `Couldn't send. ${error.message}`
          : "Couldn't send the test notification",
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Group>
      <button type="button" className={rowClass} disabled={!on || busy} onClick={send}>
        <BellRingIcon className="size-5 shrink-0 text-muted-foreground" />
        <RowText
          title="Send test notification"
          subtitle={on ? undefined : "Turn on Notifications"}
        />
      </button>
    </Group>
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

function SectionScreen({ section, botName }: { section: string; botName?: string }) {
  const { botId } = useParams()
  const { up, root } = useNav()
  const page = SECTIONS[section]
  return (
    <Screen
      title={page ? page.title : (botName ?? "Bot")}
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
      {page ? (
        page.render()
      ) : (
        botId && <BotSection botId={botId} onDeleted={() => root("/settings")} />
      )}
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
  disabled,
  variant,
  onCheckedChange,
}: {
  id: string
  icon: LucideIcon
  title: ReactNode
  subtitle?: string
  checked: boolean
  disabled?: boolean
  /** `header` tops a group of switches it controls; `nested` is one of them. */
  variant?: "header" | "nested"
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        rowClass,
        "cursor-pointer",
        variant === "header" && "bg-muted py-4",
        variant === "nested" && "pl-9",
      )}
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-base", variant === "header" && "font-semibold")}>
          {title}
        </span>
        {subtitle && <span className="line-clamp-2 text-sm text-muted-foreground">{subtitle}</span>}
      </span>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </label>
  )
}

function FeedbackRow() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(rowClass, "transition-colors hover:bg-muted")}
      >
        <MessageSquareTextIcon className="size-5 shrink-0 text-muted-foreground" />
        <RowText title="Send feedback" />
      </button>
      <FeedbackSheet open={open} onOpenChange={setOpen} />
    </>
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

function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const current = theme ?? "system"
  const chatSettings = useLiveQuery(
    async () => ({ ...DEFAULT_SETTINGS, ...(await db.settings.get("settings")) }),
    [],
  )
  const simplified = chatSettings?.simplifiedChats
  return (
    <>
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
      <Group>
        <SwitchRow
          id="simplified-chats"
          icon={MessageCircleIcon}
          title="Simplified chats"
          subtitle="Hide tool calls, stats and context use"
          checked={simplified ?? DEFAULT_SETTINGS.simplifiedChats}
          onCheckedChange={(checked) => saveSettings({ simplifiedChats: checked })}
        />
        <SwitchRow
          id="steer-by-default"
          icon={CornerDownRightIcon}
          title="Steer by default"
          subtitle="Messages sent mid-reply go straight to it"
          checked={chatSettings?.steerByDefault ?? false}
          onCheckedChange={(checked) => saveSettings({ steerByDefault: checked })}
        />
        <SwitchRow
          id="break-reminders"
          icon={TimerIcon}
          title="Take-a-break reminders"
          subtitle="Remind me to put the phone away while a task runs"
          checked={chatSettings?.breakReminders ?? DEFAULT_SETTINGS.breakReminders ?? true}
          onCheckedChange={(checked) => saveSettings({ breakReminders: checked })}
        />
      </Group>
    </>
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
