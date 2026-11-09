import { useLiveQuery } from "dexie-react-hooks"
import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { connectionKey } from "@/lib/connection"
import { db } from "@/lib/db"
import { usePluginFeatureByServer } from "@/lib/features"
import { useNav } from "@/lib/nav"
import { cn } from "@/lib/utils"

/**
 * New room: the one control a room is started from, in the sidebar's footer and in both of its
 * layouts, because a room is a row of the Recents list and of the bots list alike (ADR 0122).
 *
 * It opens the blank room rather than a sheet of its own (ADR 0125): the seats are picked where the
 * room is drawn, and nothing reaches the Host until its first message. The control is drawn only
 * where some bot's Host answers `rooms_write` — a Host that cannot make a room offers no control
 * rather than one that can only come back refused.
 */
export function NewRoomButton({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean
  onNavigate?: () => void
}) {
  const { root } = useNav()
  const bots = useLiveQuery(() => db.profiles.toArray(), []) ?? []
  const answers = usePluginFeatureByServer(bots, "rooms_write")
  const writers = bots.filter(
    (bot) => bot.hermesProfile && !bot.disabled && answers[connectionKey(bot)] === "yes",
  )
  if (!writers.length) return null
  return (
    <Button
      size="lg"
      variant="outline"
      className={cn("h-11 rounded-full", collapsed ? "w-11 px-0" : "px-5")}
      aria-label="New room"
      onClick={() => {
        root("/new-room")
        onNavigate?.()
      }}
      data-slot="new-room"
    >
      <PlusIcon data-icon={collapsed ? undefined : "inline-start"} />
      {!collapsed && "New room"}
    </Button>
  )
}
