/**
 * One room row's files, drawn by the chat's own Gallery: a photo or a clip in a cell, a recording or
 * a document in its own row, and a tap that opens the app's Previewer (ADR 0111, F5).
 *
 * A room's file has no path on the Host's filesystem — the bytes live in the room store, bound to the
 * message that carried them — so a cell is drawn from the address the plugin signs for the room, the
 * event and the file (`useRoomMedia`), and a file the Previewer can't draw is handed to the platform
 * with an address minted at the tap: the one the row drew from was signed when the room opened, and a
 * row outlives the minutes a signature is worth.
 */
import { MediaItems, type MediaItem } from "@/components/chat/media-gallery"
import { openAttachment } from "@/lib/attachments"
import type { RoomAttachment } from "@/lib/db"
import { getRoomAttachmentUrl, type HermesConfig } from "@/lib/hermes"
import { mediaItems } from "@/lib/media-items"
import { roomAttachmentPath, useRoomMedia } from "@/lib/room-media"

export function RoomRowMedia({
  roomId,
  eventId,
  attachments,
  config,
  align,
}: {
  roomId: string
  /** The message the Host committed these files to, which is what their address is signed over. */
  eventId: string
  attachments: RoomAttachment[]
  config: HermesConfig
  align: "start" | "end"
}) {
  // The row's files, their states and the two ways one is asked again, folded by the hook the address
  // is signed through; `server` is the Host this device's copies of them are keyed by.
  const { files, states, retry, renew, server } = useRoomMedia(roomId, config, eventId, attachments)
  const items = mediaItems(
    files.map((file) => ({
      key: file.attachmentId,
      // The stable key the signed address and this device's copy are both filed under.
      path: roomAttachmentPath(roomId, file.eventId, file.attachmentId),
      name: file.name,
      type: file.mime,
      size: file.size,
    })),
    states,
  )
  const download = (item: MediaItem) => {
    const file = files.find((one) => one.attachmentId === item.key)
    if (!file) return
    // A fresh address, minted where the tap is: the signature this row drew from is worth about ten
    // minutes, and a reader may tap a file long after the room's screen opened. A mint that can't be
    // had falls back to the address the row drew from, where it has one.
    const handover = (src?: string) =>
      openAttachment(null, { name: file.name, type: file.mime, ...(src ? { src } : {}) })
    void getRoomAttachmentUrl(config, roomId, eventId, file.attachmentId).then(
      (fresh) => handover(fresh.url),
      () => handover(item.src),
    )
  }
  return (
    <MediaItems
      items={items}
      server={server}
      align={align}
      onDownload={download}
      onRetry={(item) => retry(item.key)}
      onRefresh={(item) => renew(item.key)}
    />
  )
}
