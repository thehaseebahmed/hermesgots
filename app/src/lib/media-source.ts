import { useEffect, useRef, useState } from "react"

import type { Attachment } from "@/lib/db"
import { loadMediaFile } from "@/lib/media-tags"

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

/** What the host answered for a path: where the thread reads it, and what it is. */
export interface MediaRead {
  url: string
  /** The type the route served; a tag asks what its file is, and a path alone can't say. */
  type?: string
  /** Its size, where the route said — a message that sent the file keeps its own. */
  size?: number
}

/**
 * What each source draws from: this device's own copy, else what the host answered — null where it
 * can't be read at all, undefined while the read is still out. A source that starts with nothing to
 * read answers null at once, so a caller can draw it some other way rather than waiting.
 */
export type MediaSources = ReadonlyMap<string, MediaRead | null | undefined>

export function useMediaSources(conversationId: string, sources: MediaSource[]): MediaSources {
  const [host, setHost] = useState<ReadonlyMap<string, MediaRead | null>>(new Map())
  // A reply streams a chunk at a time, so this list is rebuilt on every render. What has already
  // been answered stays answered, and only what arrived since is asked for: otherwise a tag's cell
  // would go back to the route for every token the reply lands.
  const answered = useRef<{ chat: string; paths: Set<string> }>({
    chat: conversationId,
    paths: new Set(),
  })
  // Keyed by what the read would ask for — the paths, which a filesystem path never holds a line
  // break in.
  const joined = [
    ...new Set(
      sources
        .filter((source) => !source.local && source.path)
        .map((source) => source.path as string),
    ),
  ].join("\n")
  useEffect(() => {
    if (answered.current.chat !== conversationId)
      answered.current = { chat: conversationId, paths: new Set() }
    const asked = answered.current.paths
    const paths = (joined ? joined.split("\n") : []).filter((path) => !asked.has(path))
    if (!paths.length) return
    let stale = false
    // One read per file, shared across the thread: the route's own cache has the bytes of a path it
    // has already served, so a group of tags costs one read each however often the thread redraws.
    void Promise.all(paths.map((path) => loadMediaFile(conversationId, path))).then((read) => {
      if (stale) return
      for (const path of paths) asked.add(path)
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

  const resolved = new Map<string, MediaRead | null | undefined>()
  for (const source of sources)
    resolved.set(
      source.key,
      source.local ? { url: source.local } : source.path ? host.get(source.path) : null,
    )
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
