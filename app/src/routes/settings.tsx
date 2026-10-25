import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTheme } from "next-themes"
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router"
import {
  ArrowLeftIcon,
  AudioLinesIcon,
  BellIcon,
  BellRingIcon,
  BookOpenCheckIcon,
  CalendarXIcon,
  ClipboardCheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CodeXmlIcon,
  FolderXIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestIcon,
  MessageCircleQuestionIcon,
  SlidersHorizontalIcon,
  TerminalIcon,
  ChevronRightIcon,
  DatabaseIcon,
  MenuIcon,
  MessagesSquareIcon,
  MessageSquareTextIcon,
  PaletteIcon,
  PlusIcon,
  SmartphoneIcon,
  TrophyIcon,
  TelescopeIcon,
  TimerIcon,
  UserIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { AccountSettings } from "@/components/account-settings"
import { CommunitySettings } from "@/components/community-settings"
import { BotSettingsList, BotSettingsPage } from "@/components/bot-settings"
import type { BotSub } from "@/lib/bot-subs"
import { botPageOf, botTabOf, botTabPath, type BotPage } from "@/lib/bot-tabs"
import { botSubOf } from "@/lib/bot-subs"
import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { OnlineDot } from "@/components/bot-card"
import { LinkSheet } from "@/components/link-bots"
import { AppearanceSettings } from "@/components/settings/appearance"
import {
  ActionRow,
  Group,
  RowText,
  SheetRow,
  SwitchRow,
  linkRowClass,
  rowClass,
  Screen,
} from "@/components/settings-chrome"
import { useOpenDrawer } from "@/components/drawer-context"
import { DeviceStateSheet } from "@/components/device-state"
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
import {
  DEFAULT_SETTINGS,
  clearAllData,
  db,
  getSettings,
  listProfiles,
  saveSettings,
  type Profile,
} from "@/lib/db"
import { formatRelative } from "@/lib/format"
import { useLiveStatus, type LiveStatus } from "@/lib/live"
import { useLarge } from "@/lib/media"
import { isNative, openNotificationSettings, setBackGuard } from "@/lib/native"
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
import { isOnline, siteUrl } from "@/lib/registry"
import { themeLabel } from "@/lib/theme"
import { forgetLocalKey, useSyncState } from "@/lib/sync"
import { useNow } from "@/lib/threads"
import { cn } from "@/lib/utils"
import { APP_VERSION, pluginOutdated } from "@/lib/version"

/** What both the notification row and the screen it opens are called: one name, two places. */
export const NOTIFICATION_SETTINGS = "Notification settings"

/** The sections of the menu, by the URL segment that opens each, with the title its screen carries. */
const SECTIONS: Record<string, { title: string; render: () => ReactNode }> = {
  account: { title: "Account", render: () => <AccountSettings /> },
  appearance: { title: "Appearance", render: () => <AppearanceSettings /> },
  community: { title: "Community", render: () => <CommunitySettings /> },
  notifications: { title: NOTIFICATION_SETTINGS, render: () => <NotificationTypes /> },
  data: { title: "Local data", render: () => <DataSettings /> },
  developer: { title: "Developer", render: () => <DeveloperSettings /> },
}

/** The title of an open section screen; a bot's screen is named after the bot. */
function sectionTitle(section: string, botName?: string) {
  const page = SECTIONS[section]
  return page ? page.title : (botName ?? "Bot")
}

/** Which section the menu shows as open, and whether picking one swaps it in place. */
const MenuContext = createContext<{ active?: string; replace: boolean }>({ replace: false })

/**
 * Settings: a menu whose rows each open a section, with the bots listed on it. Up to tablet width
 * the menu and a section are separate screens; wider, they sit side by side, with the first section
 * open by default.
 */
export function SettingsPage() {
  const { section, botId, tab, sub } = useParams()
  const large = useLarge()
  const { up, root } = useNav()
  const navigate = useNavigate()
  const { account } = useSyncState()
  const profiles = useLiveQuery(listProfiles, [])
  // The bots live on the menu itself now, so /settings/bots without a bot is the menu.
  const screen = section === "bots" && !botId ? undefined : section
  const separate = !large && Boolean(screen)
  const bot = botId ? profiles?.find((p) => p.id === botId) : undefined
  const canDelete = (profiles?.length ?? 0) > 1
  // One reading of the URL's third segment, so nothing downstream narrows it again with a cast.
  const botTab = botTabOf(tab)
  const page = botTab ? botPageOf(botTab) : undefined
  // A page's sub-screen: the row's edit or the list it drills into, named by the fourth segment.
  const botSub = botTab && sub ? botSubOf(botTab, sub) : undefined
  // On its own screen, a page sits under its bot's list and the list under the Settings menu.
  useEffect(() => {
    if (!separate) return
    const back = botSub
      ? botTabPath(botId!, botTab!)
      : botId && botTab
        ? `/settings/bots/${botId}`
        : "/settings"
    return setBackGuard(() => {
      up(back)
      return true
    })
  }, [separate, up, botId, botTab, botSub])

  if (section && section !== "bots" && !SECTIONS[section])
    return <Navigate to="/settings" replace />
  // The bot pages: a hand-typed segment naming one this screen doesn't have lands on the bot's own
  // list, and one asked for on anything but a bot lands on the section without it.
  if (tab && !botTab)
    return <Navigate to={botId ? `/settings/bots/${botId}` : "/settings"} replace />
  if (tab && (section !== "bots" || !botId)) return <Navigate to="/settings" replace />
  // A segment that named a page before the list: the page that took its place, in its entry.
  if (botId && botTab && tab !== botTab) return <Navigate to={botTabPath(botId, botTab)} replace />
  // A fourth segment that names nothing on this page is the page itself, in its own entry.
  if (sub && botTab && !botSub) return <Navigate to={botTabPath(botId!, botTab)} replace />
  if (sub && !botTab)
    return <Navigate to={botId ? `/settings/bots/${botId}` : "/settings"} replace />
  // A botId that isn't one of this device's bots is the menu, and nothing of a bot's screen.
  if (section === "bots" && botId && !bot)
    return profiles === undefined ? null : <Navigate to="/settings" replace />

  if (!large) {
    if (section === "bots" && botId) {
      if (!bot) return null
      return page ? (
        <BotPageScreen profile={bot} page={page} sub={botSub} />
      ) : (
        <BotListScreen profile={bot} canDelete={canDelete} onDeleted={() => root("/settings")} />
      )
    }
    return screen ? <SectionScreen section={screen} /> : <MenuScreen profiles={profiles} />
  }

  // A bot's settings is two panes of its own: the list where the menu was, the page beside it.
  if (section === "bots" && botId) {
    if (!bot) return null
    return (
      <div className="flex min-h-0 flex-1">
        <Screen
          title={bot.name}
          className="w-90 flex-none border-r min-[1200px]:w-103"
          leading={
            <BackButton
              onClick={() => navigate("/settings", { replace: true, state: { quiet: true } })}
            />
          }
        >
          <BotSettingsList
            profile={bot}
            replace
            canDelete={canDelete}
            onDeleted={() => root("/settings")}
          />
        </Screen>
        <Screen
          key={`${botTab ?? "general"}-${botSub?.id ?? ""}`}
          title={botSub?.title ?? page?.title ?? botPageOf("general").title}
          leading={
            botSub && botTab ? (
              <BackButton
                onClick={() =>
                  navigate(botTabPath(bot.id, botTab), { replace: true, state: { quiet: true } })
                }
              />
            ) : undefined
          }
          className="duration-200 ease-out motion-safe:animate-in motion-safe:fade-in-0"
        >
          <BotSettingsPage profile={bot} tab={botTab} sub={botSub} />
        </Screen>
      </div>
    )
  }

  const open =
    screen ??
    (account.status === "signed-in" || account.status === "signed-out" ? "account" : "appearance")
  return (
    <div className="flex min-h-0 flex-1">
      <MenuContext.Provider value={{ active: open, replace: true }}>
        <MenuScreen className="w-90 flex-none border-r min-[1200px]:w-103" profiles={profiles} />
      </MenuContext.Provider>
      <Screen
        key={open}
        title={sectionTitle(open, bot?.name)}
        className="duration-200 ease-out motion-safe:animate-in motion-safe:fade-in-0"
      >
        {SECTIONS[open].render()}
      </Screen>
    </div>
  )
}

/** A bot's settings as pushed screens: the list, and a page over it. */
function BotListScreen({
  profile,
  canDelete,
  onDeleted,
}: {
  profile: Profile
  canDelete: boolean
  onDeleted: () => void
}) {
  const { up } = useNav()
  return (
    <Screen title={profile.name} leading={<BackButton onClick={() => up("/settings")} />}>
      <BotSettingsList profile={profile} canDelete={canDelete} onDeleted={onDeleted} />
    </Screen>
  )
}

/** One page of a bot's settings, or one of its sub-screens, under the list that opened it. */
function BotPageScreen({ profile, page, sub }: { profile: Profile; page: BotPage; sub?: BotSub }) {
  const { up } = useNav()
  const back = sub ? botTabPath(profile.id, page.segment) : `/settings/bots/${profile.id}`
  return (
    <Screen title={sub?.title ?? page.title} leading={<BackButton onClick={() => up(back)} />}>
      <BotSettingsPage profile={profile} tab={page.segment} sub={sub} />
    </Screen>
  )
}

function MenuScreen({
  className,
  profiles,
}: {
  className?: string
  profiles: Profile[] | undefined
}) {
  const openDrawer = useOpenDrawer()
  const settings = useLiveQuery(
    async () => ({ ...DEFAULT_SETTINGS, ...(await db.settings.get("settings")) }),
    [],
  )
  const { registryError } = useSyncState()
  const { theme } = useTheme()
  const [params, setParams] = useSearchParams()
  const linking = params.get("link") === "1"
  const setLinking = (open: boolean) =>
    setParams(open ? { link: "1" } : {}, { replace: true, state: { quiet: true } })

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
      <Group>
        {profiles?.map((profile) => (
          <BotRow key={profile.id} profile={profile} />
        ))}
        <LinkBotRow onLink={() => setLinking(true)} />
      </Group>
      <Group>
        <Row to="appearance" icon={PaletteIcon} title="Appearance" subtitle={themeLabel(theme)} />
        <NotificationsRow />
        <NotificationSettingsRow />
      </Group>
      <Group>
        <CommunityRow />
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
function BotRow({ profile }: { profile: Profile }) {
  const now = useNow()
  const online = profile.hostId && !profile.disabled ? isOnline(profile, now) : undefined
  return (
    <Row
      to={`bots/${profile.id}`}
      leading={
        <>
          <span className="flex size-3 shrink-0 items-center justify-center">
            <OnlineDot online={online} />
          </span>
          <Bot
            id={profile.botId}
            className={cn("size-8 shrink-0", profile.disabled && "opacity-40")}
          />
        </>
      }
      title={profile.name}
      subtitle={botStatus(profile, now)}
    />
  )
}

/** A bot's row subtext: a warning first, else when its host last checked in. */
function botStatus(profile: Profile, now: number): string | undefined {
  if (profile.disabled) return undefined
  if (pluginOutdated(profile.pluginVersion)) return "Plugin out of date"
  if (!profile.seenAt) return undefined
  return isOnline(profile, now)
    ? "Online"
    : `Last seen ${formatRelative(profile.seenAt, Math.max(now, profile.seenAt))}`
}

/** The row that opens the link sheet, at the end of the bots. */
function LinkBotRow({ onLink }: { onLink: () => void }) {
  return <ActionRow icon={PlusIcon} title="Link a bot" onClick={onLink} />
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

function CommunityRow() {
  const { account } = useSyncState()
  if (account.status !== "signed-in") return null
  return <Row to="community" icon={TrophyIcon} title="Community" />
}

/**
 * The row that hands its platform the notification switches, named for what it opens. A phone has
 * channels, which only Android's own screen switches, so there it opens that screen and shows even
 * while notifications are off — that is where they are turned back on. The web has no channels, so
 * there it opens the app's own list, and hides while notifications are off.
 */
export function NotificationSettingsRow() {
  if (!pushAvailable()) return null
  return isNative ? <SystemNotificationSettingsRow /> : <NotificationListRow />
}

/** Android: the phone's screen for this app, which the app can read but not draw. */
function SystemNotificationSettingsRow() {
  const open = async () => {
    try {
      // A build too old to have the screen says nothing; one that refused says why.
      const refused = await openNotificationSettings()
      if (refused) toast.error(refused)
    } catch (error) {
      // The call is made off the tap, so anything it throws must land here or be lost.
      toast.error(
        error instanceof Error && error.message
          ? `Couldn't open notification settings. ${error.message}`
          : "Couldn't open notification settings",
      )
    }
  }
  return (
    <ActionRow
      icon={SlidersHorizontalIcon}
      title={NOTIFICATION_SETTINGS}
      onClick={() => void open()}
    />
  )
}

/** The web: the app's list of types, the only switch a browser has. */
function NotificationListRow() {
  const { on } = usePush()
  if (!on) return null
  return <Row to="notifications" icon={SlidersHorizontalIcon} title={NOTIFICATION_SETTINGS} />
}

const CATEGORY_ICONS: Record<PushCategory, LucideIcon> = {
  chat_input: MessageCircleQuestionIcon,
  chat_run_failed: CircleAlertIcon,
  chat_run_done: CircleCheckIcon,
  code_input: MessageCircleQuestionIcon,
  code_run_failed: CircleAlertIcon,
  code_run_done: CircleCheckIcon,
  code_pr_checks: GitPullRequestIcon,
  code_pr_merged: GitMergeIcon,
  code_afk_pr: GitPullRequestArrowIcon,
  code_setup_failed: FolderXIcon,
  routine_failed: CalendarXIcon,
  research_input: ClipboardCheckIcon,
  research_done: BookOpenCheckIcon,
  research_failed: CircleAlertIcon,
  meeting_done: CircleCheckIcon,
  meeting_failed: CircleAlertIcon,
}

const FEATURE_ICONS: Record<PushFeature, LucideIcon> = {
  chats: MessagesSquareIcon,
  code: CodeXmlIcon,
  routines: TimerIcon,
  research: TelescopeIcon,
  meetings: AudioLinesIcon,
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
      Gots v{APP_VERSION}
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

export function DeveloperSettings() {
  const bots = useLiveQuery(listProfiles, [])
  const settings = useLiveQuery(getSettings, [])
  return (
    <>
      <Group>
        <SwitchRow
          id="bot-threads"
          icon={MessagesSquareIcon}
          title="Bot threads"
          experimental
          subtitle="Bots in the sidebar, chats as threads"
          checked={Boolean(settings?.botThreads)}
          onCheckedChange={(checked) => saveSettings({ botThreads: checked })}
        />
        <SwitchRow
          id="meetings"
          icon={AudioLinesIcon}
          title="Meetings"
          experimental
          subtitle="Design only, with sample meetings"
          checked={Boolean(settings?.meetings)}
          onCheckedChange={(checked) => saveSettings({ meetings: checked })}
        />
        <SwitchRow
          id="afk-workflows"
          icon={WorkflowIcon}
          title="AFK Workflows"
          experimental
          subtitle="The workflow library in a project's AFK pop-up"
          checked={Boolean(settings?.afkWorkflows)}
          onCheckedChange={(checked) => saveSettings({ afkWorkflows: checked })}
        />
      </Group>
      {isNative && pushAvailable() && <TestPushRow />}
      <Group>
        <SyncServerRow />
      </Group>
      <Group>
        {bots?.map((bot) => (
          <LiveRow key={bot.id} bot={bot} />
        ))}
      </Group>
      <Group>
        <DeviceStateRow />
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

function SyncServerRow() {
  return (
    <div className={rowClass}>
      <RowText title="Sync server" subtitle={siteUrl() || "Not set"} />
    </div>
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

/** A section's own screen, under the Settings menu. */
function SectionScreen({ section }: { section: string }) {
  const { up } = useNav()
  return (
    <Screen
      title={SECTIONS[section].title}
      leading={<BackButton onClick={() => up("/settings")} />}
    >
      {SECTIONS[section].render()}
    </Screen>
  )
}

/** The round back control every pushed Settings screen wears. */
function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="icon-lg"
      className="size-11 rounded-full"
      onClick={onClick}
      aria-label="Back"
    >
      <ArrowLeftIcon />
    </Button>
  )
}

function Row({
  to,
  icon: Icon,
  image,
  leading,
  title,
  subtitle,
}: {
  to: string
  icon?: LucideIcon
  image?: string
  leading?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
}) {
  const { active, replace } = useContext(MenuContext)
  return (
    <Link
      to={`/settings/${to}`}
      replace={replace}
      aria-current={active === to ? "page" : undefined}
      className={cn(linkRowClass, "aria-[current=page]:bg-muted")}
    >
      {leading ??
        (image ? (
          <img
            src={image}
            alt=""
            className="size-8 shrink-0 rounded-full ring-1 ring-foreground/10"
          />
        ) : Icon ? (
          <Icon className="size-5 shrink-0 text-muted-foreground" />
        ) : null)}
      <RowText title={title} subtitle={subtitle} />
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  )
}

function FeedbackRow() {
  return <SheetRow icon={MessageSquareTextIcon} title="Send feedback" sheet={FeedbackSheet} />
}

function DeviceStateRow() {
  return <SheetRow icon={SmartphoneIcon} title="Device state" sheet={DeviceStateSheet} />
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
