import { useEffect } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { DEFAULT_BOT_ID } from "@/components/bots"
import { serverConfig } from "@/lib/connection"
import { getActiveProfile, getSettings } from "@/lib/db"
import { readProjects, useProjects } from "@/lib/projects"
import { quietly } from "@/lib/report"
import { createStore } from "@/lib/store"
import { randomId } from "@/lib/utils"

/**
 * Meetings, a design mock behind a Developer switch: the bot sits in on a meeting (or is handed a
 * recording), and writes it up as a recap, a timeline of its topics and what was decided, left to
 * do and left open. Nothing reaches a host yet. The meetings live in memory on this device, a new
 * one walks through the pipeline's stages on timers, and the bot's answers are canned.
 */

export type MeetingSource = "recording" | "upload" | "transcript"

export type MeetingStage = "uploading" | "transcribing" | "writing" | "ready" | "failed"

export interface TranscriptLine {
  id: string
  /** Seconds from the start of the meeting. */
  at: number
  text: string
}

/** What a moment of the meeting was: something decided, to do, or left open. */
export type MomentKind = "decision" | "action" | "open"

export interface Moment {
  id: string
  kind: MomentKind
  text: string
  /** Seconds from the start; unset when the bot couldn't place it. */
  at?: number
  /** Who it's down to, for an action. */
  owner?: string
  /** The user marked it while recording. */
  marked?: boolean
}

/** A stretch of the meeting about one thing: a chapter of its timeline. */
export interface Topic {
  id: string
  title: string
  start: number
  end: number
  summary: string
  quote?: { text: string; at: number }
}

export interface Recap {
  /** The bot's opening line. */
  lead: string
  topics: Topic[]
  moments: Moment[]
}

/** A moment the user marked while recording; a flag becomes an open question. */
export interface Mark {
  kind: MomentKind
  at: number
}

export interface Exchange {
  id: string
  from: "user" | "bot"
  text: string
}

