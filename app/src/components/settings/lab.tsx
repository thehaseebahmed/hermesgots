/** Settings > Lab: the switches for the features the app is still building. */
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
          subtitle="Transcripts and recordings, written up as notes"
          checked={Boolean(settings?.meetings)}
          onCheckedChange={(checked) => saveSettings({ meetings: checked })}
        />
      </Group>
    </>
  )
}
