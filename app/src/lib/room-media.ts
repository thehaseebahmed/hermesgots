/**
 * A room's media, drawn through the chat's own cache and the plugin's signed address (F5).
 *
 * The bytes are the Host's room store's and nothing of them is kept here: a cell is drawn from a URL
 * the plugin signs over the room, the event and the file, and an address whose signature has run out
 * is another's to mint. What this device keeps of a picture is the chat's copy (`media-cache.ts`),
 * filed under the one path a room's file has — `roomAttachmentPath`, the same string the plugin signs
 * — so a room's cell draws from that copy with no mint and no network, and the Gallery's own
 * `rememberMedia` fills it after a paint.
 *
 * The renewal and retry machinery is not here: a screen hands this asker to `useMediaSources`, which
 * holds a file's four states and the two ways it is asked again.
 */
import { useCallback, useMemo } from "react"

import type { RoomAttachment } from "@/lib/db"
import { HermesError, getRoomAttachmentUrl, type HermesConfig } from "@/lib/hermes"
import { cachedMedia } from "@/lib/media-cache"
import { useMediaSources, type MediaAsks } from "@/lib/media-source"
import type { MediaAsk } from "@/lib/media-url"
import { noteFailure } from "@/lib/report"

/**
 * The path a room's file is known by: the room, the message that carried it and the file, which is
 * exactly what the plugin's signature covers. A device's copy of the file is keyed by it, so the
 * same photo is drawn from the cache after a reload as it was before one.
 */
export function roomAttachmentPath(roomId: string, eventId: string, attachmentId: string): string {
  return `room/${roomId}/${eventId}/${attachmentId}`
}

/**
 * What one of a room row's files draws from: the copy this device holds first, and the address the
 * plugin signs for the room, the event and the file otherwise.
 *
 * An answer settles a file or it doesn't. A 404 is a route or a file that isn't there, which no later
 * ask turns up, so it is `gone` — as `media-url.ts` settles it — and the row draws nothing rather
 * than a row that can never fill. A 403 is a refusal about the address rather than the file: another
 * can be signed on the next draw, so it stays unanswered and is asked again. Anything else is a host
 * that didn't answer, which is no claim at all; it is noted here and left unanswered too, so the file
 * is asked again with the next fold rather than dimming its row for ever in silence. The refusal a
 * reader meets over a file is the upload's, which already reaches the room's banner.
 *
 * `config` is the Host the files belong to, which is what this device's copies are keyed by: a room's
 * records may be carried onto this device by one bot of a Host and answered by another member of it,
 * and both are the same Host.
 */
export function useRoomMedia(
  roomId: string,
  config: HermesConfig,
  eventId: string,
  attachments: RoomAttachment[],
): MediaAsks & { files: (RoomAttachment & { eventId: string })[] } {
  // The row is the attachments and the message they were committed under, which is what their
  // address is signed over: folded once, so a list that says the same thing is the same files.
  const files = useMemo(
    () => attachments.map((attachment) => ({ ...attachment, eventId })),
    [attachments, eventId],
  )
  const byPath = useMemo(() => {
    const found = new Map<string, RoomAttachment & { eventId: string }>()
    for (const file of files)
      found.set(roomAttachmentPath(roomId, file.eventId, file.attachmentId), file)
    return found
  }, [roomId, files])
  const ask = useCallback(
    async (paths: string[]): Promise<MediaAsk[]> =>
      Promise.all(
        paths.map(async (path): Promise<MediaAsk> => {
          const held = await cachedMedia(config.baseUrl, path)
          if (held) return { state: "ready", read: { ...held, expires: null, copy: true } }
          const file = byPath.get(path)
          if (!file) return { state: "unanswered" }
          try {
            const signed = await getRoomAttachmentUrl(
              config,
              roomId,
              file.eventId,
              file.attachmentId,
            )
            return {
              state: "ready",
              read: { url: signed.url, type: file.mime, size: file.size, expires: signed.expires },
            }
          } catch (error) {
            if (error instanceof HermesError && error.status === 404) return { state: "gone" }
            noteFailure(`asking for the address of ${path}`, error)
            return { state: "unanswered" }
          }
        }),
      ),
    [roomId, config, byPath],
  )
  const sources = useMemo(
    () =>
      files.map((file) => ({
        key: file.attachmentId,
        path: roomAttachmentPath(roomId, file.eventId, file.attachmentId),
      })),
    [roomId, files],
  )
  // The Host is this connection's own, so the hook is told it rather than reading the conversation
  // and its bot for an address the row already has in hand.
  const asks = useMediaSources(roomId, sources, { ask, server: config.baseUrl })
  return { ...asks, files }
}
