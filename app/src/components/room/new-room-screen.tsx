import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate } from "react-router"
import { CheckIcon, UsersIcon } from "lucide-react"

import { Banner } from "@/components/banner"
import { Bot } from "@/components/bot"
import { ChatHeader } from "@/components/chat/chat-header"
import { Composer } from "@/components/chat/composer"
import { Popup, PopupContent, PopupHeader, PopupTitle } from "@/components/popup"
import { RoomFaces } from "@/components/room/room-faces"
import { Group, linkRowClass, RowText } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { connectionKey, serverConfig } from "@/lib/connection"
import {
  DEFAULT_SETTINGS,
  db,
  getSettings,
  type Attachment,
  type Profile,
  type RoomMember,
} from "@/lib/db"
import { usePluginFeatureByServer } from "@/lib/features"
import { COLUMN_BOX } from "@/lib/layout"
import { botModel, fullModel, useModelInfo } from "@/lib/model-info"
import { roomSeats } from "@/lib/rooms"
import { startRoom } from "@/lib/room-writes"
import { cn, randomId } from "@/lib/utils"

/** The fewest and most seats a room may hold: the Host's rule, said before it can be broken. */
const LEAST = 2
const MOST = 6

/**
 * A room that does not exist yet, drawn the way a new chat is (ADR 0096, ADR 0125): no record, no
 * Host call, and the app's own composer. Its first send is what makes the room — `startRoom` mints the
 * id and asks the Host for it, then the address moves to the room's own, which sends the message as
 * its first turn. A room opened and left therefore costs the Host nothing and leaves no row.
 *
 * The seats are picked above the composer, from one Host at a time, two at least and six at most: the
 * roster is fixed when the room is made, so it is chosen where the room is, before anything is sent.
 * The room's name is its seats' names until the Host names it otherwise — a room's name is the Host's
 * (ADR 0122), and a rename through the room's own menu is how it changes.
 */
export function NewRoomScreen({ slot }: { slot?: string }) {
  const navigate = useNavigate()
  const bots = useLiveQuery(() => db.profiles.toArray(), []) ?? []
  const sendOnEnter = useLiveQuery(
    async () => (await getSettings()).sendOnEnter ?? DEFAULT_SETTINGS.sendOnEnter,
    [],
  )
  const answers = usePluginFeatureByServer(bots, "rooms_write")
  const writers = useMemo(
    () =>
      bots
        .filter((bot) => bot.hermesProfile && !bot.disabled && answers[connectionKey(bot)] === "yes")
        .sort((one, two) => one.name.localeCompare(two.name)),
    [bots, answers],
  )
  const hosts = [...new Set(writers.map((bot) => connectionKey(bot)))]
  const [host, setHost] = useState("")
  const seated = writers.filter((bot) => connectionKey(bot) === (host || hosts[0]))
  const [picked, setPicked] = useState<string[]>([])
  const [picking, setPicking] = useState(false)
  const [roomId] = useState(() => randomId())
  const [seats, setSeats] = useState<Record<string, RoomMember>>({})
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string>()

  const chosen = seated.filter((bot) => picked.includes(bot.id))
  const ready = chosen.length >= LEAST && chosen.length <= MOST

  /** One seat per picked bot, minted when it is picked, so a retried create seats the same members. */
  const seatOf = (bot: Profile): RoomMember => {
    const held = seats[bot.id]
    if (held) return held
    const minted = roomSeats([bot])[0]
    setSeats((all) => ({ ...all, [bot.id]: minted }))
    return minted
  }

  const faces = chosen.map((bot) => bot.botId ?? "").filter(Boolean)

  const send = async (text: string, attachments: Attachment[] = []) => {
    if (!ready || sending || !chosen.length) return
    setSending(true)
    setFailure(undefined)
    try {
      const members = chosen.map(seatOf)
      await startRoom(chosen[0], {
        roomId,
        // Its name until the Host says otherwise: the seats, in the order they were picked.
        name: chosen.map((bot) => bot.name).join(", "),
        members,
      })
      // The room exists: its own screen takes the address and sends the first message into it.
      navigate(`/c/${roomId}`, { replace: true, state: { first: { text, attachments } } })
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : "The room wasn't made.")
      setSending(false)
    }
  }

  const connection = serverConfig(chosen[0] ?? writers[0])

  return (
    <div data-slot="chat-pane" data-pane={slot} className="relative flex min-h-0 flex-1 flex-col">
      <ChatHeader
        title="New room"
        subtitle={chosen.length ? chosen.map((bot) => bot.name).join(", ") : "No bots picked yet"}
        showBot={false}
        centered
      />
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <p className={cn(COLUMN_BOX, "max-w-sm text-center text-sm text-muted-foreground")}>
          {writers.length
            ? "Pick two to six bots of one Host, then send the first message. The room is made when you send, and who it holds is fixed from then on."
            : "This bot's Host can't make a room, so there is nothing to start here."}
        </p>
      </div>

      {failure && (
        <div className={cn(COLUMN_BOX, "px-3 pb-2 sm:px-4")} role="alert">
          <Banner tone="error">{failure}</Banner>
        </div>
      )}

      <div className={cn(COLUMN_BOX, "px-3 pb-2 sm:px-4")}>
        <Button
          variant="outline"
          className="h-10 rounded-full"
          aria-label="Pick the room's bots"
          data-slot="seats-pill"
          onClick={() => setPicking(true)}
        >
          {faces.length ? (
            <RoomFaces shown={faces.slice(0, 4)} more={Math.max(0, faces.length - 4)} />
          ) : (
            <UsersIcon className="size-4" />
          )}
          <span className="text-sm">
            {chosen.length
              ? `${chosen.length} of ${MOST} bots`
              : `${LEAST} to ${MOST} bots`}
          </span>
        </Button>
      </div>

      <Composer
        plain
        busy={false}
        disabled={!ready || sending || !connection}
        connection={connection}
        botName={chosen[0]?.name ?? "Hermes"}
        draftKey="room-new"
        files={false}
        filesFeature="no"
        imagesAvailable={false}
        placeholder={
          ready ? "Message the room…" : `Pick at least ${LEAST} bots to start the room`
        }
        sendOnEnter={sendOnEnter ?? DEFAULT_SETTINGS.sendOnEnter}
        onSend={send}
        onQueue={send}
        onStop={() => undefined}
      />

      <SeatsPicker
        open={picking}
        onOpenChange={setPicking}
        hosts={hosts}
        host={host || hosts[0] || ""}
        onHost={(next) => {
          setHost(next)
          setPicked([])
          setSeats({})
        }}
        writers={writers}
        seated={seated}
        picked={picked}
        onToggle={(id) =>
          setPicked((held) => {
            if (held.includes(id)) return held.filter((one) => one !== id)
            if (held.length >= MOST) return held
            return [...held, id]
          })
        }
      />
    </div>
  )
}

