import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { serverConfig } from "@/lib/connection"
import { getActiveProfile, getSettings } from "@/lib/db"
import { readProjects, useProjects } from "@/lib/projects"
import { quietly } from "@/lib/report"
import { createStore } from "@/lib/store"
import { randomId } from "@/lib/utils"

/**
 * Meetings, a design mock behind a Developer switch: a recording made in the app or an audio file
 * added from the device, transcribed and written up as notes on the host. Nothing reaches a host
 * yet. The meetings below live in memory on this device, and a new one walks through the pipeline's
 * stages on timers, so the screens can be tried end to end.
 */

export type MeetingStage = "uploading" | "transcribing" | "writing" | "ready" | "failed"

export interface TranscriptLine {
  id: string
  /** Seconds from the start of the meeting. */
  at: number
  text: string
}

/** A line of the notes; one without `at` cites nothing in the transcript and is flagged. */
export interface NoteItem {
  text: string
  at?: number
}

export interface NoteSection {
  id: "points" | "decisions" | "actions" | "questions"
  title: string
  items: NoteItem[]
}

export interface MeetingNote {
  summary: string
  sections: NoteSection[]
}

export interface Meeting {
  id: string
  title: string
  projectId: string
  projectName: string
  source: "recording" | "upload"
  fileName?: string
  createdAt: number
  /** Seconds. */
  duration: number
  stage: MeetingStage
  /** Parts uploaded or transcribed so far, while it's in one of those stages. */
  progress?: { done: number; total: number }
  error?: string
  /** What the user typed while recording. */
  typed?: string
  transcript: TranscriptLine[]
  note?: MeetingNote
}

export interface MeetingProject {
  id: string
  name: string
}

/** Projects to file a meeting under when the active bot has none of its own to offer. */
export const SAMPLE_PROJECTS: MeetingProject[] = [
  { id: "sample-gots", name: "Gots" },
  { id: "sample-website", name: "Website" },
]

/** The host transcribes a recording five minutes at a time. */
const PART_SECONDS = 300

const lines = (rows: [number, string][]): TranscriptLine[] =>
  rows.map(([at, text], index) => ({ id: `l${index}`, at, text }))

const SECTION_TITLES: Record<NoteSection["id"], string> = {
  points: "Key points",
  decisions: "Decisions",
  actions: "Action items",
  questions: "Open questions",
}

const note = (summary: string, sections: Record<NoteSection["id"], NoteItem[]>): MeetingNote => ({
  summary,
  sections: (Object.keys(SECTION_TITLES) as NoteSection["id"][]).map((id) => ({
    id,
    title: SECTION_TITLES[id],
    items: sections[id],
  })),
})

const SYNC_TRANSCRIPT = lines([
  [4, "Okay, let's start. Three things today: the beta date, the sidebar and push on Android."],
  [21, "On the beta, I think Thursday still works if we freeze on Tuesday."],
  [48, "The risk is the Android build. Firebase push still isn't tested on a real phone."],
  [83, "Can we get two people to install the APK this week and report back?"],
  [112, "Yes, I'll send the tester link today."],
  [140, "Good. Second thing, the sidebar. Research moved up between Code and Routines."],
  [171, "People found it fine in the last round. Nobody asked where it went."],
  [205, "Then let's keep it. No more changes to the sidebar before the beta."],
  [244, "Agreed. Last one: push. Should a finished run notify by default?"],
  [276, "I'd leave it off. It's noisy when you're watching the chat anyway."],
  [309, "Okay, off by default, and we look at it again after the beta."],
  [338, "One open question: do we need a status page for the registry?"],
  [367, "Not sure yet. Let's see how many hosts link in the first week."],
  [402, "Great, that's everything. Thanks all."],
])

const SYNC_NOTE = note(
  "The team kept the beta on Thursday with a freeze on Tuesday, provided the Android build is tried on real phones this week. The sidebar stays as it is until the beta, and a finished run won't push by default.",
  {
    points: [
      { text: "Thursday still works for the beta if the freeze is on Tuesday.", at: 21 },
      { text: "Firebase push hasn't been tried on a real phone yet.", at: 48 },
      { text: "Testers found Research in its new place without asking.", at: 171 },
    ],
    decisions: [
      { text: "No more sidebar changes before the beta.", at: 205 },
      { text: "A finished run doesn't push by default; revisit after the beta.", at: 309 },
    ],
    actions: [
      { text: "Send the Android tester link today.", at: 112 },
      { text: "Get two testers to install the APK and report back this week.", at: 83 },
      { text: "Write the beta announcement." },
    ],
    questions: [{ text: "Does the registry need a status page?", at: 338 }],
  },
)

