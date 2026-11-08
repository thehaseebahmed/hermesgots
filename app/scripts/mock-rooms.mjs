// The Gots plugin's rooms (rooms.py), for the mock Hermes server: one room of two bots of this
// Host, its chat-list record, one read of its log and live state, and the rounds a send wakes.
// MOCK_ROOMS=0 serves a plugin from before them — no routes, no `rooms` feature, no row.
//
// The rounds are the Host's own behaviour, not the app's: a mention scopes nothing here, so the
// members answer in turn, one of them passes, and the third round is the bound (v1's rules). A send
// is inert — it appends one event — and the driver works it afterwards with no client attached,
// which is what the app's screen reads back.
//
// What a send asks for decides the round it runs, so a flow can ask for one thing at a time:
//   "clean the build"  — the first member opens an approval, Once or Deny, and its turn waits;
//   "which database?"  — the second member asks a question with two choices, and waits on it;
//   "hand it to @user" — a member ends addressed to @user, which is the room's needs-you mark;
//   "hold a while"     — a round that runs long enough for Stop to land in the middle of it;
//   anything else      — the three rounds the room usually runs.

const MEMBERS = [
  { member_id: "m1", profile: "default", handle: "hermes", display_name: "Hermes" },
  { member_id: "m2", profile: "coder", handle: "coder", display_name: "Coder" },
]

/** The three rounds a send wakes, in milliseconds after it: who answers, and who passes. */
const ROUND = 700
const PASS = 1_400
const SECOND = 2_100
const BOUND = 2_900
/** A round long enough to be stopped mid-flight ("hold a while"). */
const HOLD = 8_000

/** The approval a member opens, with the four coordinates the Host's own approve resolves. */
const APPROVAL = {
  kind: "approval",
  memberId: "m1",
  taskId: "dtask:1",
  generation: 1,
  requestId: "approval-1",
  command: "rm -rf build",
  description: "Clear the build",
}

/** The question a member asks, with the choices it offers. */
const QUESTION = {
  kind: "question",
  memberId: "m2",
  questionId: "srq-1",
  questions: [
    { id: "q0", question: "Which database?", choices: ["Postgres", "SQLite"], multiSelect: false },
  ],
}

const memberRow = (member) => ({
  memberId: member.member_id,
  profile: member.profile,
  handle: member.handle,
  ...(member.display_name ? { displayName: member.display_name } : {}),
})

export function createRoomStore() {
  const now = Date.now()
  const room = {
    room_id: "room-planning",
    name: "Planning",
    members: MEMBERS,
    seq: 0,
    events: [],
    working: false,
    activity: [],
    // What the room waits on the user for: an approval or a question, and nothing at rest.
    waiting: [],
    at: now,
    created_at: now,
    timers: [],
  }
  return { rooms: new Map([[room.room_id, room]]) }
}

/** One room as the chat list carries it: what a device merges, and nothing of its transcript. */
function record(room) {
  return {
    at: room.at,
    value: {
      title: room.name,
      createdAt: room.created_at,
      updatedAt: room.at,
      room: { id: room.room_id, members: room.members.map(memberRow) },
    },
  }
}

/** Every room the mock Host hosts, as the chat list's records, keyed by the room's id. */
export function roomRecords(store) {
  return Object.fromEntries([...store.rooms.keys()].map((id) => [id, record(store.rooms.get(id))]))
}

function event(room, kind, actor, payload) {
  room.seq += 1
  return {
    room_id: room.room_id,
    seq: room.seq,
    event_id: `room-e${room.seq}`,
    kind,
    actor,
    payload,
    created_at: Date.now() / 1000,
    idempotent: false,
  }
}

/** One event in the app's words, as the plugin's seam hands it over. */
function drawnEvent(row) {
  const payload = row.payload ?? {}
  const actor = row.actor ?? {}
  const member = actor.kind === "member" ? actor.id : payload.member_id
  const reason = payload.reason || payload.reason_code
  return {
    seq: row.seq,
    eventId: row.event_id,
    kind: row.kind,
    ...(typeof payload.text === "string" ? { text: payload.text } : {}),
    ...(member ? { memberId: member } : {}),
    ...(actor.display_name ? { name: actor.display_name } : {}),
    ...(typeof payload.status === "string" ? { status: payload.status } : {}),
    ...(reason ? { reason } : {}),
    ...(typeof payload.error === "string" ? { error: payload.error } : {}),
  }
}

function say(room, id, text) {
  const seated = room.members.find((one) => one.member_id === id)
  room.events.push(
    event(
      room,
      "message.member",
      { kind: "member", id, profile: seated.profile, display_name: seated.display_name },
      {
        text,
        member_id: id,
        thread_id: "room-thread",
      },
    ),
  )
  room.at = Date.now()
}

