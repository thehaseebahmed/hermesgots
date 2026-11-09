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
import { connectionKey, hostKey, serverConfig } from "@/lib/connection"
import {
  DEFAULT_SETTINGS,
  db,
  getSettings,
  type Attachment,
  type Profile,
  type RoomMember,
} from "@/lib/db"
import { usePluginFeatureByServer } from "@/lib/features"
import { COLUMN_BOX, COMPOSER_SLOT } from "@/lib/layout"
import { botModel, fullModel, useModelInfo } from "@/lib/model-info"
import { FACES, roomSeats } from "@/lib/rooms"
import { startRoom } from "@/lib/room-writes"
import { tell } from "@/lib/tell"
import { cn, randomId } from "@/lib/utils"

/** Why a row refuses a seat: a full room says nothing, another Host says what to do about it. */
type Refusal = { kind: "full" } | { kind: "host"; say: string }

/** The fewest and most seats a room may hold: the Host's rule, said before it can be broken. */
const LEAST = 2
const MOST = 6

const OTHER_HOST = "A room holds one Host's bots. Unpick every bot to change Host."

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
  const [picked, setPicked] = useState<string[]>([])
  const [picking, setPicking] = useState(false)
  const [roomId] = useState(() => randomId())
  const [seats, setSeats] = useState<Record<string, RoomMember>>({})
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<string>()

  const chosen = writers.filter((bot) => picked.includes(bot.id))
  const ready = chosen.length >= LEAST && chosen.length <= MOST

  const lockedHost = chosen[0] ? hostKey(chosen[0]) : null

  const refusalFor = (bot: Profile): Refusal | null => {
    if (picked.includes(bot.id)) return null
    // Another Host before the ceiling: at six seats its row must still say the thing a press can act on.
    if (lockedHost && hostKey(bot) !== lockedHost) return { kind: "host", say: OTHER_HOST }
    return picked.length >= MOST ? { kind: "full" } : null
  }

  const toggle = (id: string) => {
    if (picked.includes(id)) {
      setPicked((held) => held.filter((one) => one !== id))
      return
    }
    const bot = writers.find((one) => one.id === id)
    if (!bot) return
    const refusal = refusalFor(bot)
    if (refusal) {
      if (refusal.kind === "host") tell.info(refusal.say)
      return
    }
    // The guards inside the updater too: a press that lands twice in one batch seats one bot once.
    setPicked((held) =>
      held.includes(id) || held.length >= MOST ? held : [...held, id],
    )
  }

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
        // Its name until the Host says otherwise: its seats' own names.
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

      <div data-slot="composer-slot" data-toast-above className={COMPOSER_SLOT}>
        <div className={cn(COLUMN_BOX, "pb-2")}>
          <Button
            variant="outline"
            className="h-11 rounded-full"
            aria-label="Pick the room's bots"
            data-slot="seats-pill"
            onClick={() => setPicking(true)}
          >
            {faces.length ? (
              <RoomFaces
                shown={faces.slice(0, FACES)}
                more={Math.max(0, faces.length - FACES)}
              />
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
      </div>

      <SeatsPicker
        open={picking}
        onOpenChange={setPicking}
        writers={writers}
        refusalFor={refusalFor}
        picked={picked}
        onToggle={toggle}
      />
    </div>
  )
}

/** No Host picker: a roster is one Host's profiles (ADR 0115), so the first seat names the Host. */
function SeatsPicker({
  open,
  onOpenChange,
  writers,
  refusalFor,
  picked,
  onToggle,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  writers: Profile[]
  refusalFor: (bot: Profile) => Refusal | null
  picked: string[]
  onToggle: (id: string) => void
}) {
  return (
    <Popup open={open} onOpenChange={onOpenChange}>
      <PopupContent className="max-h-[90dvh]" toastAbove>
        <PopupHeader className="pb-2">
          <PopupTitle>Room bots</PopupTitle>
        </PopupHeader>
        <div className="flex flex-col gap-4 px-4 pb-4 sm:px-6">
          <p className="text-sm text-muted-foreground">
            Two to six bots of one Host. Who a room holds is fixed when it is made: changing its
            members means making a new room.
          </p>
          {/* The seats are a card of rows, the way Settings lists bots, so picking two reads as the
              same act as reading them there. */}
          <Group>
            {writers.map((bot) => (
              <SeatRow
                key={bot.id}
                bot={bot}
                checked={picked.includes(bot.id)}
                refusal={refusalFor(bot)}
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
  refusal,
  onToggle,
}: {
  bot: Profile
  checked: boolean
  refusal: Refusal | null
  onToggle: () => void
}) {
  // A row that can never be seated this time reads no model: its Host would be asked for one nothing
  // on this screen can use.
  const info = useModelInfo(refusal?.kind === "host" ? null : bot)
  const choice = botModel(bot, info)
  return (
    <button
      type="button"
      aria-pressed={checked}
      // Never `disabled` for another Host's row: that would swallow the press the sentence answers.
      aria-disabled={refusal ? "true" : undefined}
      data-bot={bot.id}
      disabled={refusal?.kind === "full"}
      onClick={onToggle}
      className={cn(
        linkRowClass,
        refusal?.kind === "full" && "cursor-not-allowed",
        // A row that still answers a press keeps the pointer, so cursor and press tell one story.
        refusal?.kind === "host" && "cursor-pointer",
        refusal && "opacity-40",
        checked && "bg-muted",
      )}
    >
      <Bot id={bot.botId} className={cn("size-8 shrink-0", bot.disabled && "opacity-40")} />
      <RowText title={bot.name} subtitle={choice ? fullModel(choice) : bot.model} />
      {checked && <CheckIcon className="size-4 shrink-0" />}
    </button>
  )
}
