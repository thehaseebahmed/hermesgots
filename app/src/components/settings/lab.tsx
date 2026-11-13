/** Settings > Labs: the switches for the features the app is still building, and the page's line. */
import { useLiveQuery } from "dexie-react-hooks"
import { AudioLinesIcon, LayoutGridIcon } from "lucide-react"

import { Group, SwitchRow, useScreenRefusal } from "@/components/settings-chrome"
import { getActiveProfile, getSettings, saveSettings } from "@/lib/db"
import { usePluginFeature, type PluginServer } from "@/lib/features"
import { useHostRecord } from "@/lib/host-record"
import { OPENUI_SWITCH, UNANSWERED_IS_ON } from "@/lib/openui-switch"

/**
 * Profile-wide on the host, because the cost it saves is paid there; a write the host refuses comes
 * back as the host's truth rather than a quiet local off.
 */
function GenUISwitch({ server }: { server: PluginServer }) {
  const answer = usePluginFeature(server, OPENUI_SWITCH.feature)
  const { value, settled, supported, saving, save } = useHostRecord(
    server,
    OPENUI_SWITCH,
    UNANSWERED_IS_ON,
  )
  const offered = answer === "yes" && supported
  const refusal = useScreenRefusal()
  return (
    <SwitchRow
      id="interfaces"
      icon={LayoutGridIcon}
      title="GenUI (Powered by OpenUI)"
      lab
      subtitle={
        answer === "no"
          ? "Not available on this bot's host"
          : "Replies draw the cards and charts they carry"
      }
      checked={settled && value}
      disabled={!offered || saving}
      onCheckedChange={(on) => void refusal.write("save that", () => save(on))}
    />
  )
}

export function LabSettings() {
  const settings = useLiveQuery(getSettings, [])
  const profile = useLiveQuery(getActiveProfile, [])
  return (
    <>
      <p className="text-base text-pretty">
        Try experimental features. Some features may not work correctly.
      </p>
      <Group>
        <SwitchRow
          id="meetings"
          icon={AudioLinesIcon}
          title="Meetings"
          lab
          subtitle="Transcripts and recordings, written up as notes"
          checked={Boolean(settings?.meetings)}
          onCheckedChange={(checked) => saveSettings({ meetings: checked })}
        />
        <GenUISwitch server={profile} />
      </Group>
    </>
  )
}