/** The room at rest: no member at work, whatever it still waits on. */
function rest(room) {
  room.working = false
  room.activity = []
}

/** The round settled, which a room's screen draws as nothing at all. */
function settles(room) {
  room.events.push(
    event(room, "room.activity", { kind: "gateway", id: "gw-1" }, {
      status: "settled",
      thread_id: "room-thread",
    }),
  )
}

/** What the rounds a send wakes do to the room, one step at a time. */
function rounds(room, noteEvent, text = "") {
  // One round at a time, as the Host's driver runs it: a second send waits for the round in hand
  // rather than stacking a second timeline on the same room.
  for (const timer of room.timers) clearTimeout(timer)
  room.timers = []
  const step = (at, run) =>
    room.timers.push(
      setTimeout(() => {
        run()
        noteEvent("room", room.room_id)
      }, at),
    )
  const working = (activity) => () => {
    room.working = true
    room.activity = activity
  }

  if (/clean/i.test(text)) {
    // A member's turn opens an approval and waits for the Host's own answer: the room draws the
    // card until Once or Deny arrives, and nothing else happens in the room meanwhile.
    step(0, working([{ memberId: "m1", status: "running" }]))
    step(ROUND, () => {
      room.waiting = [APPROVAL]
    })
    return
  }
  if (/which database|question/i.test(text)) {
    step(0, working([{ memberId: "m2", status: "running" }]))
    step(ROUND, () => {
      room.waiting = [QUESTION]
    })
    return
  }
  if (/@user/i.test(text)) {
    // The round settles addressed to the user, which is the room's needs-you mark: no call, no
    // round in the way — just the last words of a member.
    step(0, working([{ memberId: "m1", status: "running" }]))
    step(ROUND, () => say(room, "m1", "That one is yours to call, @user."))
    step(PASS, () => {
      rest(room)
      settles(room)
    })
    return
  }
  if (/hold/i.test(text)) {
    // A round with time in it, so a Stop lands while a member is still working.
    step(0, working([
      { memberId: "m1", status: "running" },
      { memberId: "m2", status: "queued" },
    ]))
    step(HOLD, () => say(room, "m1", "Still working on it."))
    return
  }

  step(0, working([
    { memberId: "m1", status: "running" },
    { memberId: "m2", status: "queued" },
  ]))
  // The first round: Hermes answers, and Coder passes — silence, which the room draws as nothing.
  step(ROUND, () => {
    say(room, "m1", "I'll take the API and the routes.")
    room.activity = [{ memberId: "m2", status: "running" }]
  })
  step(PASS, () => {
    room.events.push(
      event(
        room,
        "turn.settled",
        { kind: "gateway", id: "gw-1" },
        {
          member_id: "m2",
          thread_id: "room-thread",
          passed: true,
        },
      ),
    )
  })
  // The second round: Coder answers the reply it read.
  step(SECOND, () => {
    say(room, "m2", "Coder here. I'll take the screen and the tests.")
  })
  // The third round is the bound: a room works at most three rounds, and says so.
  step(BOUND, () => {
    room.events.push(
      event(
        room,
        "room.activity",
        { kind: "gateway", id: "gw-1" },
        {
          status: "bounded",
          reason_code: "max_rounds",
          thread_id: "room-thread",
        },
      ),
    )
    room.at = Date.now()
    rest(room)
  })
}

