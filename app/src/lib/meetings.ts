import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { toast } from "sonner"

import { connectionKey, serverConfig } from "@/lib/connection"
import { db, getActiveProfile, getSettings, listEnabledProfiles, type Profile } from "@/lib/db"
import { HOST_WORK_MS, LIST_MS, SAFETY_MS } from "@/lib/freshness"
import {
  createMeetingOnHost,
  getMeeting,
  hasPluginFeature,
  listMeetings,
  meetingAction,
  meetingAsk,
  uploadMeetingChunk,
} from "@/lib/hermes"
import { useAllLive, useAnyChange, useChanges, useLive } from "@/lib/live"
import { audioType, CHUNK_BYTES, chunkCount, clock, length, stampSeconds } from "@/lib/meeting-text"
import { usePoll } from "@/lib/poll"
import { readProjects, useAllProjects } from "@/lib/projects"
import { quietly } from "@/lib/report"
import { createStore } from "@/lib/store"

export { clock, length, parseTranscript, type TranscriptLine } from "@/lib/meeting-text"

/**
 * Meetings live on each bot's Gots plugin (`meetings.py`), which transcribes a recording and writes
 * its notes with the app closed. The app lists them, shows the notes with the lines they cite, and
 * sends the recording or transcript the user adds.
 */

export type MeetingSource = "upload" | "transcript"

export type MeetingStage = "uploading" | "transcribing" | "writing" | "ready"

/** One line of the notes: what was said, the transcript times it rests on, and who owns it. */
export interface NoteItem {
  id: string
  text: string
  /** Seconds into the meeting; empty when the host found no line that supports it. */
  cites: number[]
  unsourced: boolean
  /** For an action item; the host says "Owner not stated" when the transcript never names one. */
  owner?: string
}

/** A stretch of the meeting about one thing: a chapter of its timeline. */
export interface Topic {
  id: string
  title: string
  /** Seconds from the start of the meeting. */
  start: number
  end: number
  summary: string
  quote?: { text: string; at: number }
}

/** What a moment of the meeting was: something decided, to do, or left open. */
export type MomentKind = "decision" | "action" | "open"

/** A note pinned to the second it rests on. */
export interface Moment {
  id: string
  kind: MomentKind
  text: string
  /** Unset when the host found no line that supports it. */
  at?: number
  owner?: string
}

export interface Notes {
  summary: string
  /** Empty when the host couldn't write them; the app then shows the notes as sections. */
  topics: Topic[]
  keyPoints: NoteItem[]
  decisions: NoteItem[]
  actions: NoteItem[]
  questions: NoteItem[]
}

export interface MeetingLine {
  id: string
  /** Seconds from the start of the meeting. */
  at: number
  text: string
}

export interface Meeting {
  id: string
  profileId: string
  /** The server the meeting lives on, for finding its project's name. */
  connection: string
  title: string
  projectId?: string
  /** The bot that wrote it up, as it is now. */
  bot: { name: string; botId: string }
  source: MeetingSource
  createdAt: number
  /** Seconds; the length of the transcript, 0 until the host has heard the recording. */
  duration: number
  stage: MeetingStage
  /** Chunks sent or windows transcribed so far, while it's in one of those stages. */
  progress?: { done: number; total: number }
  /** Why the current step failed; `retryMeeting` runs it again. */
  error?: string
  /** The page that was sending the recording is gone, so nothing will finish the upload. */
  stalled?: boolean
  /** Only once the meeting has been read in full. */
  transcript: MeetingLine[]
  notes?: Notes
  /** Questions asked about the meeting and the answers, once it has been read in full. */
  chat?: Exchange[]
}

/** One line of the questions asked about a meeting: the user's, or the bot's answer. */
export interface Exchange {
  id: string
  from: "user" | "bot"
  text: string
  /** Seconds into the meeting the answer rests on. */
  cites: number[]
}

export interface MeetingProject {
  id: string
  name: string
}

const STAGES: MeetingStage[] = ["uploading", "transcribing", "writing", "ready"]

const text = (value: unknown) => (typeof value === "string" ? value : "")
const list = (value: unknown) => (Array.isArray(value) ? value : [])

function toItem(raw: unknown, index: number, group: string): NoteItem {
  const item = (raw ?? {}) as Record<string, unknown>
  const owner = text(item.owner)
  return {
    id: `${group}${index}`,
    text: text(item.text),
    cites: list(item.cites)
      .map((cite) => stampSeconds(text(cite)))
      .filter((at): at is number => at !== undefined),
    unsourced: item.unsourced === true,
    ...(owner ? { owner } : {}),
  }
}

