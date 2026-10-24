import { useEffect, useState } from "react"

import type { Attachment } from "@/lib/db"
import { loadMediaImage } from "@/lib/media-tags"

/**
 * One piece of media the thread draws: where its bytes are, and — once they are in — where the
 * thread can read them. A path and no local bytes is a device that never held the file, or a
 * message restored from the transcript, so the host's media route fills it in.
 */
export interface MediaSource {
  /** Stable within the message: an attachment's id, or the path a tag names. */
  key: string
  /** Where the file lies on the host. */
  path?: string
  /** The browser's own handle on bytes this device holds, which is never asked of the host. */
  local?: string
}

/**
 * What each source draws from: this device's own copy, else what the host answered — null where it
 * can't be read at all, undefined while the read is still out. A source that starts with nothing to
 * read answers null at once, so a caller can draw it some other way rather than waiting.
 */
export type MediaSources = ReadonlyMap<string, string | null | undefined>

export function useMediaSources(conversationId: string, sources: MediaSource[]): MediaSources {
  const [host, setHost] = useState<MediaSources>(new Map())
  // The list is rebuilt on every render, so the read is keyed by what it would ask for — the paths,
  // which a filesystem path never holds a line break in.
  const joined = [
    ...new Set(
      sources
        .filter((source) => !source.local && source.path)
        .map((source) => source.path as string),
    ),
  ].join("\n")
  useEffect(() => {
    const paths = joined ? joined.split("\n") : []
    if (!paths.length) return
    let stale = false
    // One read per file, shared across the thread: a reply streaming in re-renders constantly.
    void Promise.all(paths.map((path) => loadMediaImage(conversationId, path))).then((read) => {
      if (stale) return
      setHost((current) => {
        const next = new Map(current)
        paths.forEach((path, i) => next.set(path, read[i]))
        return next
      })
    })
    return () => {
      stale = true
    }
  }, [conversationId, joined])

  const resolved = new Map<string, string | null | undefined>()
  for (const source of sources)
    resolved.set(source.key, source.local ?? (source.path ? host.get(source.path) : null))
  return resolved
}

/** A message's attachments as the thread draws them, with the copy this device holds where it has one. */
export function attachmentSources(
  attachments: Attachment[],
  local: (attachment: Attachment) => string | undefined,
): MediaSource[] {
  return attachments.map((attachment) => ({
    key: attachment.id,
    path: attachment.path,
    local: local(attachment),
  }))
}