export async function handleRooms(req, res, path, { json, readBody, noteEvent }, store) {
  if (!path.startsWith("/api/plugins/gots/rooms")) return false
  const fail = (status, message) => json(res, status, { error: { message } })
  if (path === "/api/plugins/gots/rooms" && req.method === "POST") {
    // Creating a room is a later step's (the plugin's own route is what the app will call); the
    // mock keeps the one it hosts, which is what a device lists.
    return (fail(405, "This host's rooms are made on its desktop."), true)
  }
  const send = /^\/api\/plugins\/gots\/rooms\/([^/]+)\/send$/.exec(path)
  if (send && req.method === "POST") {
    const room = store.rooms.get(decodeURIComponent(send[1]))
    if (!room) return (fail(404, "This host has no such room."), true)
    const body = await readBody(req)
    const text = typeof body?.text === "string" ? body.text.trim() : ""
    const eventId = typeof body?.event_id === "string" ? body.event_id : ""
    if (!eventId) return (fail(400, "A message needs the event_id the app minted for it."), true)
    if (!text) return (fail(400, "A message needs words to send."), true)
    // The Host is idempotent on the event id: the same id twice is the same message, not a second.
    const known = room.events.find((one) => one.event_id === eventId)
    if (known) {
      json(res, 200, { object: "gots.room.sent", event: drawnEvent(known) })
      return true
    }
    const appended = event(
      room,
      "message.user",
      { kind: "user", id: "user" },
      {
        text,
        thread_id: eventId,
      },
    )
    room.events.push(appended)
    room.at = Date.now()
    noteEvent("room", room.room_id)
    rounds(room, noteEvent, text)
    json(res, 200, { object: "gots.room.sent", event: drawnEvent(appended) })
    return true
  }
  const approve = /^\/api\/plugins\/gots\/rooms\/([^/]+)\/approve$/.exec(path)
  if (approve && req.method === "POST") {
    const room = store.rooms.get(decodeURIComponent(approve[1]))
    if (!room) return (fail(404, "This host has no such room."), true)
    const body = await readBody(req)
    const held = room.waiting.find((one) => one.kind === "approval")
    if (!held) return (fail(400, "room approval is no longer pending"), true)
    // The Host's own approve resolves the exact request the app named, and takes Once or Deny only.
    if (
      body?.member_id !== held.memberId ||
      body?.task_id !== held.taskId ||
      body?.execution_generation !== held.generation ||
      body?.request_id !== held.requestId
    ) {
      return (fail(400, "room approval is no longer pending"), true)
    }
    if (body?.choice !== "once" && body?.choice !== "deny") {
      return (fail(400, "room approval choice must be once or deny"), true)
    }
    room.waiting = room.waiting.filter((one) => one !== held)
    if (body.choice === "once") {
      say(room, "m1", "Approved — clearing the build.")
    } else {
      room.events.push(
        event(room, "turn.cancelled", { kind: "gateway", id: "gw-1" }, {
          member_id: "m1",
          thread_id: "room-thread",
          reason: "denied",
        }),
      )
    }
    settles(room)
    room.at = Date.now()
    rest(room)
    noteEvent("room", room.room_id)
    json(res, 200, { object: "gots.room.approved", approved: true, choice: body.choice })
    return true
  }
  const answer = /^\/api\/plugins\/gots\/rooms\/([^/]+)\/answer$/.exec(path)
  if (answer && req.method === "POST") {
    const room = store.rooms.get(decodeURIComponent(answer[1]))
    if (!room) return (fail(404, "This host has no such room."), true)
    const body = await readBody(req)
    const held = room.waiting.find((one) => one.kind === "question")
    if (!held || body?.question_id !== held.questionId) {
      return (fail(409, "That question isn't waiting for an answer any more."), true)
    }
    const given = body?.answers ?? {}
    room.waiting = room.waiting.filter((one) => one !== held)
    say(room, "m2", `${given.q0 ?? "Your call"} it is — I'll take that.`)
    settles(room)
    room.at = Date.now()
    rest(room)
    noteEvent("room", room.room_id)
    json(res, 200, { object: "gots.room.answered", questionId: held.questionId })
    return true
  }
  const stop = /^\/api\/plugins\/gots\/rooms\/([^/]+)\/stop$/.exec(path)
  if (stop && req.method === "POST") {
    const room = store.rooms.get(decodeURIComponent(stop[1]))
    if (!room) return (fail(404, "This host has no such room."), true)
    const body = await readBody(req)
    for (const timer of room.timers) clearTimeout(timer)
    room.timers = []
    const working = room.activity.map((one) => one.memberId)
    room.events.push(
      event(room, "room.stop_requested", { kind: "user", id: "user" }, {
        thread_id: "room-thread",
        ...(body?.cancel_id ? { cancel_id: body.cancel_id } : {}),
      }),
    )
    room.events.push(
      event(room, "turn.cancelled", { kind: "gateway", id: "gw-1" }, {
        member_id: working[0] ?? "m1",
        thread_id: "room-thread",
        reason: "stopped",
      }),
    )
    room.waiting = []
    room.at = Date.now()
    rest(room)
    noteEvent("room", room.room_id)
    json(res, 200, { object: "gots.room.stopped", cancelled: Math.max(1, working.length) })
    return true
  }
  const read = /^\/api\/plugins\/gots\/rooms\/([^/]+)$/.exec(path)
  if (read && req.method === "GET") {
    const room = store.rooms.get(decodeURIComponent(read[1]))
    if (!room) return (fail(404, "This host has no such room."), true)
    const since = Number(new URL(req.url, "http://mock").searchParams.get("since") ?? 0) || 0
    const events = room.events.filter((one) => one.seq > since).map(drawnEvent)
    json(res, 200, {
      object: "gots.room",
      room: { id: room.room_id, name: room.name, members: room.members.map(memberRow) },
      events,
      cursor: events.length ? events[events.length - 1].seq : since,
      latestSeq: room.seq,
      hasMore: false,
      working: room.working,
      activity: room.activity,
      waiting: room.waiting,
      canStop: true,
      canSend: true,
    })
    return true
  }
  return false
}