function toTopics(raw: unknown): Topic[] {
  return list(raw).flatMap((entry, index) => {
    const topic = (entry ?? {}) as Record<string, unknown>
    const quote = (topic.quote ?? undefined) as Record<string, unknown> | undefined
    const start = Number(topic.start)
    const end = Number(topic.end)
    if (!text(topic.title) || !Number.isFinite(start) || !Number.isFinite(end)) return []
    return [
      {
        id: `t${index}`,
        title: text(topic.title),
        start,
        end,
        summary: text(topic.summary),
        ...(quote && text(quote.text) && Number.isFinite(Number(quote.at))
          ? { quote: { text: text(quote.text), at: Number(quote.at) } }
          : {}),
      },
    ]
  })
}

function toNotes(raw: unknown): Notes | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const notes = raw as Record<string, unknown>
  const items = (key: string, group: string) =>
    list(notes[key]).map((entry, index) => toItem(entry, index, group))
  return {
    summary: text(notes.summary),
    topics: toTopics(notes.topics),
    keyPoints: items("key_points", "p"),
    decisions: items("decisions", "d"),
    actions: items("action_items", "a"),
    questions: items("open_questions", "q"),
  }
}

export function toMeeting(raw: Record<string, unknown>, profile: Profile): Meeting {
  const stage = STAGES.includes(raw.stage as MeetingStage) ? (raw.stage as MeetingStage) : "writing"
  const parts = Number(raw.parts) || 0
  const progress =
    stage === "uploading"
      ? { done: Number(raw.parts_stored) || 0, total: parts }
      : stage === "transcribing"
        ? { done: Number(raw.parts_done) || 0, total: parts }
        : undefined
  return {
    id: text(raw.id),
    profileId: profile.id,
    connection: connectionKey(profile),
    title: text(raw.title),
    projectId: text(raw.project_id) || undefined,
    bot: { name: profile.name, botId: profile.botId },
    source: raw.kind === "transcript" ? "transcript" : "upload",
    createdAt: Number(raw.created_at) || 0,
    duration: Number(raw.duration) || 0,
    stage,
    progress: progress?.total ? progress : undefined,
    error: text(raw.error) || undefined,
    transcript: list(raw.transcript).map((line, index) => {
      const entry = line as Record<string, unknown>
      return { id: `l${index}`, at: Number(entry.at) || 0, text: text(entry.text) }
    }),
    notes: toNotes(raw.notes),
    chat: list(raw.chat).map((line, index) => {
      const entry = (line ?? {}) as Record<string, unknown>
      return {
        id: text(entry.id) || `x${index}`,
        from: entry.from === "user" ? "user" : "bot",
        text: text(entry.text),
        cites: list(entry.cites)
          .map((cite) => stampSeconds(text(cite)))
          .filter((at): at is number => at !== undefined),
      }
    }),
  }
}

export const isFailed = (meeting: Meeting) => Boolean(meeting.error) || Boolean(meeting.stalled)

/** Still going, with nothing for the user to do. */
export const isWorking = (meeting: Meeting) => meeting.stage !== "ready" && !isFailed(meeting)

/** A step failed or the upload was cut off: the user has to act. */
export const needsYou = isFailed

interface State {
  /** Each bot's meetings, by profile id, as last listed (no transcripts or notes). */
  lists: Record<string, Meeting[]>
  /** Meetings read in full. */
  details: Record<string, Meeting>
  /** Bots whose plugin has no Meetings. */
  unsupported: Record<string, string>
  /** Bots that can write notes but can't transcribe a recording, and why. */
  noAudio: Record<string, string>
  loaded: boolean
}

const store = createStore<State>({
  lists: {},
  details: {},
  unsupported: {},
  noAudio: {},
  loaded: false,
})

/** Meetings whose recording this page is sending right now. */
const sending = createStore<ReadonlySet<string>>(new Set())

function put(meeting: Meeting) {
  const state = store.get()
  const own = state.lists[meeting.profileId] ?? []
  const brief = { ...meeting, transcript: [], notes: undefined, chat: undefined }
  const listed = own.some((m) => m.id === meeting.id)
    ? own.map((m) => (m.id === meeting.id ? brief : m))
    : [brief, ...own]
  store.set({
    ...state,
    lists: { ...state.lists, [meeting.profileId]: listed },
    details: { ...state.details, [meeting.id]: meeting },
  })
}

