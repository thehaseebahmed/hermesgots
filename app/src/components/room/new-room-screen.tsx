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

/** The fewest and most seats a room may hold: the Host's rule, said before it can be broken. */
const LEAST = 2
const MOST = 6

/** What a press on another Host's row says, since a row that greys and then does nothing reads broken. */
const OTHER_HOST = "A room holds one Host's bots. Unpick the first bot to change Host."

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

  // The Host is named by the first bot the room holds, and only by a bot it still holds: a room's
  // roster is one gateway's profiles (ADR 0115), and every bot that answers at another address greys
  // out while one is seated. Reading it off `chosen` is what keeps the lock on a bot this device can
  // still seat, rather than on an id that may have left the list.
  const lockedHost = chosen[0] ? hostKey(chosen[0]) : null

  /**
   * Why a bot cannot take a seat right now, or null when it can: one rule for what the row draws and
   * what a press answers, so the two cannot drift apart.
   */
  const blockedFor = (bot: Profile): "full" | "host" | null => {
    if (picked.includes(bot.id)) return null
    if (picked.length >= MOST) return "full"
    return lockedHost && hostKey(bot) !== lockedHost ? "host" : null
  }

  /**
   * A seat toggles on and off. Another Host's bot stays pressable and answers with the one sentence
   * saying how to change Host, since a row that greys out and then does nothing reads as a broken app;
   * the seventh tap keeps the silence it always had.
   */
  const toggle = (id: string) => {
    if (picked.includes(id)) {
      setPicked((held) => held.filter((one) => one !== id))
      return
    }
    const bot = writers.find((one) => one.id === id)
    if (!bot) return
    if (blockedFor(bot) === "host") {
      tell.info(OTHER_HOST)
      return
    }
    if (blockedFor(bot)) return
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

      <div data-slot="composer-slot" data-toast-above className={COMPOSER_SLOT}>
        <div className={cn(COLUMN_BOX, "pb-2")}>
          <Button
            variant="outline"
            className="h-10 rounded-full"
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
        blockedFor={blockedFor}
        picked={picked}
        onToggle={toggle}
      />
    </div>
  )
}

/**
 * The seats a room is made of: every bot this device may seat, a check per seat, and the rule the Host
 * keeps.
 *
 * One Host at a time, because a roster is one Host's profiles (ADR 0115), and no Host picker: the
 * first bot seated names the Host, and until one is seated every row is a choice. The most is a
 * ceiling rather than a refusal — the seventh tap does nothing — so the rule is felt while picking
 * and not only said after.
 */
function SeatsPicker({
  open,
  onOpenChange,
  writers,
  blockedFor,
  picked,
  onToggle,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  writers: Profile[]
  /** Why a row cannot take a seat, from the screen's one rule: `full`, `host`, or null for a seat. */
  blockedFor: (bot: Profile) => "full" | "host" | null
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
                blocked={blockedFor(bot)}
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
 *
 * A row greys for one of two reasons: the room already holds the most it may, or the bot answers at
 * another Host than the one its first seat named. Only the second still hears the press: a full room's
 * seventh tap has always done nothing, and keeps doing it.
 */
function SeatRow({
  bot,
  checked,
  blocked,
  onToggle,
}: {
  bot: Profile
  checked: boolean
  /** Why this row cannot take a seat, from the screen's one rule. */
  blocked: "full" | "host" | null
  onToggle: () => void
}) {
  // A row that can never be seated this time reads no model: its Host would be asked for one nothing
  // on this screen can use.
  const info = useModelInfo(blocked === "host" ? null : bot)
  const choice = botModel(bot, info)
  return (
    <button
      type="button"
      aria-pressed={checked}
      // Never `disabled` for another Host's row: that would swallow the press the sentence answers.
      aria-disabled={blocked ? "true" : undefined}
      data-bot={bot.id}
      disabled={blocked === "full"}
      onClick={onToggle}
      className={cn(
        linkRowClass,
        blocked && "cursor-not-allowed opacity-40",
        checked && "bg-muted",
      )}
    >
      <Bot id={bot.botId} className={cn("size-8 shrink-0", bot.disabled && "opacity-40")} />
      <RowText title={bot.name} subtitle={choice ? fullModel(choice) : bot.model} />
      {checked && <CheckIcon className="size-4 shrink-0" />}
    </button>
  )
}