const LAUNCH_TRANSCRIPT = lines([
  [6, "This is about the landing page for the launch."],
  [30, "The scroll story is done, but the waiting list form doesn't store anything yet."],
  [64, "We need that before we share the link anywhere."],
  [98, "Netlify Forms would be the quickest. No function to write."],
  [131, "Fine by me. And the leaderboard keeps its sample data until the function exists."],
  [170, 'Should the tagline stay "Hermes Bots that got your back"?'],
  [196, "Yes, it tested well. Keep it."],
  [228, "Then I'll wire the form tomorrow and we review on Friday."],
])

const LAUNCH_NOTE = note(
  "The landing page is ready apart from the waiting list form, which will use Netlify Forms. The tagline stays, and the leaderboard keeps its sample data for now.",
  {
    points: [
      { text: "The scroll story is finished.", at: 30 },
      { text: "The waiting list form stores nothing yet.", at: 30 },
    ],
    decisions: [
      { text: "Use Netlify Forms for the waiting list.", at: 131 },
      { text: "Keep the current tagline.", at: 196 },
    ],
    actions: [
      { text: "Wire the waiting list form tomorrow.", at: 228 },
      { text: "Review the page together on Friday.", at: 228 },
    ],
    questions: [],
  },
)

/** What a meeting made on this device is written up as, whatever was said. */
const GENERATED_TRANSCRIPT = lines([
  [3, "Right, let's get going. I want to agree the plan for the next two weeks."],
  [29, "The biggest item is the import flow. It has to work with the app closed."],
  [61, "Then the upload goes in parts, so a long recording never hits the size limit."],
  [95, "What about speaker names? People will ask for them."],
  [122, "Not in the first version. Timestamps first, names later."],
  [158, "Okay. Who takes the plugin side?"],
  [181, "I will. I'll start with the transcription step."],
  [214, "And I'll do the screens. Let's check in on Monday."],
])

const GENERATED_NOTE = note(
  "The plan for the next two weeks centres on importing recordings, uploaded in parts so they work with the app closed. Speaker names wait for a later version.",
  {
    points: [
      { text: "The import flow has to work with the app closed.", at: 29 },
      { text: "Uploading in parts keeps long recordings under the size limit.", at: 61 },
    ],
    decisions: [{ text: "No speaker names in the first version.", at: 122 }],
    actions: [
      { text: "Start the plugin's transcription step.", at: 181 },
      { text: "Build the screens.", at: 214 },
      { text: "Check in on Monday.", at: 214 },
    ],
    questions: [{ text: "When do speaker names come in?" }],
  },
)

const HOUR = 3_600_000
const DAY = 24 * HOUR

function samples(now: number): Meeting[] {
  return [
    {
      id: "m_sync",
      title: "Weekly product sync",
      projectId: "sample-gots",
      projectName: "Gots",
      source: "recording",
      createdAt: now - 3 * HOUR,
      duration: 412,
      stage: "ready",
      typed: "beta thu? freeze tue\nandroid push untested!\nsidebar: leave it",
      transcript: SYNC_TRANSCRIPT,
      note: SYNC_NOTE,
    },
    {
      id: "m_customer",
      title: "Call with an early tester",
      projectId: "sample-gots",
      projectName: "Gots",
      source: "upload",
      fileName: "tester-call.m4a",
      createdAt: now - DAY - 2 * HOUR,
      duration: 1_860,
      stage: "failed",
      error: "The host couldn't transcribe part 3 of 7.",
      progress: { done: 2, total: 7 },
      transcript: [],
    },
    {
      id: "m_launch",
      title: "Landing page review",
      projectId: "sample-website",
      projectName: "Website",
      source: "upload",
      fileName: "landing-review.mp3",
      createdAt: now - 2 * DAY,
      duration: 241,
      stage: "ready",
      transcript: LAUNCH_TRANSCRIPT,
      note: LAUNCH_NOTE,
    },
  ]
}

const store = createStore<Meeting[]>(samples(Date.now()))

function update(id: string, change: Partial<Meeting>) {
  store.set(store.get().map((m) => (m.id === id ? { ...m, ...change } : m)))
}

const exists = (id: string) => store.get().some((m) => m.id === id)

/** Whether Meetings is on: a Developer switch, off by default. */
export function useMeetingsEnabled() {
  return useLiveQuery(async () => {
    const settings = await getSettings()
    return Boolean(settings.developer && settings.meetings)
  }, [])
}

/** Every meeting on this device, newest first. */
export function useMeetings() {
  return [...store.use()].sort((a, b) => b.createdAt - a.createdAt)
}