function drop(meeting: Meeting) {
  const state = store.get()
  const details = { ...state.details }
  delete details[meeting.id]
  store.set({
    ...state,
    lists: {
      ...state.lists,
      [meeting.profileId]: (state.lists[meeting.profileId] ?? []).filter(
        (m) => m.id !== meeting.id,
      ),
    },
    details,
  })
}

/** Bots on the same server and profile share one list; the first bot keeps it. */
async function targets() {
  const seen = new Set<string>()
  return (await listEnabledProfiles()).filter((profile) => {
    const key = connectionKey(profile)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

let listing: Promise<void> | undefined

/** Lists every bot's meetings (or joins the read on its way). */
export function refreshMeetings() {
  listing ??= (async () => {
    const lists: Record<string, Meeting[]> = {}
    const unsupported: Record<string, string> = {}
    const noAudio: Record<string, string> = {}
    const previous = store.get()
    await Promise.all(
      (await targets()).map(async (profile) => {
        try {
          if (!(await hasPluginFeature(profile, "meetings"))) {
            unsupported[profile.id] = "Its Gots plugin needs an update for Meetings."
            return
          }
          const found = await listMeetings(profile)
          if (found.unavailable) noAudio[profile.id] = found.unavailable
          lists[profile.id] = found.meetings.map((raw) => toMeeting(raw, profile))
          // The project names come with the list, for the rows that name one.
          if (found.meetings.some((raw) => raw.project_id))
            readProjects(serverConfig(profile)).catch(quietly("Reading projects"))
        } catch {
          // An unreachable bot keeps what it showed.
          if (previous.lists[profile.id]) lists[profile.id] = previous.lists[profile.id]
        }
      }),
    )
    const state = store.get()
    // A detail the list has moved past is read again by its own screen.
    store.set({ ...state, lists, unsupported, noAudio, loaded: true })
  })().finally(() => (listing = undefined))
  return listing
}

/** A meeting with the name of its project and whether its upload was cut off. */
export interface Listed extends Meeting {
  projectName?: string
}

function useDecorated(meetings: Meeting[]): Listed[] {
  const projects = useAllProjects()
  const active = sending.use()
  return meetings.map((m) => ({
    ...m,
    stalled: m.stage === "uploading" && !m.error && !active.has(m.id),
    projectName: m.projectId
      ? (projects.get(m.connection)?.find((p) => p.id === m.projectId)?.name ?? undefined)
      : undefined,
  }))
}

/** Whether Meetings is on: a Developer switch, off by default. */
export function useMeetingsEnabled() {
  return useLiveQuery(async () => {
    const settings = await getSettings()
    return Boolean(settings.developer && settings.meetings)
  }, [])
}

/** Every bot's meetings, newest first, kept fresh while the screen is open. */
export function useMeetings() {
  const state = store.use()
  const profiles = useLiveQuery(listEnabledProfiles, [])
  const all = Object.values(state.lists)
    .flat()
    .sort((a, b) => b.createdAt - a.createdAt)
  const meetings = useDecorated(all)
  const working = meetings.some(isWorking)
  const live = useAllLive(profiles)
  const changes = useAnyChange("meetings")
  usePoll(
    () => void refreshMeetings(),
    working && !live ? HOST_WORK_MS : live ? SAFETY_MS : LIST_MS,
    [changes],
  )
  return { meetings, loaded: state.loaded, unsupported: state.unsupported }
}

async function configOf(profileId: string): Promise<Profile> {
  const profile = await db.profiles.get(profileId)
  if (!profile) throw new Error("The bot holding this meeting is gone.")
  return profile
}

const profileOf = (id: string) =>
  Object.values(store.get().lists)
    .flat()
    .find((m) => m.id === id)?.profileId ?? store.get().details[id]?.profileId

/** Reads one meeting in full. */
export async function refreshMeeting(id: string, signal?: AbortSignal) {
  if (!profileOf(id)) await refreshMeetings()
  const profileId = profileOf(id)
  if (!profileId) return
  const profile = await configOf(profileId)
  const raw = await getMeeting(profile, id, signal)
  if (raw) put(toMeeting(raw, profile))
}

/** One meeting in full (or as listed, until it's read), kept fresh while it's on screen. */
export function useMeeting(id: string) {
  const state = store.use()
  const found =
    state.details[id] ??
    Object.values(state.lists)
      .flat()
      .find((m) => m.id === id)
  const [meeting] = useDecorated(found ? [found] : [])
  const profile = useLiveQuery(
    () => (found ? db.profiles.get(found.profileId) : undefined),
    [found?.profileId],
  )
  const live = useLive(profile)
  const changes = useChanges("meetings", profile)
  const working = meeting ? isWorking(meeting) || isAsking(meeting) : false
  // A meeting listed but not yet read is read once, then only while it moves.
  const unread = found ? state.details[id] === undefined : false
  usePoll(
    (signal) => void refreshMeeting(id, signal).catch(() => undefined),
    working && !live ? HOST_WORK_MS : live ? SAFETY_MS : unread ? HOST_WORK_MS : LIST_MS,
    [id, changes],
  )
  return { meeting, loaded: state.loaded || Boolean(meeting) }
}

/** The bot that sits in on a new meeting: the active one. */
export function useMeetingBot() {
  const profile = useLiveQuery(getActiveProfile, [])
  return profile
}

/** Every bot a meeting can be sent to. */
export function useMeetingBots() {
  return useLiveQuery(listEnabledProfiles, []) ?? []
}

/** Why the bot can't transcribe a recording (it can still take a transcript), else undefined. */
export function useNoAudio(profile?: Profile) {
  const state = store.use()
  useEffect(() => {
    if (!state.loaded) void refreshMeetings()
  }, [state.loaded])
  return profile ? state.noAudio[profile.id] : undefined
}

/** The bot's projects to file a meeting under. */
export function useMeetingProjects(profile?: Profile): MeetingProject[] {
  const projects = useAllProjects()
  const key = profile ? connectionKey(profile) : ""
  const server = profile ? serverConfig(profile) : undefined
  const { baseUrl = "", apiKey = "" } = server ?? {}
  useEffect(() => {
    if (baseUrl) readProjects({ baseUrl, apiKey }).catch(quietly("Reading projects"))
  }, [baseUrl, apiKey])
  return (projects.get(key) ?? [])
    .filter((p) => p.status === "ready" && !p.archived)
    .map((p) => ({ id: p.id, name: p.name }))
}

const NEEDS_PLUGIN = "Its Gots plugin needs an update for Meetings."

async function supported(profile: Profile) {
  if (!(await hasPluginFeature(profile, "meetings"))) throw new Error(NEEDS_PLUGIN)
}

/** Sends a transcript the app already read; the host goes straight to the notes. */
export async function addTranscript(
  profile: Profile,
  input: { title: string; projectId?: string; lines: { at: number; text: string }[] },
) {
  await supported(profile)
  const raw = await createMeetingOnHost(profile, {
    title: input.title,
    project_id: input.projectId,
    transcript: input.lines.map(({ at, text }) => ({ at, text })),
  })
  const meeting = toMeeting(raw, profile)
  put(meeting)
  return meeting
}

const CHUNK_TRIES = 3
const CHUNK_TIMEOUT_MS = 120_000

async function sendChunk(profile: Profile, id: string, n: number, chunk: Blob) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await uploadMeetingChunk(profile, id, n, chunk, AbortSignal.timeout(CHUNK_TIMEOUT_MS))
    } catch (error) {
      if (attempt >= CHUNK_TRIES) throw error
      await new Promise((resolve) => window.setTimeout(resolve, 1000 * attempt ** 2))
    }
  }
}

