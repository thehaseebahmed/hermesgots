/**
 * Lab: the app's lab features, and the switches that turn them on. It sits outside Developer
 * Settings because a lab feature is one a reader can try without unlocking anything, so these rows
 * are here rather than behind Developer's switch.
 */
import { useLiveQuery } from "dexie-react-hooks"
import { AudioLinesIcon, MessageSquareTextIcon } from "lucide-react"

import { Caption, Group, SwitchRow } from "@/components/settings-chrome"
import { getSettings, saveSettings } from "@/lib/db"

export function LabSettings() {
  const settings = useLiveQuery(getSettings, [])
  return (
    <>
      <Caption>Features the app is still building</Caption>
      <Group>
        <SwitchRow
          id="show-progress-reminders"
          icon={MessageSquareTextIcon}
          title="Show progress reminders"
          lab
          subtitle="Each reminder a thread hides, as a row of its own"
          checked={Boolean(settings?.showProgressReminders)}
          onCheckedChange={(checked) => saveSettings({ showProgressReminders: checked })}
        />
        <SwitchRow
          id="meetings"
          icon={AudioLinesIcon}
          title="Meetings"
          lab
          subtitle="Design only, with sample meetings"
          checked={Boolean(settings?.meetings)}
          onCheckedChange={(checked) => saveSettings({ meetings: checked })}
        />
      </Group>
    </>
  )
}
