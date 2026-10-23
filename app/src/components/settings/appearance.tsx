/**
 * Appearance: how the app draws. The colour mode, then the switches that follow this device through
 * the account, then the one switch that is the profile's own and lives on its host — whether a
 * reply's interface is drawn at all (ADR 0033). The section is here rather than in
 * `routes/settings.tsx` so a component test can mount it on its own, the way `DeveloperSettings` is
 * mounted; `SwitchRow` comes with it, since the sections that share it are drawn beside this file.
 */
import { useLiveQuery } from "dexie-react-hooks"
import {
  CheckIcon,
  CornerDownRightIcon,
  KeyboardIcon,
  LayoutGridIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
  TimerIcon,
  type LucideIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { ExperimentalBadge } from "@/components/experimental-badge"
import { Group, RowText, rowClass } from "@/components/settings-chrome"
import { Switch } from "@/components/ui/switch"
import { DEFAULT_SETTINGS, db, getActiveProfile, saveAppearance } from "@/lib/db"
import { usePluginFeature, type PluginServer } from "@/lib/features"
import { useHostRecord } from "@/lib/host-record"
import { OPENUI_SWITCH } from "@/lib/openui-switch"
import { THEMES, type ThemeValue } from "@/lib/theme"
import { cn } from "@/lib/utils"

const ICONS: Record<ThemeValue, LucideIcon> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
}

export function SwitchRow({
  id,
  icon: Icon,
  title,
  experimental,
  subtitle,
  checked,
  disabled,
  variant,
  onCheckedChange,
}: {
  id: string
  icon: LucideIcon
  title: string
  experimental?: boolean
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
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate text-base", variant === "header" && "font-semibold")}>
            {title}
          </span>
          {experimental && <ExperimentalBadge />}
        </span>
        {subtitle && <span className="line-clamp-2 text-sm text-muted-foreground">{subtitle}</span>}
      </span>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </label>
  )
}

/**
 * The interface switch: profile-wide and kept on the host, because the cost it saves — the library
 * riding in every new chat's system prompt — is paid there. Off draws a reply's blocks as the code
 * they came from, on every device, and the next chat isn't told the library.
 *
 * A host that predates the feature offers nothing to switch, so the row is shown unavailable rather
 * than off, and while its answer is still unknown nothing is acted on. A write the host refuses is
 * a failure the user sees, never a quiet local off: the switch keeps what the host holds.
 */
function InterfaceSwitch({ server }: { server: PluginServer }) {
  const answer = usePluginFeature(server, OPENUI_SWITCH.feature)
  const { value, supported, saving, save } = useHostRecord(server, OPENUI_SWITCH, true)
  const offered = answer === "yes" && supported
  return (
    <SwitchRow
      id="interfaces"
      icon={LayoutGridIcon}
      title="Interfaces"
      subtitle={
        answer === "no"
          ? "Not available on this bot's host"
          : "Replies draw the cards and charts they carry"
      }
      checked={value}
      disabled={!offered || saving}
      onCheckedChange={(on) => {
        void save(on).catch((error: unknown) =>
          toast.error(error instanceof Error ? error.message : "Couldn't save that."),
        )
      }}
    />
  )
}

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const current = theme ?? "system"
  const chatSettings = useLiveQuery(
    async () => ({ ...DEFAULT_SETTINGS, ...(await db.settings.get("settings")) }),
    [],
  )
  // The switch is the profile's, and Appearance has no bot in scope: it is the active profile's
  // host that is asked, and with no profile at all there is nothing to ask.
  const profile = useLiveQuery(getActiveProfile, [])
  return (
    <>
      <Group>
        {THEMES.map(({ value, label }) => {
          const Icon = ICONS[value]
          return (
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
          )
        })}
      </Group>
      <Group>
        <SwitchRow
          id="steer-by-default"
          icon={CornerDownRightIcon}
          title="Steer by default"
          subtitle="Messages sent mid-reply go straight to it"
          checked={chatSettings?.steerByDefault ?? DEFAULT_SETTINGS.steerByDefault}
          onCheckedChange={(checked) => saveAppearance({ steerByDefault: checked })}
        />
        <SwitchRow
          id="break-reminders"
          icon={TimerIcon}
          title="Take-a-break reminders"
          subtitle="Remind me to put the phone away while a task runs"
          checked={chatSettings?.breakReminders ?? DEFAULT_SETTINGS.breakReminders}
          onCheckedChange={(checked) => saveAppearance({ breakReminders: checked })}
        />
        <SwitchRow
          id="nav-shortcuts"
          icon={KeyboardIcon}
          title="Navigation shortcuts"
          subtitle="Alt+1 to Alt+9 start a new chat with that bot"
          checked={chatSettings?.navShortcuts ?? DEFAULT_SETTINGS.navShortcuts}
          onCheckedChange={(checked) => saveAppearance({ navShortcuts: checked })}
        />
        <InterfaceSwitch server={profile} />
      </Group>
    </>
  )
}
