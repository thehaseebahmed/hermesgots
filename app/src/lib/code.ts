import { useCallback, useEffect, useRef } from "react"
import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"

import { connectionKey } from "@/lib/connection"
import { db, type Conversation, type Profile } from "@/lib/db"
import { tellCloseReports } from "@/lib/close-reports"
import type { HermesProject } from "@/lib/hermes"
import { PR_PENDING_MS, SESSION_REREAD_MS } from "@/lib/freshness"
import { useAnyChange } from "@/lib/live"
import { usePoll } from "@/lib/poll"
import { prChecksPending, refreshPrs, refreshWorkspace } from "@/lib/workspace"

/** A project by its server and id: bots on one server share its projects. */
export const projectKey = (server: { baseUrl: string; apiKey: string }, projectId: string) =>
  `${connectionKey(server)}\n${projectId}`

/** What this device sees of a session's own turns: any at all, a reply streaming, one waiting. */
export interface LocalTurns {
  any?: boolean
  streaming?: boolean
  waiting?: boolean
}

/**
 * Project sessions across every bot that isn't turned off (or one project's, by its key), newest
 * first, with what this device sees of their turns. Only a reply in flight can carry an approval or
 * question (a finished turn expires them), and it's the newest reply, so each session's messages are
 * read back only as far as that, past any queued after it.
 */
export function useProjectSessions(only?: string) {
  return useLiveQuery(async () => {
    const profiles = new Map(
      (await db.profiles.toArray()).filter((p) => !p.disabled).map((p) => [p.id, p]),
    )
    const rows = (await db.conversations.where("projectId").above("").toArray())
      .filter((c) => {
        const profile = profiles.get(c.profileId)
        return profile && (!only || projectKey(profile, c.projectId!) === only)
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const local: Record<string, LocalTurns> = {}
    await Promise.all(
      rows.map(async (c) => {
        const tail = await db.messages
          .where("[conversationId+createdAt]")
          .between([c.id, Dexie.minKey], [c.id, Dexie.maxKey])
          .reverse()
          .until((m) => m.role === "assistant", true)
          .toArray()
        if (!tail.length) return
        local[c.id] = {
          any: true,
          streaming: tail.some((m) => m.status === "streaming"),
          waiting: tail.some(
            (m) => (m.approval && !m.approval.resolved) || (m.clarify && !m.clarify.resolved),
          ),
        }
      }),
    )
    // A session nothing was sent in (or typed for) isn't one yet. Synced ones carry their activity
    // in `updatedAt`, since their messages load only when opened.
    const sessions = rows.filter((c) => c.draftAt || c.updatedAt > c.createdAt || local[c.id]?.any)
    return { sessions, local, profiles: profiles as Map<string, Profile>, now: Date.now() }
  }, [only])
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

/** How often Code reads a bot's close reports while it is open, beside the stream's own word. */
const CLOSE_REPORT_MS = 30_000
/** Two reads this close together are one: the stream and the timer often ask at the same moment. */
const CLOSE_REPORT_GAP_MS = 5_000

/**
 * Tells the close reports a bot has ended that this device holds no mark for (ADR 0075). A close is
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
    const bots = (await db.profiles.toArray()).filter(
      (bot) => !bot.disabled && bot.apiKey && bot.baseUrl.trim(),
    )
    await Promise.all(bots.map((bot) => tellCloseReports(bot)))
  }, [])
  usePoll(read, CLOSE_REPORT_MS)
  useEffect(() => {
    void read()
  }, [changed, read])
}