export interface Meeting {
  id: string
  title: string
  projectId: string
  projectName: string
  /** The bot that sat in, as it was then. */
  bot: { name: string; botId: string }
  /** Recorded here, an uploaded recording, or a transcript made elsewhere. */
  source: MeetingSource
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
  marks?: Mark[]
  transcript: TranscriptLine[]
  recap?: Recap
  /** Actions started as project sessions. */
  started?: string[]
  /** Questions asked about the meeting and the bot's answers. */
  chat?: Exchange[]
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

const moments = (rows: [MomentKind, string, number?, string?][]): Moment[] =>
  rows.map(([kind, text, at, owner], index) => ({ id: `k${index}`, kind, text, at, owner }))

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

const SYNC_RECAP: Recap = {
  lead: "You kept the beta on Thursday, as long as the Android build gets tried on real phones this week.",
  topics: [
    {
      id: "t0",
      title: "The beta date",
      start: 0,
      end: 140,
      summary:
        "Thursday holds with a freeze on Tuesday. The risk is push on Android, which nobody has tried on a real phone, so two testers install the APK this week.",
      quote: { text: "Firebase push still isn't tested on a real phone.", at: 48 },
    },
    {
      id: "t1",
      title: "The sidebar",
      start: 140,
      end: 244,
      summary:
        "Testers found Research in its new place without asking, so the sidebar stays as it is until the beta.",
      quote: { text: "Nobody asked where it went.", at: 171 },
    },
    {
      id: "t2",
      title: "Push when a run finishes",
      start: 244,
      end: 338,
      summary:
        "A finished run won't notify by default, since it's noisy while you watch the chat. It comes back after the beta.",
    },
    {
      id: "t3",
      title: "A status page",
      start: 338,
      end: 412,
      summary: "Nobody knows yet whether the registry needs one. The first week's links will tell.",
    },
  ],
  moments: moments([
    ["decision", "Beta on Thursday, freeze on Tuesday", 21],
    ["decision", "No sidebar changes before the beta", 205],
    ["decision", "A finished run doesn't push by default", 309],
    ["action", "Send the Android tester link", 112, "You"],
    ["action", "Get two testers on the APK this week", 83, "Team"],
    ["action", "Write the beta announcement", undefined, "You"],
    ["open", "Does the registry need a status page?", 338],
  ]),
}

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

const LAUNCH_RECAP: Recap = {
  lead: "The landing page is ready apart from the waiting list form.",
  topics: [
    {
      id: "t0",
      title: "The waiting list",
      start: 0,
      end: 160,
      summary:
        "The scroll story is done but the form stores nothing. Netlify Forms is the quickest fix, and the leaderboard keeps its sample data for now.",
      quote: { text: "We need that before we share the link anywhere.", at: 64 },
    },
    {
      id: "t1",
      title: "The tagline",
      start: 160,
      end: 220,
      summary: "It tested well, so it stays.",
    },
    {
      id: "t2",
      title: "Next steps",
      start: 220,
      end: 241,
      summary: "The form goes in tomorrow and the page is reviewed on Friday.",
    },
  ],
  moments: moments([
    ["decision", "Use Netlify Forms for the waiting list", 98],
    ["decision", "Keep the tagline", 196],
    ["action", "Wire the waiting list form", 228, "You"],
    ["action", "Review the page together on Friday", 228, "Team"],
  ]),
}

/** What a meeting made on this device is written up as, whatever was said. */
const GENERATED_LENGTH = 240

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

const GENERATED_RECAP: Recap = {
  lead: "You settled on import first, so it works with the app closed.",
  topics: [
    {
      id: "t0",
      title: "The import flow",
      start: 0,
      end: 95,
      summary:
        "Recordings are imported and uploaded in parts, so a long one never hits the size limit and nothing depends on the app staying open.",
      quote: { text: "It has to work with the app closed.", at: 29 },
    },
    {
      id: "t1",
      title: "Speaker names",
      start: 95,
      end: 158,
      summary: "They wait for a later version; timestamps come first.",
    },
    {
      id: "t2",
      title: "Who does what",
      start: 158,
      end: 240,
      summary: "One of you takes the plugin's transcription step, the other the screens.",
    },
  ],
  moments: moments([
    ["decision", "Import first, uploaded in parts", 29],
    ["decision", "No speaker names in the first version", 122],
    ["action", "Start the plugin's transcription step", 181, "You"],
    ["action", "Build the screens", 214, "Team"],
    ["open", "When do speaker names come in?", 95],
  ]),
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

function samples(now: number): Meeting[] {
  const bot = { name: "Penny", botId: "penny" }
  return [
    {
      id: "m_sync",
      title: "Weekly product sync",
      projectId: "sample-gots",
      projectName: "Gots",
      bot,
      source: "recording",
      createdAt: now - 3 * HOUR,
      duration: 412,
      stage: "ready",
      typed: "beta thu? freeze tue\nandroid push untested!\nsidebar: leave it",
      transcript: SYNC_TRANSCRIPT,
      recap: SYNC_RECAP,
    },
    {
      id: "m_customer",
      title: "Call with an early tester",
      projectId: "sample-gots",
      projectName: "Gots",
      bot,
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
      bot: { name: "Hex", botId: "hex" },
      source: "upload",
      fileName: "landing-review.mp3",
      createdAt: now - 2 * DAY,
      duration: 241,
      stage: "ready",
      transcript: LAUNCH_TRANSCRIPT,
      recap: LAUNCH_RECAP,
    },
    ready({
      id: "m_crit",
      title: "Design crit: onboarding",
      projectId: "sample-website",
      projectName: "Website",
      bot: { name: "Hex", botId: "hex" },
      source: "transcript",
      fileName: "design-crit.vtt",
      createdAt: now - 5 * DAY,
      duration: 1_520,
      stage: "ready",
      transcript: [],
    }),
    ready({
      id: "m_sprint",
      title: "Sprint planning",
      projectId: "sample-gots",
      projectName: "Gots",
      bot,
      source: "recording",
      createdAt: now - 9 * DAY,
      duration: 2_710,
      stage: "ready",
      transcript: [],
    }),
  ]
}

const ready = (meeting: Meeting): Meeting => ({ ...meeting, ...generated(meeting) })

const store = createStore<Meeting[]>(samples(Date.now()))

function update(id: string, change: (meeting: Meeting) => Partial<Meeting>) {
  store.set(store.get().map((m) => (m.id === id ? { ...m, ...change(m) } : m)))
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

/** The bot that sits in on a new meeting: the active one. */
export function useMeetingBot() {
  const profile = useLiveQuery(getActiveProfile, [])
  return { name: profile?.name || "Cubby", botId: profile?.botId || DEFAULT_BOT_ID }
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

/** The line the bot hears at `seconds` into a recording, for the listening screen. */
export function heardAt(seconds: number) {
  const index = Math.floor(seconds / 4) % GENERATED_TRANSCRIPT.length
  return {
    line: GENERATED_TRANSCRIPT[index].text,
    before: index ? GENERATED_TRANSCRIPT[index - 1].text : undefined,
  }
}

/**
 * The generated write-up, fitted to the meeting's own length, with each of the user's marks as a
 * moment of its own: the line heard when it was marked.
 */
function generated(meeting: Meeting): Pick<Meeting, "transcript" | "recap"> {
  const scale = meeting.duration > 0 ? meeting.duration / GENERATED_LENGTH : 1
  const fit = (at: number) => Math.round(at * scale * 10) / 10
  const marked = (meeting.marks ?? []).map<Moment>((mark, index) => ({
    id: `m${index}`,
    kind: mark.kind,
    text: heardAt(mark.at).line,
    at: mark.at,
    marked: true,
  }))
  return {
    transcript: meeting.transcript.length
      ? meeting.transcript
      : GENERATED_TRANSCRIPT.map((line) => ({ ...line, at: fit(line.at) })),
    recap: {
      lead: GENERATED_RECAP.lead,
      topics: GENERATED_RECAP.topics.map((topic) => ({
        ...topic,
        start: fit(topic.start),
        end: fit(topic.end),
        quote: topic.quote && { ...topic.quote, at: fit(topic.quote.at) },
      })),
      moments: [
        ...GENERATED_RECAP.moments.map((m) => ({
          ...m,
          at: m.at === undefined ? m.at : fit(m.at),
        })),
        ...marked,
      ],
    },
  }
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
      update(id, () => ({ stage: "uploading", progress: { done, total } }))
      await sleep(500)
    }
  }
  if (from === "uploading" || from === "transcribing") {
    const start = from === "transcribing" ? (meeting.progress?.done ?? 0) : 0
    for (let done = start; done <= total; done++) {
      if (!exists(id)) return
      update(id, () => ({ stage: "transcribing", progress: { done, total }, error: undefined }))
      await sleep(700)
    }
  }
  if (!exists(id)) return
  update(id, () => ({ stage: "writing", progress: undefined }))
  await sleep(1_800)
  if (!exists(id)) return
  update(id, (m) => ({ stage: "ready", ...generated(m) }))
}

export function createMeeting(input: {
  title: string
  project: MeetingProject
  bot: Meeting["bot"]
  source: Meeting["source"]
  duration: number
  fileName?: string
  typed?: string
  marks?: Mark[]
  /** A transcript made elsewhere, which skips the upload and the transcription. */
  transcript?: TranscriptLine[]
}): Meeting {
  const first: MeetingStage = input.transcript?.length ? "writing" : "uploading"
  const meeting: Meeting = {
    id: `m_${randomId()}`,
    title: input.title,
    projectId: input.project.id,
    projectName: input.project.name,
    bot: input.bot,
    source: input.source,
    fileName: input.fileName,
    createdAt: Date.now(),
    duration: input.duration,
    stage: first,
    typed: input.typed?.trim() || undefined,
    marks: input.marks?.length ? input.marks : undefined,
    transcript: input.transcript ?? [],
  }
  store.set([meeting, ...store.get()])
  void run(meeting.id, first)
  return meeting
}

/** Runs a failed meeting again from the part that failed. */
export function retryMeeting(meeting: Meeting) {
  void run(meeting.id, meeting.source === "transcript" ? "writing" : "transcribing")
}

export function removeMeeting(id: string) {
  store.set(store.get().filter((m) => m.id !== id))
}

/** Starts an action as a project session; in the mock it's only marked started. */
export function startAction(meetingId: string, momentId: string) {
  update(meetingId, (m) => ({ started: [...(m.started ?? []), momentId] }))
}

const words = (text: string) => new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? [])

const TIME = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d{1,3})?/
const CUE = new RegExp(`^${TIME.source}\\s*-->\\s*${TIME.source}`)
const STAMPED = new RegExp(`^\\[?${TIME.source}\\]?\\s*[-–—]?\\s*(.*)$`)
/** The time in `match`'s groups from `first` on: hours (optional), minutes, seconds. */
const seconds = (match: RegExpMatchArray, first = 1) =>
  Number(match[first] ?? 0) * 3600 + Number(match[first + 1]) * 60 + Number(match[first + 2])