/**
 * The seats a room is made of: the bots of one Host, a check per seat, and the rule the Host keeps.
 *
 * One Host at a time, because a roster is one Host's profiles (ADR 0115): a device that holds two
 * writable Hosts picks which first. The most is a ceiling rather than a refusal — the seventh tap
 * does nothing — so the rule is felt while picking and not only said after.
 */
function SeatsPicker({
  open,
  onOpenChange,
  hosts,
  host,
  onHost,
  writers,
  seated,
  picked,
  onToggle,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  hosts: string[]
  host: string
  onHost: (host: string) => void
  writers: Profile[]
  seated: Profile[]
  picked: string[]
  onToggle: (id: string) => void
}) {
  const nameOf = (key: string) => {
    const bot = writers.find((one) => connectionKey(one) === key)
    try {
      return bot ? new URL(bot.baseUrl).host : key
    } catch {
      return bot?.baseUrl ?? key
    }
  }
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent className="max-h-[90dvh]">
        <PopupHeader>
          <PopupTitle>Room bots</PopupTitle>
          {/* The rule sits with the title, so the body is the choice and the one button that ends it. */}
          <p className="text-sm text-muted-foreground">
            Two to six bots of one Host. Who a room holds is fixed when it is made: changing its
            members means making a new room.
          </p>
        </PopupHeader>
        <div className="flex flex-col gap-4 px-6 pb-6">
          {hosts.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {hosts.map((key) => (
                <Button
                  key={key}
                  size="sm"
                  variant={key === host ? "default" : "outline"}
                  onClick={() => onHost(key)}
                >
                  {nameOf(key)}
                </Button>
              ))}
            </div>
          )}
          {/* The seats are a card of rows, the way Settings lists bots, so picking two reads as the
              same act as reading them there. */}
          <Group>
            {seated.map((bot) => (
              <SeatRow
                key={bot.id}
                bot={bot}
                checked={picked.includes(bot.id)}
                full={!picked.includes(bot.id) && picked.length >= MOST}
                onToggle={() => onToggle(bot.id)}
              />
            ))}
          </Group>
          <Button size="lg" className="h-11 w-full rounded-full" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </PopupContent>
    </Popup>
  )
}

/**
 * One bot a room can seat: its picture, its name and the model it runs by default, in the
 * `provider/model` spelling the app names models everywhere, with the check that says it is seated.
 *
 * The subtitle is where Settings' dictation list says what a host does about speech; here it says
 * what the bot answers with, because that is what decides what a room of these bots produces.
 */
function SeatRow({
  bot,
  checked,
  full,
  onToggle,
}: {
  bot: Profile
  checked: boolean
  /** The room already holds the most it may, so this seat says so rather than doing nothing silently. */
  full: boolean
  onToggle: () => void
}) {
  const info = useModelInfo(bot)
  const choice = botModel(bot, info)
  return (
    <button
      type="button"
      aria-pressed={checked}
      data-bot={bot.id}
      disabled={full}
      onClick={onToggle}
      className={cn(
        linkRowClass,
        "disabled:cursor-not-allowed disabled:opacity-40",
        checked && "bg-muted",
      )}
    >
      <Bot id={bot.botId} className={cn("size-8 shrink-0", bot.disabled && "opacity-40")} />
      <RowText title={bot.name} subtitle={choice ? fullModel(choice) : bot.model} />
      {checked && <CheckIcon className="size-4 shrink-0" />}
    </button>
  )
}
