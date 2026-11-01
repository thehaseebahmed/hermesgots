/**
 * What a thread's media draws from, as a cell reads it: one state per file — not read yet, drawn,
 * failed, or a host that has no such file — over the answers the media module keeps, and the two ways
 * a file is asked again: a read that failed, and a URL whose signature has run out. A returning app
 * re-mints what it holds that has lapsed, because a page outlives the ten minutes a URL is worth.
 */
import { useEffect, useRef, useState } from "react"

import type { Attachment } from "@/lib/db"
import { mediaSpent } from "@/lib/media-expiry"
import {
  askMediaUrls,
  forgetMediaUrl,
  mediaServer,
  type MediaAsk,
  type MediaUrl,
} from "@/lib/media-url"
import { onReturn } from "@/lib/wake"

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

/** The states a screen draws, and the two ways a file is asked again. */
export interface MediaAsks {
  states: MediaSources
  /** Forgets what was answered for this item's file, and asks the host again. */
  retry: (key: string) => void
  /** Renews this item's URL when the one it draws from has run out, or drops the copy this device
   * kept when that is what failed to draw. A URL still worth drawing from is left alone, and one
   * file is renewed once, so a host that mints spent URLs is not minted at on every failure. */
  renew: (key: string) => void
  /** The bot's own address, which is what this device's copies of its files are keyed by. */
  server?: string
}

/**
 * The paths a thread's media is read from, as one value an effect can compare: a reply streams a
 * chunk at a time and hands this hook a new list every render, and the paths in it are what matter.
 */
const pathsKey = (sources: MediaSource[]) =>
  [...new Set(sources.map((source) => source.path).filter(Boolean))].join("\u0000")

export function useMediaSources(conversationId: string, sources: MediaSource[]): MediaAsks {
  const [answers, setAnswers] = useState<ReadonlyMap<string, MediaAsk>>(new Map())
  const [server, setServer] = useState<string>()
  const [revision, setRevision] = useState(0)
  // Which bot this thread's files belong to: what this device keeps of them is keyed by its address,
  // and a clip's frame is drawn from that key before any URL is asked for.
  useEffect(() => {
    let stale = false
    void mediaServer(conversationId).then((found) => {
      if (!stale && found) setServer(found)
    })
    return () => {
      stale = true
    }
  }, [conversationId])
  // A reply streams a chunk at a time, so this list is rebuilt on every render: what has been
  // answered stays answered, or a file's cell would ask the host again for every token.
  const answered = useRef<{ chat: string; paths: Set<string> }>({
    chat: conversationId,
    paths: new Set(),
  })
  // One renewal per file, so a host that mints spent URLs is not minted at on every failure.
  const renewals = useRef(new Map<string, number>())
  const renewOnce = (path: string) => {
    if ((renewals.current.get(path) ?? 0) > 0) return false
    renewals.current.set(path, 1)
    return true
  }
  // Sets answers aside and asks for them again — a URL that ran out, or a file the reader asked
  // after. Not memoised: a caller builds its sources per render, so a memo here would never hold.
  const askAgain = (paths: string[]) => {
    for (const path of paths) answered.current.paths.delete(path)
    setAnswers((current) => {
      const next = new Map(current)
      for (const path of paths) next.delete(path)
      return next
    })
    // A path set aside is what the ask effect reads, so the revision carries that change to it.
    setRevision((count) => count + 1)
  }
  // Keyed by what the ask is about — the paths, which a filesystem path never holds a NUL in.
  const joined = pathsKey(sources)
  useEffect(() => {
    if (answered.current.chat !== conversationId) {
      answered.current = { chat: conversationId, paths: new Set() }
      renewals.current.clear()
    }
    const settled = answered.current.paths
    const paths = (joined ? joined.split("\u0000") : []).filter((path) => !settled.has(path))
    if (!paths.length) return
    let stale = false
    // One ask per file, shared across the thread, and one read of the bot they belong to: the media
    // module keeps the URL it answered, so a group asks the host once each rather than once per cell.
    void askMediaUrls(conversationId, paths).then((answers) => {
      if (stale) return
      // Only an answer settles a path. One the host couldn't answer for stays unasked, so the next
      // time this thread's media changes it is asked again rather than the cell staying dead.
      paths.forEach((path, i) => {
        if (answers[i].state !== "unanswered") settled.add(path)
        // An answer with a life left is worth renewing again later; one that came back spent keeps
        // its budget, so a host minting spent URLs is not minted at for ever.
        const answer = answers[i]
        if (answer.state === "ready" && (answer.read.copy || !mediaSpent(answer.read.expires)))
          renewals.current.delete(path)
      })
      setAnswers((current) => {
        const next = new Map(current)
        paths.forEach((path, i) => next.set(path, answers[i]))
        return next
      })
    })
    return () => {
      stale = true
    }
  }, [conversationId, joined, revision])

  // Nothing else re-renders the cells when the app comes back, so its own idea of a return is where
  // a URL that ran out while the page was away is noticed. A copy has no signature to outlive.
  useEffect(
    () =>
      onReturn(() => {
        const spent = [...answers]
          .filter(([, answer]) => answer.state === "ready" && mediaSpent(answer.read.expires))
          .map(([path]) => path)
        if (spent.length) askAgain(spent)
      }),
    [answers],
  )

  const pathOf = (key: string) => sources.find((source) => source.key === key)?.path

  const retry = (key: string) => {
    const path = pathOf(key)
    if (!path) return
    renewals.current.delete(path)
    void forgetMediaUrl(conversationId, path)
    askAgain([path])
  }

  const renew = (key: string) => {
    const path = pathOf(key)
    if (!path) return
    const answer = answers.get(path)
    if (!answer || answer.state !== "ready") return
    const read = answer.read
    // A URL still inside its signature is left alone: a file that failed on a live URL is the retry's.
    if (!read.copy && read.expires !== null && !mediaSpent(read.expires)) return
    if (!renewOnce(path)) return
    // A copy, or a URL whose life the host never named, has to be forgotten before it is asked for
    // again; a URL past its signature does not, since the ask answers the copy or mints another.
    if (read.copy || read.expires === null)
      void forgetMediaUrl(conversationId, path).then(() => askAgain([path]))
    else askAgain([path])
  }

  const states = new Map<string, MediaState>()
  for (const source of sources) {
    const answer = source.path ? answers.get(source.path) : undefined
    states.set(source.key, stateOf(source, answer))
  }
  return { states, retry, renew, server }
}

/** A message's attachments as the thread draws them: each from the URL the host signs for it. */
export function attachmentSources(attachments: Attachment[]): MediaSource[] {
  return attachments.map((attachment) => ({ key: attachment.id, path: attachment.path }))
}
