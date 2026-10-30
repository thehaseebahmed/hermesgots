import { useState } from "react"
import { ChevronRightIcon } from "lucide-react"

import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { WorkLabel, WorkRow } from "@/components/chat/work-row"
import { cn } from "@/lib/utils"

/**
 * One progress reminder as the developer view draws it: a work row of its own, in the app's words
 * rather than as work that failed, which opens the note the host wrote — its pinned opening first
 * and nothing paraphrased. It never joins a tool group, so that group counts only calls that ran.
 */
export function ReminderRow({ reminder }: { reminder: { note: string } }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <WorkRow
        data-slot="progress-reminder"
        aria-label="Progress reminder"
        onClick={() => setOpen(true)}
        after={<ChevronRightIcon className="size-4 shrink-0" />}
      >
        <WorkLabel>Progress reminder</WorkLabel>
      </WorkRow>
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
