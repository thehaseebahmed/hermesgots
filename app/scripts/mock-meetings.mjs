// The Gots plugin's meetings (meetings.py), for the mock Hermes server. A recording arrives in byte
// chunks, `finish` starts the host: it "transcribes" three windows 0.6s apart, writes the notes for
// 1s and delivers them. A transcript the app parsed goes straight to the notes. The canned
// transcript and notes carry one bullet with no source and actions with no named owner, as the
// host's check leaves them. A recording titled with "flaky" fails the transcription of its second
// window once, to show Try again, which resumes from that window. MOCK_MEETINGS_AUDIO=off is a host that can't
// transcribe a recording, so only a transcript is taken.

const TRANSCRIPT = [
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
].map(([at, text]) => ({ at, text }))

const NO_OWNER = "Owner not stated"
const stamp = (at) => {
  const s = Math.floor(at)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n) => String(n).padStart(2, "0")
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}
const item = (text, ats, extra = {}) => ({
  text,
  cites: ats.map(stamp),
  unsourced: ats.length === 0,
  ...extra,
})

const NOTES = {
  summary:
    "The team kept the beta on Thursday with a freeze on Tuesday, left the sidebar alone until after it, and turned push for a finished run off by default.",
  key_points: [
    item("Push on Android has not been tried on a real phone.", [48]),
    item("Testers found Research in its new place without asking.", [171]),
  ],
  decisions: [
    item("Beta on Thursday, with a freeze on Tuesday.", [21]),
    item("No sidebar changes before the beta.", [205]),
    item("A finished run does not push by default.", [309]),
  ],
  action_items: [
    item("Get two people to install the APK this week.", [83], { owner: NO_OWNER }),
    item("Send the Android tester link.", [112], { owner: NO_OWNER }),
    item("Write the beta announcement.", [], { owner: NO_OWNER }),
  ],
  open_questions: [item("Does the registry need a status page?", [338])],
}

function notesFor(lines) {
  return {
    summary: `${lines.length} lines were said. The first was: ${lines[0].text}`,
    key_points: lines.slice(0, 2).map((line) => item(line.text, [line.at])),
    decisions: [],
    action_items: [],
    open_questions: [],
  }
}

const meetings = new Map()
const WINDOWS = 3
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const view = (m, full) => ({
  id: m.id,
  title: m.title,
  project_id: m.project_id,
  kind: m.kind,
  stage: m.stage,
  parts: m.parts,
  parts_stored: m.stored.size,
  parts_done: m.done,
  error: m.error,
  duration: m.duration,
  created_at: m.created_at,
  updated_at: m.updated_at,
  ...(full ? { transcript: m.transcript, notes: m.notes } : {}),
})

export const audioOff = () => process.env.MOCK_MEETINGS_AUDIO === "off"

async function run(m, note) {
  const change = (fields) => {
    Object.assign(m, fields, { updated_at: Date.now() })
    note(m.id)
  }
  if (m.stage === "transcribing") {
    if (!m.windows) change({ windows: true, parts: WINDOWS, done: 0 })
    while (m.done < WINDOWS) {
      await sleep(600)
      if (!meetings.has(m.id)) return
      if (m.done === 1 && m.flaky) {
        m.flaky = false
        return change({ error: "The host couldn't transcribe part 2 of 3." })
      }
      change({ done: m.done + 1 })
    }
    change({ stage: "writing", transcript: TRANSCRIPT, duration: 402 })
  }
  if (m.stage === "writing") {
    await sleep(1000)
    if (!meetings.has(m.id)) return
    change({ stage: "ready", notes: m.kind === "transcript" ? notesFor(m.transcript) : NOTES })
  }
}