function mark(id: string, on: boolean) {
  const next = new Set(sending.get())
  if (on) next.add(id)
  else next.delete(id)
  sending.set(next)
}

/**
 * Sends the recording in byte chunks of the one file, read with `File.slice` so a long one never
 * sits in memory whole; the host joins them, decodes the file and cuts it into windows itself,
 * since a slice of an m4a or a wav isn't audio on its own.
 */
async function send(profile: Profile, meeting: Meeting, file: File) {
  const type = audioType(file.name, file.type)
  const total = chunkCount(file.size)
  mark(meeting.id, true)
  try {
    for (let n = 0; n < total; n++) {
      const chunk = file.slice(n * CHUNK_BYTES, (n + 1) * CHUNK_BYTES, type)
      put(toMeeting(await sendChunk(profile, meeting.id, n, chunk), profile))
    }
    const finished = await meetingAction(profile, meeting.id, "finish")
    if (finished) put(toMeeting(finished, profile))
  } catch (error) {
    // Nothing will finish a half-sent upload, so it doesn't stay behind to be tried again.
    await meetingAction(profile, meeting.id, "remove").catch(quietly("Removing a failed upload"))
    drop(meeting)
    toast.error(
      `Couldn't upload ${meeting.title}: ${error instanceof Error ? error.message : "it failed"}`,
    )
  } finally {
    mark(meeting.id, false)
  }
}

