/**
 * A bot's routines, worn as its bars' one trailing control: the press from the bot's chat list and
 * from the Side Chat List onto `/b/<bot>/routines`.
 *
 * One control and not two: the two lists stand one press apart, and a copy of this markup in each was
 * a place for the icon, the word a reader who cannot see it hears, or the press's size to drift. It is
 * an icon alone in the bar's trailing corner, so the label is what says what it opens (`HEADER_BUTTON`
 * is the bar's own sizing).
 */
import { RotateCcwClockIcon } from "lucide-react"
import { Link } from "react-router"

import { buttonVariants } from "@/components/ui/button"
import { botRoutinesPath } from "@/lib/bot-tabs"
import { HEADER_BUTTON } from "@/lib/layout"
import { cn } from "@/lib/utils"

export function RoutinesButton({ profileId }: { profileId: string }) {
  return (
    <Link
      to={botRoutinesPath(profileId)}
      aria-label="Routines"
      data-slot="routines-button"
      className={cn(
        buttonVariants({ variant: "outline", size: "icon-lg" }),
        HEADER_BUTTON,
        "shrink-0 text-muted-foreground",
      )}
    >
      <RotateCcwClockIcon />
    </Link>
  )
}
