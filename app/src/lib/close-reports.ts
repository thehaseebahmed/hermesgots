/**
 * Telling a session's close: the reports this device has already said, and what a report says.
 *
 * The close is the host's work (ADR 0075), so its report arrives after the row has moved — while the
 * device that asked is still there, or when the next device opens Code. Either way each device tells
 * a report once, against a mark of its own kept in local storage, the same shape as a read mark.
 */

import { toast } from "sonner"

import {
  closeLines,
  closeToldKey,
  closeUntold,
  type CloseReport,
} from "@/lib/close-report"
import { type Profile } from "@/lib/db"
import { getSessionCloses } from "@/lib/hermes"
import { quietly } from "@/lib/report"
import { createStore } from "@/lib/store"

const KEY = "memento:close-reports"
/** The store only ever grows: the oldest marks drop past this many. */
const KEEP = 200

const isMark = (at: unknown): at is number => typeof at === "number" && at > 0

const load = (): Record<string, number> => {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}")
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {}
    const marks: Record<string, number> = {}
    for (const [id, at] of Object.entries(stored)) {
      if (isMark(at)) marks[id] = at
    }
    return marks
  } catch {
    // Storage blocked (private mode): the marks still work for this session's life.
    return {}
  }
}

const marks = createStore<Record<string, number>>(load())

const persist = (next: Record<string, number>) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Storage full or blocked: the in-memory marks still hold for this session's life.
  }
}

/** This device has told this close: its mark is the moment the close started. */
function markTold(profileId: string, close: CloseReport) {
  const current = marks.get()
  const key = closeToldKey(profileId, close.sessionId)
  if ((current[key] ?? 0) >= close.startedAt) return
  let next = { ...current, [key]: close.startedAt }
  const entries = Object.entries(next)
  if (entries.length > KEEP) {
    entries.sort((a, b) => b[1] - a[1])
    next = Object.fromEntries(entries.slice(0, KEEP))
  }
  marks.set(next)
  persist(next)
}

/**
 * Says what a close ended with, once per device. `named` is whether the session worked in more than
 * one repository, which is when a refusal has to say which repo refused.
 */
export function tellClose(profile: Pick<Profile, "id">, close: CloseReport, named?: boolean) {
  if (!closeUntold(marks.get(), profile.id, close)) return false
  markTold(profile.id, close)
  for (const line of closeLines(close, named ?? close.repos.length > 1)) {
    if (line.tone === "error") toast.error(line.text)
    else toast.info(line.text)
  }
  return true
}

/**
 * Reads a bot's closes and tells the ones this device holds no mark for: how a close asked for
 * before the app was put away still reaches its user, on whatever device opens Code next.
 */
export async function tellCloseReports(profile: Profile) {
  const closes = await getSessionCloses(profile).catch(quietly("Reading a session's close"))
  if (!closes) return
  for (const close of closes) tellClose(profile, close)
}