export function useMeeting(id: string) {
  return store.use().find((m) => m.id === id)
}

/** The active bot's projects to file a meeting under, or the samples when it has none. */
export function useMeetingProjects(): MeetingProject[] {
  const profile = useLiveQuery(getActiveProfile, [])
  const server = profile ? serverConfig(profile) : undefined
  const projects = useProjects(server)
  const { baseUrl = "", apiKey = "" } = server ?? {}
  useEffect(() => {
    if (baseUrl) readProjects({ baseUrl, apiKey }).catch(quietly("Reading projects"))
  }, [baseUrl, apiKey])
  const real = (projects ?? []).filter((p) => p.status === "ready" && !p.archived)
  return real.length ? real.map((p) => ({ id: p.id, name: p.name })) : SAMPLE_PROJECTS
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/** Walks a meeting through the stages a host would, from `from` on. Stops if it's removed. */
async function run(id: string, from: MeetingStage) {
  const meeting = store.get().find((m) => m.id === id)
  if (!meeting) return
  const total = Math.max(1, Math.ceil(meeting.duration / PART_SECONDS))
  if (from === "uploading") {
    for (let done = 0; done <= total; done++) {
      if (!exists(id)) return
      update(id, { stage: "uploading", progress: { done, total } })
      await sleep(500)
    }
  }
  if (from === "uploading" || from === "transcribing") {
    const start = from === "transcribing" ? (meeting.progress?.done ?? 0) : 0
    for (let done = start; done <= total; done++) {
      if (!exists(id)) return
      update(id, { stage: "transcribing", progress: { done, total }, error: undefined })
      await sleep(700)
    }
  }
  if (!exists(id)) return
  update(id, { stage: "writing", progress: undefined })
  await sleep(1_800)
  if (!exists(id)) return
  update(id, { stage: "ready", transcript: GENERATED_TRANSCRIPT, note: GENERATED_NOTE })
}

export function createMeeting(input: {
  title: string
  project: MeetingProject
  source: Meeting["source"]
  duration: number
  fileName?: string
  typed?: string
}): Meeting {
  const meeting: Meeting = {
    id: `m_${randomId()}`,
    title: input.title,
    projectId: input.project.id,
    projectName: input.project.name,
    source: input.source,
    fileName: input.fileName,
    createdAt: Date.now(),
    duration: input.duration,
    stage: "uploading",
    typed: input.typed?.trim() || undefined,
    transcript: [],
  }
  store.set([meeting, ...store.get()])
  void run(meeting.id, "uploading")
  return meeting
}

/** Runs a failed meeting again from the part that failed. */
export function retryMeeting(meeting: Meeting) {
  void run(meeting.id, "transcribing")
}

export function removeMeeting(id: string) {
  store.set(store.get().filter((m) => m.id !== id))
}

export const isWorking = (meeting: Meeting) =>
  meeting.stage !== "ready" && meeting.stage !== "failed"

/** `4:05`, or `1:02:05` past the hour. */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, "0")
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** `7 min`, `1 h 2 min`. */
export function length(seconds: number) {
  const minutes = Math.max(1, Math.round(seconds / 60))
  const h = Math.floor(minutes / 60)
  return h ? `${h} h ${minutes % 60} min` : `${minutes} min`
}

/** What a meeting's row says under its title. */
export function meetingLine(meeting: Meeting) {
  const parts = meeting.progress && `${meeting.progress.done} of ${meeting.progress.total}`
  switch (meeting.stage) {
    case "uploading":
      return `Uploading · ${parts}`
    case "transcribing":
      return `Transcribing · part ${parts}`
    case "writing":
      return "Writing notes"
    case "failed":
      return meeting.error ?? "Failed"
    default: {
      const actions = meeting.note?.sections.find((s) => s.id === "actions")?.items.length ?? 0
      return [length(meeting.duration), actions && `${actions} action items`]
        .filter(Boolean)
        .join(" · ")
    }
  }
}

/** The notes as Markdown, for Copy. */
export function toMarkdown(meeting: Meeting) {
  if (!meeting.note) return `# ${meeting.title}\n`
  const stamp = (item: NoteItem) => (item.at === undefined ? "" : ` [${clock(item.at)}]`)
  const sections = meeting.note.sections.map(
    (section) =>
      `## ${section.title}\n\n${
        section.items.length
          ? section.items.map((item) => `- ${item.text}${stamp(item)}`).join("\n")
          : "None recorded."
      }`,
  )
  return (
    [`# ${meeting.title}`, `## Summary\n\n${meeting.note.summary}`, ...sections].join("\n\n") + "\n"
  )
}