/**
 * A transcript's lines and length, from WebVTT, SubRip, or text whose lines start with a time
 * (`0:42`, `[00:01:15]`). Text without times is spread out at a speaking pace.
 */
export function parseTranscript(text: string): {
  lines: TranscriptLine[]
  duration: number
  /** Whether the text carried its own times, rather than a guess at the pace. */
  timed: boolean
} {
  const rows: { at?: number; text: string }[] = []
  let cue: number | undefined
  let end = 0
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim()
    if (!line || line === "WEBVTT" || /^(NOTE|STYLE|REGION)\b/.test(line)) {
      cue = undefined
      continue
    }
    const timing = line.match(CUE)
    if (timing) {
      cue = seconds(timing)
      end = Math.max(end, seconds(timing, 4))
      continue
    }
    // A SubRip cue's number, or a WebVTT cue's id, on the line before its timing.
    if (/^\d+$/.test(line)) continue
    const stamped = line.match(STAMPED)
    const body = (stamped ? stamped[4] : line).replace(/<[^>]+>/g, "").trim()
    if (!body) continue
    const at = stamped ? seconds(stamped) : cue
    if (cue !== undefined && !stamped && rows.at(-1)?.at === cue) {
      rows[rows.length - 1].text += ` ${body}`
      continue
    }
    rows.push({ at, text: body })
  }
  const timed = rows.some((row) => row.at !== undefined)
  let clockAt = 0
  const out = rows.map((row, index) => {
    const at = timed ? (row.at ?? clockAt) : clockAt
    clockAt = at + Math.max(2, row.text.split(/\s+/).length / 2.5)
    return { id: `l${index}`, at: Math.round(at * 10) / 10, text: row.text }
  })
  return { lines: out, duration: Math.round(Math.max(clockAt, end)), timed }
}

