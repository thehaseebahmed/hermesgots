import { useEffect, useRef, useState } from "react"

import type { Attachment } from "@/lib/db"
import { askMediaUrl, forgetMediaUrl, type MediaAsk, type MediaUrl } from "@/lib/media-url"

/**
 * One piece of media the thread draws: where the host keeps it. A file the host was never given —
 * a composer's own tile — is not drawn through here at all.
 */
export interface MediaSource {
  /** Stable within the message: an attachment's id, or the path a tag names. */
  key: string
  /** Where the file lies on the host. */
  path?: string
}

/** What the host answered for a path: the URL it signed, and what the file is. */
export type MediaRead = MediaUrl

/**
 * What a source draws from: a URL that is in, a read still out, a read that failed and can be
 * asked again, or a host that says it has no such file. Only the last is drawn as absence.
 */
export type MediaState =
  | { status: "reading" }
  | { status: "ready"; read: MediaRead }
  | { status: "failed"; note?: string }
  | { status: "gone" }

export type MediaSources = ReadonlyMap<string, MediaState>

/** The URL a source draws from, where it is in. */
export const mediaRead = (state?: MediaState) =>
  state?.status === "ready" ? state.read : undefined

/**
 * What one source draws from, from where the host's answer stands: nothing to read at all, one
 * still out, the URL it signed, or a read that failed and can be asked again.
 */
function stateOf(source: MediaSource, answer: MediaAsk | null | undefined): MediaState {
  if (!source.path || answer?.state === "gone") return { status: "gone" }
  if (!answer) return { status: "reading" }
  if (answer.state === "ready") return { status: "ready", read: answer.read }
  return answer.state === "refused" ? { status: "failed", note: answer.note } : { status: "failed" }
}

/** The states a screen draws, and the one way to ask a failed file again. */
export interface MediaAsks {
  states: MediaSources
  /** Forgets what was answered for this item's file, and asks the host again. */
  retry: (key: string) => void
}

/**
 * The paths a thread's media is read from, as one value an effect can compare: a reply streams a
 * chunk at a time and hands this hook a new list every render, and the paths in it are what matter.
 */
const pathsKey = (sources: MediaSource[]) =>
  [...new Set(sources.map((source) => source.path).filter(Boolean))].join("\n")

export function useMediaSources(conversationId: string, sources: MediaSource[]): MediaAsks {
  const [host, setHost] = useState<ReadonlyMap<string, MediaAsk>>(new Map())
  const [revision, setRevision] = useState(0)
  // A reply streams a chunk at a time, so this list is rebuilt on every render: what has been
  // answered stays answered, or a file's cell would ask the host again for every token.
  const answered = useRef<{ chat: string; paths: Set<string> }>({
    chat: conversationId,
    paths: new Set(),
  })
  // Keyed by what the ask is about — the paths, which a filesystem path never holds a line break in.
  const joined = pathsKey(sources)
  useEffect(() => {
    if (answered.current.chat !== conversationId)
      answered.current = { chat: conversationId, paths: new Set() }
    const settled = answered.current.paths
    const paths = (joined ? joined.split("\n") : []).filter((path) => !settled.has(path))
    if (!paths.length) return
    let stale = false
    // One ask per file, shared across the thread: the media module keeps the URL it answered.
    void Promise.all(paths.map((path) => askMediaUrl(conversationId, path))).then((answers) => {
      if (stale) return
      // Only an answer settles a path. One the host couldn't answer for stays unasked, so the next
      // time this thread's media changes it is asked again rather than the cell staying dead.
      paths.forEach((path, i) => {
        if (answers[i].state !== "unanswered") settled.add(path)
      })
      setHost((current) => {
        const next = new Map(current)
        paths.forEach((path, i) => next.set(path, answers[i]))
        return next
      })
    })
    return () => {
      stale = true
    }
  }, [conversationId, joined, revision])

  // Not memoised on purpose: a caller builds its sources per render, so a memo here would never hold.
  const retry = (key: string) => {
    const path = sources.find((source) => source.key === key)?.path
    if (!path) return
    answered.current.paths.delete(path)
    setHost((current) => {
      const next = new Map(current)
      next.delete(path)
      return next
    })
    void forgetMediaUrl(conversationId, path)
    setRevision((count) => count + 1)
  }

  const states = new Map<string, MediaState>()
  for (const source of sources) {
    const answer = source.path ? host.get(source.path) : undefined
    states.set(source.key, stateOf(source, answer))
  }
  return { states, retry }
}

/** A message's attachments as the thread draws them: each from the URL the host signs for it. */
export function attachmentSources(attachments: Attachment[]): MediaSource[] {
  return attachments.map((attachment) => ({ key: attachment.id, path: attachment.path }))
}
