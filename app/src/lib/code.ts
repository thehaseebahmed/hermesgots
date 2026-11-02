import { useCallback, useEffect, useRef } from "react"
import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"

import { connectionKey } from "@/lib/connection"
import { db, listReachableProfiles, type Conversation, type Profile } from "@/lib/db"
import { tellCloseReports } from "@/lib/close-reports"
import type { HermesProject } from "@/lib/hermes"
import {
  CLOSE_REPORT_GAP_MS,
  CLOSE_REPORT_MS,
  PR_PENDING_MS,
  SESSION_REREAD_MS,
  TAIL_MS,
} from "@/lib/freshness"
import { useAnyChange } from "@/lib/live"
import { usePoll } from "@/lib/poll"
import { prChecksPending, refreshPrs, refreshWorkspace } from "@/lib/workspace"
import { cachedTail, needsTailRead, rememberTail } from "@/lib/session-tail"
import type { LocalTurn } from "@/lib/session-work"

/** A project by its server and id: bots on one server share its projects. */
export const projectKey = (server: { baseUrl: string; apiKey: string }, projectId: string) =>
  `${connectionKey(server)}\n${projectId}`

/**
 * One read of every listed session's row, and the bots those rows belong to. The rows and their
 * tails are two queries rather than one: a streaming reply writes a message row every flush and
 * touches no conversation, so a shared read would re-scan every conversation on each of those.
 */
interface Listed {
  rows: Conversation[]
  profiles: Map<string, Profile>
  now: number
}

/** The newest assistant row of a session: whether one is streaming, and whether one is waiting. */
async function readTail(id: string): Promise<LocalTurn | undefined> {
  const tail = await db.messages
    .where("[conversationId+createdAt]")
    .between([id, Dexie.minKey], [id, Dexie.maxKey])
    .reverse()
    .until((m) => m.role === "assistant", true)
    .toArray()
  if (!tail.length) return undefined
  return {
    streaming: tail.some((m) => m.status === "streaming"),
    waiting: tail.some(
      (m) => (m.approval && !m.approval.resolved) || (m.clarify && !m.clarify.resolved),
    ),
  }
}

/**
 * Project sessions across every bot that isn't turned off (or one project's, by its key), newest
 * first, with what this device sees of their turns. Only a reply in flight can carry an approval or
 * question (a finished turn expires them), and it's the newest reply, so each session's messages are
 * read back only as far as that, past any queued after it — and only while its tail can still move
 * (`needsTailRead`).
 *
 * `tails` is off for a screen that wants the rows alone: the pane deciding which session to open
 * reads no transcripts, since the list beside it reads those for the rows it draws.
 */
export function useProjectSessions(only?: string, { tails: readTails = true } = {}) {
  const listed = useLiveQuery(async (): Promise<Listed> => {
    // Neither read needs the other, and both stand between the screen and its first row.
    const [profiles, conversations] = await Promise.all([
      db.profiles.toArray(),
      db.conversations.where("projectId").above("").toArray(),
    ])
    const enabled = new Map(profiles.filter((p) => !p.disabled).map((p) => [p.id, p]))
    const rows = conversations
      .filter((c) => {
        const profile = enabled.get(c.profileId)
        return profile && (!only || projectKey(profile, c.projectId!) === only)
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return { rows, profiles: enabled, now: Date.now() }
  }, [only])

  const local = useLiveQuery(async () => {
    if (!listed || !readTails) return undefined
    const now = Date.now()
    const moved = listed.rows.filter((c) =>
      needsTailRead(cachedTail(c.id), c.updatedAt, now, TAIL_MS),
    )
    await Promise.all(
      moved.map(async (c) =>
        rememberTail(c.id, { rowAt: c.updatedAt, readAt: now, turn: await readTail(c.id) }),
      ),
    )
    const turns: Record<string, LocalTurn> = {}
    for (const c of listed.rows) {
      const turn = cachedTail(c.id)?.turn
      if (turn) turns[c.id] = turn
    }
    return turns
  }, [listed, readTails])

  if (!listed || (readTails && !local)) return undefined
  const turns = local ?? {}
  // A session nothing was sent in (or typed for) isn't one yet. Synced ones carry their activity in
  // `updatedAt`, since their messages load only when opened.
  const sessions = listed.rows.filter(
    (c) => c.draftAt || c.updatedAt > c.createdAt || Boolean(turns[c.id]),
  )
  return { rows: listed.rows, sessions, local: turns, profiles: listed.profiles, now: listed.now }
}

/**
 * A session's PRs are read when it's open; this reads them for every listed session as the screen
 * opens, its worktree first when this device hasn't seen it (a session started elsewhere). While the
 * screen stays open it reads both again, at most every minute, as the sessions change, so a plan
 * approved or a pull request opened on another device shows here too. While any has checks running
 * it reads its pull requests every few seconds, so the rows keep up with the pill; the open
 * session's own chat does that for itself.
 */
export function useSessionFollowUps(sessions: Conversation[] | undefined, open?: string) {
  const read = useRef(new Map<string, number>())
  useEffect(() => {
    const now = Date.now()
    for (const c of sessions ?? []) {
      const last = read.current.get(c.id)
      if (last !== undefined && now - last < SESSION_REREAD_MS) continue
      read.current.set(c.id, now)
      const workspace = !c.worktree || last !== undefined
      void (workspace ? refreshWorkspace(c.id) : Promise.resolve()).then(() => {
        void refreshPrs(c.id)
      })
    }
  }, [sessions])
  const runningChecks = (sessions ?? []).filter((c) => c.id !== open && prChecksPending(c.prs))
  // Forced, so the freshness gate doesn't skip a tick that lands just inside its window.
  usePoll(
    () => {
      for (const c of runningChecks) void refreshPrs(c.id, { force: true })
    },
    PR_PENDING_MS,
    [],
    { active: runningChecks.length > 0, immediate: false, onShow: false },
  )
}

const names = new Intl.ListFormat(undefined, { type: "conjunction" })

/** Why a project can't take a new session right now, if it can't. */
export function startBlocked(project: HermesProject) {
  if (project.archived) return "Archived"
  // While a repo is still being cloned a session would start without it.
  const adding = project.folders.flatMap((f) => (f.status === "cloning" && f.repo ? [f.repo] : []))
  if (adding.length) return `Adding ${names.format(adding)}`
  // A session spans every repo of the project; without one there's nowhere for it to work.
  if (!project.folders.some((folder) => folder.git)) return "No repositories"
  return undefined
}

/**
 * Tells the close reports a bot has ended that this device holds no mark for (ADR 0080). A close is
 * the host's work, so the device that asked may never have heard the end — it was put away, or the
 * close outlived the dialog — and the device that asked may not be this one at all. Read as Code
 * opens, when the stream says a close ended, and on a slow timer, since no other screen asks.
 */
export function useCloseReports() {
  const changed = useAnyChange("closes")
  const last = useRef(0)
  const read = useCallback(async () => {
    const now = Date.now()
    if (now - last.current < CLOSE_REPORT_GAP_MS) return
    last.current = now
    const bots = await listReachableProfiles()
    await Promise.all(bots.map((bot) => tellCloseReports(bot)))
  }, [])
  usePoll(read, CLOSE_REPORT_MS)
  useEffect(() => {
    // The poll above ran once on mount; this is the stream's own word, not a second read of it.
    if (changed) void read()
  }, [changed, read])
}
