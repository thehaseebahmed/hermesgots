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
  LIST_MS,
  PR_PENDING_MS,
  SAFETY_MS,
  SESSION_REREAD_MS,
  TAIL_MS,
} from "@/lib/freshness"
import { awaitsStream, useAllLive, useAnyChange } from "@/lib/live"
import { useAllLiveRuns, useWaiting } from "@/lib/waiting"
import { usePoll } from "@/lib/poll"
import { closedSession } from "@/lib/session-work"
import { quietly } from "@/lib/report"
import { prChecksPending, refreshPrsOf, refreshWorkspaces } from "@/lib/workspace"
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
    // A closed session has no turn left to keep up with; its own screen reads it when opened.
    const moved = listed.rows.filter(
      (c) => !closedSession(c) && needsTailRead(cachedTail(c.id), c.updatedAt, now, TAIL_MS),
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
 * screen stays open it reads them again on its own timer and as the page comes back to the
 * foreground, so a pull request opened or merged elsewhere shows here too.
 *
 * A session's workspace — its mode, and whether a plan waits — is read again when the host's own
 * account of its run moves (`runs/live`, which every screen already shares): a run that ended or a
 * wait that came or went is when a plan appears or is settled, and when a pull request is most
 * likely to have been opened, so that row is read at once rather than at the next tick. Where a
 * bot's server streams its changes that is the whole of it; a bot that is only polled has its rows'
 * workspaces read on the timer as well, as a net.
 *
 * While any session has checks running it reads its pull requests every few seconds, so the rows
 * keep up with the pill; the open session's own chat does that, and its turn's own reads, for itself.
 */
export function useSessionFollowUps(sessions: Conversation[] | undefined, open?: string) {
  const live = useAllLiveRuns()
  const waits = useWaiting()
  const rows = (sessions ?? []).filter((c) => !closedSession(c))
  const latest = useRef(rows)
  useEffect(() => {
    latest.current = rows
  })
  /** When each row's workspace was last asked for here. */
  const read = useRef(new Map<string, number>())

  // The rows as the reads see them: which sessions are listed, and which have a worktree to read a
  // branch from. A live query hands back new rows on every write, so the effect keys on this.
  const listed = rows.map((c) => `${c.id}:${c.worktree ? 1 : 0}`).join()
  const started = useRef(new Set<string>())
  useEffect(() => {
    const ready: string[] = []
    const late: string[] = []
    for (const c of latest.current) {
      const key = `${c.id}:${c.worktree ? 1 : 0}`
      if (started.current.has(key)) continue
      started.current.add(key)
      if (c.worktree) ready.push(c.id)
      // A worktree that has just arrived came from the read below, which reads its pull requests.
      else if (!started.current.has(`${c.id}:1`)) late.push(c.id)
    }
    // One read for every row this device can read now; a bot whose plugin predates the batch
    // answers them one at a time from inside `refreshPrsOf`.
    if (ready.length) void refreshPrsOf(ready).catch(quietly("Reading sessions' pull requests"))
    if (late.length) {
      const now = Date.now()
      for (const id of late) read.current.set(id, now)
      // Their worktrees aren't here yet, so there is no branch to read until the host names one.
      void refreshWorkspaces(late)
        .then(() => refreshPrsOf(late))
        .catch(quietly("Reading sessions' pull requests"))
    }
  }, [listed])

  // What the host says of each row's run, as last seen: a row is read again when it changes.
  const seen = useRef(new Map<string, string>())
  useEffect(() => {
    const moved: string[] = []
    const ended: string[] = []
    for (const c of latest.current) {
      const run = live[c.hermesSessionId] ?? ""
      const now = `${run}|${waits[c.hermesSessionId]?.kind ?? ""}`
      const before = seen.current.get(c.id)
      seen.current.set(c.id, now)
      // The first sight of a row is the screen opening, which the reads above cover; the open
      // session's own chat reads its workspace and pull requests as its turn ends.
      if (before === undefined || before === now || c.id === open || !c.worktree) continue
      moved.push(c.id)
      if (!run && !before.startsWith("|")) ended.push(c.id)
    }
    if (moved.length) {
      const at = Date.now()
      for (const id of moved) read.current.set(id, at)
      void refreshWorkspaces(moved).catch(quietly("Reading a workspace"))
    }
    if (ended.length)
      void refreshPrsOf(ended, { force: true }).catch(quietly("Reading sessions' pull requests"))
  }, [live, waits, listed, open])

  usePoll(
    async () => {
      const held = latest.current.filter((c) => c.worktree)
      if (!held.length) return
      // Gated inside by how old each row's copy is, so a quick return to the page asks for nothing.
      void refreshPrsOf(held.map((c) => c.id)).catch(quietly("Reading sessions' pull requests"))
      const bots = new Map(
        (await db.profiles.bulkGet([...new Set(held.map((c) => c.profileId))])).flatMap((bot) =>
          bot ? [[bot.id, bot] as const] : [],
        ),
      )
      const now = Date.now()
      const polled = held.filter(
        (c) =>
          !awaitsStream(bots.get(c.profileId)) &&
          now - (read.current.get(c.id) ?? 0) >= SESSION_REREAD_MS,
      )
      for (const c of polled) read.current.set(c.id, now)
      if (polled.length)
        void refreshWorkspaces(polled.map((c) => c.id)).catch(quietly("Reading a workspace"))
    },
    LIST_MS,
    [],
    { immediate: false },
  )

  const runningChecks = rows.filter((c) => c.id !== open && prChecksPending(c.prs))
  // Forced, so the freshness gate doesn't skip a tick that lands just inside its window.
  usePoll(
    () => {
      if (runningChecks.length)
        void refreshPrsOf(
          runningChecks.map((c) => c.id),
          { force: true },
        ).catch(quietly("Reading sessions' pull requests"))
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
  // One ask per server: bots that share one share its closes, and a close is told once.
  const servers = useLiveQuery(async () => {
    const unique = new Map<string, Profile>()
    for (const bot of await listReachableProfiles())
      if (!unique.has(connectionKey(bot))) unique.set(connectionKey(bot), bot)
    return [...unique.values()]
  }, [])
  const asked = useRef(servers)
  useEffect(() => {
    asked.current = servers
  })
  const read = useCallback(async () => {
    const now = Date.now()
    if (now - last.current < CLOSE_REPORT_GAP_MS) return
    last.current = now
    const bots = asked.current ?? (await listReachableProfiles())
    await Promise.all(bots.map((bot) => tellCloseReports(bot)))
  }, [])
  // A server that streams its changes says when a close ended, so the timer is only the net.
  const streamed = useAllLive(servers)
  usePoll(read, streamed ? SAFETY_MS : CLOSE_REPORT_MS)
  useEffect(() => {
    // The poll above ran once on mount; this is the stream's own word, not a second read of it.
    if (changed) void read()
  }, [changed, read])
}
