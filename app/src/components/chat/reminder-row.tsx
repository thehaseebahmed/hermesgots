import { useState } from "react"
import { MegaphoneIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { SystemLine, SystemLink } from "@/components/chat/system-line"
import { cn } from "@/lib/utils"

/**
 * One progress reminder as the developer view draws it: the app's system line, not a work row, since
 * a reminder is the host talking to the model rather than the bot accounting for its own work
 * (ADR 0087). It says the bare words "Progress reminder" and the whole line opens the note the host
 * wrote — its pinned opening first and nothing paraphrased. It never joins a tool group, so that
 * group counts only calls that ran.
 */
export function ReminderRow({ reminder }: { reminder: { note: string } }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <SystemLine>
        <SystemLink
          icon={MegaphoneIcon}
          onClick={() => setOpen(true)}
          label="Progress reminder"
          slot="progress-reminder"
        >
          Progress reminder
        </SystemLink>
      </SystemLine>
      <Popup open={open} onOpenChange={setOpen}>
        <PopupContent>
          <PopupHeader>
            <PopupTitle>Progress reminder</PopupTitle>
          </PopupHeader>
          <div className="px-6 pb-6">
            <p
              data-slot="progress-reminder-note"
              className={cn("text-[15px] leading-relaxed break-words whitespace-pre-wrap")}
            >
              {reminder.note}
            </p>
          </div>
        </PopupContent>
      </Popup>
    </>
  )
}
