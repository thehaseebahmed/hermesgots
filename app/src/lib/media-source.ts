import { useEffect, useRef, useState } from "react"

import type { Attachment } from "@/lib/db"
import { askMediaFile } from "@/lib/media-tags"

/**
 * One piece of media the thread draws: where its bytes are, or where the host keeps them — which is
 * the case for another device's file and for a message restored from the transcript.
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

/** What a source draws from: its bytes, a read still out, or nothing to read at all. */
export type MediaState =
  { status: "ready"; read: MediaRead } | { status: "reading" } | { status: "empty" }

export type MediaSources = ReadonlyMap<string, MediaState>

/** The bytes a source draws from, where they are in. */
export const mediaRead = (state?: MediaState) =>
  state?.status === "ready" ? state.read : undefined

export function useMediaSources(conversationId: string, sources: MediaSource[]): MediaSources {
  const [host, setHost] = useState<ReadonlyMap<string, MediaRead | null>>(new Map())
  // A reply streams a chunk at a time, so this list is rebuilt on every render: what has been
  // answered stays answered, or a tag's cell would ask the route again for every token.
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
    // One read per file, shared across the thread: the route caches what it has served.
    void Promise.all(paths.map((path) => askMediaFile(conversationId, path))).then((answers) => {
      if (stale) return
      // Only an answer settles a path. One the host couldn't answer for stays unasked, so the next
      // time this thread's media changes it is asked again rather than the tag staying dead.
      paths.forEach((path, i) => {
        if (answers[i].answered) asked.add(path)
      })
      setHost((current) => {
        const next = new Map(current)
        paths.forEach((path, i) => next.set(path, answers[i].file))
        return next
      })
    })
    return () => {
      stale = true
    }
  }, [conversationId, joined])

  const resolved = new Map<string, MediaState>()
  for (const source of sources) {
    const read = source.local ? { url: source.local } : source.path ? host.get(source.path) : null
    const state: MediaState =
      read === null
        ? { status: "empty" }
        : read === undefined
          ? { status: "reading" }
          : { status: "ready", read }
    resolved.set(source.key, state)
  }
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
