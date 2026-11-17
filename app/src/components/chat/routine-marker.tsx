import { RotateCcwClockIcon } from "lucide-react"

import { SystemLine, SystemLink } from "@/components/chat/system-line"
import { COLUMN_BOX } from "@/lib/layout"
import type { RoutineMarker } from "@/lib/routine-marker"
import { cn } from "@/lib/utils"

/**
 * Where a routine's run came back, drawn in its bot's Main: one centred line, in the thread's own
 * system-line voice, whose sentence opens the run. It is no message — nothing of it is in the
 * transcript, so the bot never reads it — and it is drawn only in a Main, which is where a routine's
 * delivery is addressed.
 */
export function RoutineMarkerRow({ marker }: { marker: RoutineMarker }) {
  return (
    <div className={cn(COLUMN_BOX, "text-center")} data-slot="routine-marker">
      <SystemLine>
        <SystemLink icon={RotateCcwClockIcon} to={`/c/${marker.id}`} slot="routine-marker-link">
          {marker.text}
        </SystemLink>
      </SystemLine>
    </div>
  )
}
