/** Settings > Labs: the switches for the features the app is still building, and the page's line. */
import { useLiveQuery } from "dexie-react-hooks"
import { AudioLinesIcon, FlaskConicalIcon, FrameIcon, LayoutGridIcon } from "lucide-react"

import { Group, SwitchRow, useScreenRefusal } from "@/components/settings-chrome"
import { getActiveProfile, getSettings, saveSettings } from "@/lib/db"
import { usePluginFeature, type PluginServer } from "@/lib/features"
import { useHostRecord } from "@/lib/host-record"
import { OPENUI_SWITCH, UNANSWERED_IS_ON } from "@/lib/openui-switch"

/**
 * Profile-wide on the host, because the cost it saves is paid there; a write the host refuses comes
 * back as the host's truth rather than a quiet local off.
 */
function GenUISwitch({ server, labsOn }: { server: PluginServer; labsOn: boolean }) {
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
      variant="nested"
      icon={LayoutGridIcon}
      title="GenUI (Powered by OpenUI)"
      lab
      subtitle={
        answer === "no"
          ? "Not available on this bot's host"
          : "Replies draw the cards and charts they carry"
      }
      checked={settled && value}
      disabled={!offered || saving || !labsOn}
      onCheckedChange={(on) => void refusal.write("save that", () => save(on))}
    />
  )
}

export function LabSettings() {
  const settings = useLiveQuery(getSettings, [])
  const profile = useLiveQuery(getActiveProfile, [])
  // On unless this device turned it off: the page's own rows say which features are on below it.
  const labsOn = settings?.labs !== false
  return (
    <>
      <p className="text-base text-pretty">
        Try experimental features. Some features may not work correctly.
      </p>
      <Group>
        <SwitchRow
          id="labs"
          variant="header"
          icon={FlaskConicalIcon}
          title="Labs"
          subtitle={labsOn ? "Every feature on this page" : "Off: no lab feature runs"}
          checked={labsOn}
          onCheckedChange={(checked) => saveSettings({ labs: checked })}
        />
        <SwitchRow
          id="canvas"
          variant="nested"
          icon={FrameIcon}
          title="Canvas"
          lab
          subtitle="Pages a bot builds, drawn in the app"
          checked={labsOn && settings?.canvas !== false}
          disabled={!labsOn}
          onCheckedChange={(checked) => saveSettings({ canvas: checked })}
        />
        <GenUISwitch server={profile} labsOn={labsOn} />
        <SwitchRow
          id="meetings"
          variant="nested"
          icon={AudioLinesIcon}
          title="Meetings"
          lab
          subtitle="Transcripts and recordings, written up as notes"
          checked={labsOn && Boolean(settings?.meetings)}
          disabled={!labsOn}
          onCheckedChange={(checked) => saveSettings({ meetings: checked })}
        />
      </Group>
    </>
  )
}