/** Starts a meeting from a recording; the upload carries on after this returns. */
export async function addRecording(
  profile: Profile,
  input: { title: string; projectId?: string; file: File },
) {
  await supported(profile)
  const raw = await createMeetingOnHost(profile, {
    title: input.title,
    project_id: input.projectId,
    parts: chunkCount(input.file.size),
  })
  const meeting = toMeeting(raw, profile)
  put(meeting)
  void send(profile, meeting, input.file)
  return meeting
}

/** Runs a failed step again; the host keeps the windows it has already transcribed. */
/** Whether the host is still writing the answer to the last question. */
export const isAsking = (meeting: Meeting) => meeting.chat?.at(-1)?.from === "user"

/** Asks the bot a question about the meeting; the answer arrives on the next reads. */
export async function askMeeting(meeting: Meeting, question: string) {
  const profile = await configOf(meeting.profileId)
  const raw = await meetingAsk(profile, meeting.id, question)
  if (raw) put(toMeeting(raw, profile))
}

export async function retryMeeting(meeting: Meeting) {
  const profile = await configOf(meeting.profileId)
  const raw = await meetingAction(profile, meeting.id, "retry")
  if (raw) put(toMeeting(raw, profile))
}

export async function removeMeeting(meeting: Meeting) {
  const profile = await configOf(meeting.profileId)
  await meetingAction(profile, meeting.id, "remove")
  drop(meeting)
}

/** Whether a meeting matches a search: its title, project, notes or transcript. */
export function matchesMeeting(meeting: Listed, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const notes = meeting.notes
  const haystack = [
    meeting.title,
    meeting.projectName,
    notes?.summary,
    ...[
      ...(notes?.keyPoints ?? []),
      ...(notes?.decisions ?? []),
      ...(notes?.actions ?? []),
      ...(notes?.questions ?? []),
    ].map((item) => item.text),
    ...meeting.transcript.map((l) => l.text),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/** What a meeting's row says under its title. */
export function meetingLine(meeting: Meeting) {
  const parts = meeting.progress && `${meeting.progress.done} of ${meeting.progress.total}`
  if (meeting.stalled) return "The upload didn't finish"
  if (meeting.error) return meeting.error
  switch (meeting.stage) {
    case "uploading":
      return parts ? `Uploading · ${parts}` : "Uploading"
    case "transcribing":
      return parts ? `Transcribing · ${parts}` : "Transcribing"
    case "writing":
      return `${meeting.bot.name} is writing it up`
    default: {
      const todo = meeting.notes?.actions.length ?? 0
      return [meeting.duration > 0 && length(meeting.duration), todo && `${todo} to do`]
        .filter(Boolean)
        .join(" · ")
    }
  }
}

export interface NoteSection {
  key: "keyPoints" | "decisions" | "actions" | "questions"
  title: string
}

/** The notes' sections in the host's order, after the summary. */
export const NOTE_SECTIONS: NoteSection[] = [
  { key: "keyPoints", title: "Key points" },
  { key: "decisions", title: "Decisions" },
  { key: "actions", title: "Action items" },
  { key: "questions", title: "Open questions" },
]

/** The notes as Markdown, for Copy. */
export function toMarkdown(meeting: Meeting) {
  const notes = meeting.notes
  if (!notes) return `# ${meeting.title}\n`
  const sections = NOTE_SECTIONS.map(({ key, title }) => {
    const items = notes[key]
    const body = items.length
      ? items
          .map((item) => {
            const owner = key === "actions" && item.owner ? ` (${item.owner})` : ""
            const cites = item.cites.map((at) => ` [${clock(at)}]`).join("")
            return `- ${item.text}${owner}${cites}${item.unsourced ? " (unsourced)" : ""}`
          })
          .join("\n")
      : "None recorded"
    return `## ${title}\n\n${body}`
  })
  return [`# ${meeting.title}`, `## Summary\n\n${notes.summary}`, ...sections].join("\n\n") + "\n"
}

/** The topic that holds `seconds`. */
export const topicAt = (topics: Topic[], seconds: number) =>
  topics.findLast((t) => t.start <= seconds) ?? topics[0]

/** The notes' decisions, actions and open questions, each pinned to the first line it cites. */
export function momentsOf(notes: Notes): Moment[] {
  const pin = (kind: MomentKind, items: NoteItem[]): Moment[] =>
    items.map((item) => ({
      id: item.id,
      kind,
      text: item.text,
      at: item.cites[0],
      ...(item.owner ? { owner: item.owner } : {}),
    }))
  return [
    ...pin("decision", notes.decisions),
    ...pin("action", notes.actions),
    ...pin("open", notes.questions),
  ]
}