/** Whether a meeting matches a search: its title, project, write-up or transcript. */
export function matchesMeeting(meeting: Meeting, query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const recap = meeting.recap
  const haystack = [
    meeting.title,
    meeting.projectName,
    meeting.fileName,
    recap?.lead,
    ...(recap?.topics.map((t) => `${t.title} ${t.summary}`) ?? []),
    ...(recap?.moments.map((m) => m.text) ?? []),
    ...meeting.transcript.map((l) => l.text),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

/** The bot's canned answer to a question about the meeting, from its recap. */
function answer(meeting: Meeting, question: string) {
  const recap = meeting.recap
  if (!recap) return "I haven't written this meeting up yet."
  const of = (kind: MomentKind) => recap.moments.filter((m) => m.kind === kind)
  const list = (items: Moment[]) => items.map((m) => `- ${m.text}`).join("\n")
  if (/follow|email|send|team/i.test(question))
    return [
      `Here's a follow-up for ${meeting.title}:`,
      `${recap.lead}\n\nWe decided:\n${list(of("decision"))}`,
      `Next:\n${of("action")
        .map((m) => `- ${m.text}${m.owner ? ` (${m.owner})` : ""}`)
        .join("\n")}`,
    ].join("\n\n")
  if (/decid|agree|settle/i.test(question)) return `You decided:\n${list(of("decision"))}`
  if (/open|unanswered|question/i.test(question))
    return of("open").length
      ? `Still open:\n${list(of("open"))}`
      : "Nothing was left open in this one."
  const asked = words(question)
  const topic =
    recap.topics
      .map((t) => ({ t, hits: [...words(`${t.title} ${t.summary}`)].filter((w) => asked.has(w)) }))
      .sort((a, b) => b.hits.length - a.hits.length)[0]?.t ?? recap.topics[0]
  return `That came up in ${topic.title.toLowerCase()} at ${clock(topic.start)}. ${topic.summary}`
}

/** Asks the bot about the meeting; its answer follows a moment later. */
export async function askMeeting(meetingId: string, text: string) {
  const question: Exchange = { id: randomId(), from: "user", text }
  update(meetingId, (m) => ({ chat: [...(m.chat ?? []), question] }))
  await sleep(1_200)
  if (!exists(meetingId)) return
  update(meetingId, (m) => ({
    chat: [...(m.chat ?? []), { id: randomId(), from: "bot", text: answer(m, text) }],
  }))
}

export const isWorking = (meeting: Meeting) =>
  meeting.stage !== "ready" && meeting.stage !== "failed"

/** The topic that holds `seconds`. */
export const topicAt = (recap: Recap, seconds: number) =>
  recap.topics.findLast((t) => t.start <= seconds) ?? recap.topics[0]

/** `4:05`, or `1:02:05` past the hour. */
export function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, "0")
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

/** `7 min`, `1 h 2 min`; under a minute, `40 s`. */
export function length(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const minutes = Math.round(seconds / 60)
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
      return `${meeting.bot.name} is writing it up`
    case "failed":
      return meeting.error ?? "Failed"
    default: {
      const topics = meeting.recap?.topics.length ?? 0
      const todo = meeting.recap?.moments.filter((m) => m.kind === "action").length ?? 0
      return [length(meeting.duration), topics && `${topics} topics`, todo && `${todo} to do`]
        .filter(Boolean)
        .join(" · ")
    }
  }
}

export const MOMENT_TITLES: Record<MomentKind, string> = {
  decision: "Decided",
  action: "To do",
  open: "Open",
}

/** The recap as Markdown, for Copy. */
export function toMarkdown(meeting: Meeting) {
  const recap = meeting.recap
  if (!recap) return `# ${meeting.title}\n`
  const stamp = (at?: number) => (at === undefined ? "" : ` [${clock(at)}]`)
  const groups = (Object.keys(MOMENT_TITLES) as MomentKind[])
    .map((kind) => ({ kind, items: recap.moments.filter((m) => m.kind === kind) }))
    .filter((g) => g.items.length)
    .map(
      (g) =>
        `## ${MOMENT_TITLES[g.kind]}\n\n${g.items
          .map((m) => `- ${m.text}${m.owner ? ` (${m.owner})` : ""}${stamp(m.at)}`)
          .join("\n")}`,
    )
  const topics = recap.topics.map((t) => `### ${t.title}${stamp(t.start)}\n\n${t.summary}`)
  return [`# ${meeting.title}`, recap.lead, ...groups, `## Topics`, ...topics].join("\n\n") + "\n"
}
