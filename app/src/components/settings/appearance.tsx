/**
 * Appearance: how the app draws, and the one switch the profile keeps on its host.
 * It is here rather than in `routes/settings.tsx` so a component test can mount it on its own.
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

import { Group, RowText, SwitchRow, rowClass } from "@/components/settings-chrome"
import { DEFAULT_SETTINGS, db, getActiveProfile, saveAppearance } from "@/lib/db"
import { usePluginFeature, type PluginServer } from "@/lib/features"
import { useHostRecord } from "@/lib/host-record"
import { OPENUI_SWITCH, UNANSWERED_IS_ON } from "@/lib/openui-switch"
import { THEMES, type ThemeValue } from "@/lib/theme"
import { cn } from "@/lib/utils"

const ICONS: Record<ThemeValue, LucideIcon> = {
  system: MonitorIcon,
  light: SunIcon,
  dark: MoonIcon,
}

/**
 * Profile-wide on the host, because the cost it saves is paid there; a write the host refuses comes
 * back as the host's truth rather than a quiet local off.
 */
function InterfaceSwitch({ server }: { server: PluginServer }) {
  const answer = usePluginFeature(server, OPENUI_SWITCH.feature)
  const { value, settled, supported, saving, save } = useHostRecord(
    server,
    OPENUI_SWITCH,
    UNANSWERED_IS_ON,
  )
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
      checked={settled && value}
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
