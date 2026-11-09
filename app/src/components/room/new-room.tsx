import { useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckIcon, PlusIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { connectionKey } from "@/lib/connection"
import { db, type Profile, type RoomMember } from "@/lib/db"
import { usePluginFeatureByServer } from "@/lib/features"
import { useNav } from "@/lib/nav"
import { newRoomId, roomSeats, startRoom } from "@/lib/rooms"
import { cn } from "@/lib/utils"

/** The fewest and most seats a room may hold: the Host's rule, said before it can be broken. */
const LEAST = 2
const MOST = 6

/** The address a Host is called by, which is what a person recognises when a device holds two. */
function hostName(bot: Profile): string {
  try {
    return new URL(bot.baseUrl).host
  } catch {
    return bot.baseUrl
  }
}

/**
 * New room: the one control a room is started from (ADR 0122), in the sidebar's footer and in both of
 * its layouts, because a room is a row of the Recents list and of the bots list alike.
 *
 * It is drawn only where some bot's Host answers `rooms_write` — a Host that cannot make a room offers
 * no control rather than one that can only come back refused — and the sheet offers only the bots of
 * one Host, since a roster is one Host's profiles (ADR 0115). The names the seats are addressed by
 * are their profile names (ADR 0124), and the sheet says, where the seats are chosen, that a roster
 * cannot change later: the Host declares no method that edits one.
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
  const [open, setOpen] = useState(false)
  if (!writers.length) return null
  return (
    <>
      <Button
        size="lg"
        variant="outline"
        className={cn("h-11 rounded-full", collapsed ? "w-11 px-0" : "px-5")}
        aria-label="New room"
        onClick={() => setOpen(true)}
        data-slot="new-room"
      >
        <PlusIcon data-icon={collapsed ? undefined : "inline-start"} />
        {!collapsed && "New room"}
      </Button>
      <NewRoomSheet
        open={open}
        onOpenChange={setOpen}
        writers={writers}
        onCreated={(roomId) => {
          setOpen(false)
          root(`/c/${roomId}`)
          onNavigate?.()
        }}
      />
    </>
  )
}

/**
 * The sheet a room is started from: a name, the Host when a device holds more than one that can make
 * rooms, the seats, and what the Host will not let the user change afterwards.
 *
 * The room's id and each seat's id are minted when the sheet opens, so a create retried after a
 * dropped answer is the same room with the same seats rather than a second one (ADR 0123). A refusal
 * — a reserved handle, a roster the Host counts differently — stands in the sheet in the Host's words
 * and nothing is written.
 */
function NewRoomSheet({
  open,
  onOpenChange,
  writers,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The bots whose Host can make a room: this device's, enabled, and each with a profile to seat. */
  writers: Profile[]
  onCreated: (roomId: string) => void
}) {
  const hosts = [...new Set(writers.map((bot) => connectionKey(bot)))]
  const [host, setHost] = useState<string>("")
  const seated = writers.filter((bot) => connectionKey(bot) === (host || hosts[0]))
  const [name, setName] = useState("")
  const [picked, setPicked] = useState<string[]>([])
  const [seats, setSeats] = useState<Record<string, RoomMember>>({})
  const [roomId, setRoomId] = useState("")
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string>()

  // One opening is one attempt intent: an id for the room, an id for each seat, and nothing left over
  // from the last time the sheet was open.
  useEffect(() => {
    if (!open) return
    setName("")
    setPicked([])
    setFailure(undefined)
    setHost(hosts[0] ?? "")
    setRoomId(newRoomId())
    setSeats(Object.fromEntries(writers.map((bot) => [bot.id, roomSeats([bot])[0]])))
  }, [open])

  const chosen = seated.filter((bot) => picked.includes(bot.id))
  const ready = name.trim().length > 0 && chosen.length >= LEAST && chosen.length <= MOST

  const create = async () => {
    if (!ready || saving) return
    setSaving(true)
    setFailure(undefined)
    try {
      await startRoom(chosen[0], {
        roomId,
        name: name.trim(),
        members: chosen.map((bot) => seats[bot.id]),
      })
      onCreated(roomId)
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : "The room wasn't made.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent className="max-h-[90dvh]">
        <PopupHeader className="pb-2">
          <PopupTitle>New room</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-4 px-1 pb-4">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Room name"
            aria-label="Room name"
            autoFocus
          />
          {hosts.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Host</span>
              <div className="flex flex-wrap gap-2">
                {hosts.map((key) => (
                  <Button
                    key={key}
                    size="sm"
                    variant={key === (host || hosts[0]) ? "default" : "outline"}
                    onClick={() => {
                      setHost(key)
                      setPicked([])
                    }}
                  >
                    {hostName(writers.find((bot) => connectionKey(bot) === key)!)}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Bots</span>
            <ul className="flex flex-col gap-1">
              {seated.map((bot) => {
                const on = picked.includes(bot.id)
                return (
                  <li key={bot.id}>
                    <button
                      type="button"
                      aria-pressed={on}
                      data-bot={bot.id}
                      onClick={() =>
                        setPicked((held) => (on ? held.filter((id) => id !== bot.id) : [...held, bot.id]))
                      }
                      className={cn(
                        "flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors",
                        on ? "bg-muted" : "hover:bg-muted/60",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{bot.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          @{bot.hermesProfile}
                        </span>
                      </span>
                      {on && <CheckIcon className="size-4 shrink-0" />}
                    </button>
                  </li>
                )
              })}
            </ul>
            <p className="text-xs text-muted-foreground">
              Two to six bots of one Host. Who a room holds is fixed when it is made: changing its
              members means making a new room.
            </p>
          </div>
          {failure && <Banner tone="error">{failure}</Banner>}
          <Button size="lg" className="h-11 rounded-full" disabled={!ready || saving} onClick={() => void create()}>
            {saving ? <Spinner /> : "Create"}
          </Button>
        </div>
      </PopupContent>
    </Popup>
  )
}