export async function handleMeetings(req, res, path, { json, readBody, noteEvent }) {
  if (!path.startsWith("/api/plugins/memento/meetings")) return false
  const note = (id) => noteEvent("meetings", id)
  const fail = (status, message) => json(res, status, { error: { message } })
  const answer = (m) => json(res, 200, { object: "memento.meeting", meeting: view(m, true) })
  if (path === "/api/plugins/memento/meetings") {
    if (req.method === "GET") {
      const rows = [...meetings.values()].sort((a, b) => b.created_at - a.created_at)
      json(res, 200, {
        object: "memento.meetings",
        meetings: rows.map((m) => view(m, false)),
        unavailable: audioOff() ? "faster-whisper isn't installed on the host." : null,
      })
      return true
    }
    const body = await readBody(req)
    const title = String(body.title ?? "").trim()
    if (!title) return (fail(400, "A title is required."), true)
    const now = Date.now()
    const base = {
      id: `m_${Math.random().toString(16).slice(2, 18)}`,
      title,
      project_id: body.project_id ?? null,
      error: null,
      done: 0,
      stored: new Map(),
      flaky: /flaky/i.test(title),
      transcript: [],
      notes: null,
      created_at: now,
      updated_at: now,
    }
    let m
    if (body.transcript !== undefined) {
      const lines = (Array.isArray(body.transcript) ? body.transcript : [])
        .filter((l) => typeof l?.text === "string" && l.text.trim() && Number.isFinite(l.at))
        .map((l) => ({ at: Math.floor(l.at), text: l.text.trim() }))
      if (!lines.length) return (fail(400, "The transcript is empty."), true)
      m = {
        ...base,
        kind: "transcript",
        stage: "writing",
        parts: 0,
        transcript: lines,
        duration: lines.at(-1).at,
      }
    } else {
      if (audioOff()) return (fail(501, "faster-whisper isn't installed on the host."), true)
      if (!Number.isInteger(body.parts) || body.parts < 1)
        return (fail(400, "Say how many chunks the recording has."), true)
      m = { ...base, kind: "audio", stage: "uploading", parts: body.parts, duration: 0 }
    }
    meetings.set(m.id, m)
    note(m.id)
    if (m.stage === "writing") void run(m, note)
    json(res, 201, { object: "memento.meeting", meeting: view(m, true) })
    return true
  }
  const match = /^\/api\/plugins\/memento\/meetings\/([^/]+)(?:\/(\w+))?$/.exec(path)
  const m = match && meetings.get(decodeURIComponent(match[1]))
  if (!m) return (fail(404, "No such meeting."), true)
  const action = match[2]
  if (!action) return (answer(m), true)
  if (action === "parts") {
    const n = Number(new URL(req.url, "http://x").searchParams.get("n"))
    let size = 0
    for await (const chunk of req) size += chunk.length
    if (m.stage !== "uploading") return (fail(409, "This meeting isn't taking audio."), true)
    if (!Number.isInteger(n) || n < 0 || n >= m.parts)
      return (fail(400, "That chunk isn't one of the meeting's."), true)
    if (!size) return (fail(400, "The chunk is empty."), true)
    m.stored.set(n, size)
    m.updated_at = Date.now()
    note(m.id)
    return (answer(m), true)
  }
  if (action === "finish") {
    if (m.kind !== "audio" || m.stage !== "uploading")
      return (fail(409, "This meeting isn't taking audio."), true)
    if (m.stored.size < m.parts)
      return (
        fail(409, `${m.parts - m.stored.size} of the ${m.parts} chunks haven't arrived.`),
        true
      )
    Object.assign(m, { stage: "transcribing", updated_at: Date.now() })
    note(m.id)
    void run(m, note)
    return (answer(m), true)
  }
  if (action === "retry") {
    if (!m.error) return (fail(409, "This meeting hasn't failed."), true)
    Object.assign(m, { error: null, updated_at: Date.now() })
    note(m.id)
    void run(m, note)
    return (answer(m), true)
  }
  if (action === "remove") {
    meetings.delete(m.id)
    note(m.id)
    json(res, 200, { object: "memento.meeting.removed", removed: true })
    return true
  }
  return (fail(404, "No such action."), true)
}
