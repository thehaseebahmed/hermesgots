/**
 * Whether a bot has a row this device has not read, other than the one on screen. A reader sitting in
 * one chat cannot see the bot's list, so the control that opens it says when something there wants
 * them (ADR 0144).
 *
 * The rule is the list's own — a row's record moved past this device's read mark — over the rows that
 * list draws: the bot's own chats, and every room its roster seats. A chat this device has never
 * opened holds no mark and so is not unread, exactly as its row draws no dot.
 */
import { useLiveQuery } from "dexie-react-hooks"

import { conversationsOf } from "./db"
import { listsAsChat } from "./lists-as-chat"
import { useReadMarks } from "./read-marks"
import { useRoomNeeds } from "./room"
import { isUnread } from "./session-work"

export function useUnreadElsewhere(profileId: string | undefined, open: string | undefined) {
  const marks = useReadMarks()
  const chats = useLiveQuery(
    async () => (profileId ? (await conversationsOf(profileId).toArray()).filter(listsAsChat) : []),
    [profileId],
  )
  const rooms = useRoomNeeds()
  const chat = (chats ?? []).some(
    (one) => one.id !== open && isUnread(one.updatedAt, marks[one.id]),
  )
  const room = (rooms ?? []).some(
    (row) =>
      Boolean(profileId) &&
      row.seated.includes(profileId!) &&
      row.chat.id !== open &&
      isUnread(row.chat.updatedAt, marks[row.chat.id]),
  )
  return chat || room
}
