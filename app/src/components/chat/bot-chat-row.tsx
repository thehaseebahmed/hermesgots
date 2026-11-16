/**
 * One row of a bot's chat list: a chat's icon — every row here is the same bot's, so the bot's face
 * would say nothing — its title, the bot's last word, its age, and the dot this device's read mark
 * decides. The row of the chat drawn beside the list is marked as the one open, as Code's list marks
 * its own.
 *
 * The icon says what is happening, in the three states Code's rows use: a chat at rest is grey, the
 * app's own colour for nothing to say; a run in flight — the host's answer, else a reply this device
 * still watches arrive — is a spinner, so a list of quiet rows shows the one that is working; and a
 * row that waits on the reader takes the alert icon in the warning tone, with the reason in place of
 * the line. Yellow is spent on the one thing that wants the reader, never on nothing happening.
 *
 * A routine's delivery is a row of this list too, and wears the routine's icon rather than a chat's,
 * because it is a run rather than a chat with the bot: its line and time are the record's, since
 * the run's words are in the run's own session.
 *
 * A room is one of these rows, drawn by the same rule: it wears its members' pictures where a chat
 * wears its icon and says the last message received in it, and while its own log ends asking the
 * reader for something its line is that sentence, in the warning tone, because the line is where the
 * room's own screen says it too (ADR 0115, ADR 0126).
 *
 * The link names the bot it is a chat of, so the shell keeps the list's lane while the row loads.
 */
import { CircleAlertIcon, MessageCircleIcon, RotateCcwClockIcon } from "lucide-react"

import { ItemRow, pinnedLine } from "@/components/item-list"
import { RoomFaces } from "@/components/room/room-faces"
import { Spinner } from "@/components/ui/spinner"
import { chatAge, type ChatListRow } from "@/lib/chat-list"
import type { LiveRunStatus } from "@/lib/hermes"
import { isUnread, runInFlight } from "@/lib/session-work"

export function BotChatRow({
  row,
  now,
  mark,
  selected,
  profileId,
  replace,
  live,
}: {
  row: ChatListRow
  now: number
  mark?: number
  selected?: boolean
  profileId: string
  /** Whether the press takes the place of an item already beside the list, rather than stepping onto it. */
  replace?: boolean
  /** What the host says of this chat's run: `running` beats a reply still streaming here. */
  live?: LiveRunStatus
}) {
  const working = runInFlight(live, { streaming: row.streaming, waiting: Boolean(row.needs) })
  return (
    <ItemRow
      icon={
        row.routine ? (
          <RotateCcwClockIcon />
        ) : row.needs ? (
          <CircleAlertIcon />
        ) : working ? (
          <Spinner />
        ) : (
          <MessageCircleIcon />
        )
      }
      avatar={
        row.room ? (
          <RoomFaces shown={row.room.shown} more={row.room.more} label={row.room.names} />
        ) : undefined
      }
      tone={row.room ? undefined : row.needs ? "warning" : "muted"}
      unread={isUnread(row.at, mark)}
      selected={selected}
      title={row.title}
      when={chatAge(row.at, now)}
      line={pinnedLine(row.pinned, row.needs ?? row.line)}
      warn={Boolean(row.needs)}
      link={{
        to: `/c/${row.id}`,
        state: { bot: profileId },
        replace,
      }}
    />
  )
}
