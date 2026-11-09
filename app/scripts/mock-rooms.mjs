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

// A room's files (F5): the bytes live in the Host's room store and nowhere else. A file goes up
// against the upload id the app minted — which is what makes a retry the same file rather than a
// second copy — rides a message as a manifest of ids and bounded metadata, and comes back down bound
// to the event it was committed under, behind an address minted for one room, one event and one file.
//
// The test host's own limit, and deliberately smaller than the app's 9 MB intake: a file the composer
// takes has to reach a Host that still refuses it, or no flow could see a refusal at all. The cap is
// this device's way of reaching that leg — a real Host's cap is its own size and its own sentence —
// and the refusal is worded the way the plugin's is.
const ATTACHMENT_BYTES = 2 * 1024 * 1024
/** The same cap in the unit the refusal names, so the sentence and the arithmetic can't drift apart. */
const ATTACHMENT_MB = ATTACHMENT_BYTES / (1024 * 1024)
/** The test host's refusal for a file past its cap, in the plugin's arithmetic and its words. */
const tooLarge = (name) =>
  `${name} is larger than the ${ATTACHMENT_MB} MB limit for a room attachment.`
/** The most files one message may carry, and the kinds the Host stores, both as the plugin's own. */
const ATTACHMENT_MAX = 8
const KINDS = ["image", "pdf", "file"]
/** The four prefixes and two types the plugin's download rule shows in place; everything else saves. */
const shown = (mime) =>
  /^(image|video|audio|text)\//.test(mime) ||
  mime === "application/pdf" ||
  mime === "application/json"
/**
 * A 4×4 PNG of the mock's own making, so a member's reply can carry a picture without this file
 * carrying a binary: two colours, a valid stream, and enough for a cell to paint.
 */
const MEMBER_PHOTO = "hermes-sketch.png"
const MEMBER_PHOTO_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAGElEQVR42mP4//+/dTkDhGSAs4AkA04ZAABpHXnRFgm6AAAAAElFTkSuQmCC",
  "base64",
)

/** The Host's kind for a type: a picture, a PDF, or a file, parameters and case dropped. */
function kindOf(mime) {
  const said = (mime || "").split(";", 1)[0].trim().toLowerCase()
  if (said.startsWith("image/")) return "image"
  if (said === "application/pdf") return "pdf"
  return "file"
}

/** One file into the store, answering the record a message commits under an event. */
function keepFile(store, { name, mime, bytes }) {
  store.minted += 1
  const meta = {
    attachmentId: `att_${store.minted.toString(16)}`,
    kind: kindOf(mime),
    name,
    size: bytes.length,
    mime,
  }
  const record = { meta, bytes, eventId: null, tokens: new Set() }
  store.attachments.set(meta.attachmentId, record)
  return record
}

/**
 * The files a message names, as the store's own records, or the sentence that refuses it.
 *
 * The plugin's `_manifest`, in the plugin's own words: the app sends back the five fields the Host
 * stored a file under, so a row missing one of them names no file a screen could draw and is refused
 * here rather than by the Host — whose refusal would name a field of its own contract. A message
 * carries a bounded few, each of them once, and every id names a file this store holds.
 */
function manifestOf(files, store) {
  const needed = "An attachment needs the id, kind, name, size and type the Host stored it under."
  if (files === undefined || files === null) return { carried: [] }
  if (!Array.isArray(files)) return { refused: "A message's attachments are the files it carries." }
  if (files.length > ATTACHMENT_MAX)
    return { refused: `A message carries at most ${ATTACHMENT_MAX} attachments.` }
  const named = []
  for (const one of files) {
    const row = one && typeof one === "object" ? one : {}
    const holds = (field) => typeof row[field] === "string" && row[field] !== ""
    if (
      !holds("attachmentId") ||
      !holds("name") ||
      !holds("mime") ||
      !KINDS.includes(row.kind) ||
      !Number.isInteger(row.size) ||
      row.size <= 0
    )
      return { refused: needed }
    named.push(row.attachmentId)
  }
  if (new Set(named).size !== named.length)
    return { refused: "A message carries each attachment once." }
  const carried = []
  for (const id of named) {
    const record = store.attachments.get(id)
    if (!record) return { refused: needed }
    carried.push(record)
  }
  return { carried }
}

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
  return {
    rooms: new Map([[room.room_id, room]]),
    // One file the store holds, by the id this mock minted: its manifest, its bytes, the event it
    // was committed under once a message carries it, and the last token minted for it.
    attachments: new Map(),
    // The upload id the app minted, and the file it became: an upload is idempotent per id.
    uploads: new Map(),
    // The count attachment ids are minted from, and the count addresses' tokens are minted from:
    // two counters, so a minted address never moves the id a later file is stored under.
    minted: 0,
    tokens: 0,
  }
}

/**
 * One room as the chat list carries it: what a device merges, and nothing of its transcript. A room
 * the Host has disbanded is the row's deletion, which is what the plugin projects for one.
 */
function record(room) {
  if (room.disbanded_at) return { at: room.disbanded_at, deleted: true }
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
    // A message may carry files: the row names them in the same camelCase the app draws a cell by,
    // and a row with none keeps no key at all, so nothing draws an empty gallery.
    ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
  }
}

function say(room, id, text, file) {
  const seated = room.members.find((one) => one.member_id === id)
  const row = event(
    room,
    "message.member",
    { kind: "member", id, profile: seated.profile, display_name: seated.display_name },
    {
      text,
      member_id: id,
      thread_id: "room-thread",
      ...(file ? { attachments: [file.meta] } : {}),
    },
  )
  room.events.push(row)
  // The store commits a file to the event that carries it: a reply's own picture is readable through
  // that reply's address and no other.
  if (file) file.eventId = row.event_id
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
function rounds(store, room, noteEvent, text = "", image = false) {
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

  // The round works the room's own roster, by position: a room the app made seats ids it minted, and
  // the Host never invents one of its own for a member it was handed (rooms.py, ADR 0124).
  const first = room.members[0]?.member_id ?? "m1"
  const second = room.members[1]?.member_id ?? "m2"
  step(0, working([
    { memberId: first, status: "running" },
    { memberId: second, status: "queued" },
  ]))
  // The first round: the first member answers, and the second passes — silence, which the room draws
  // as nothing.
  // A message that carried a picture is answered with one: a member's own media is a file of the
  // store's, committed to the reply's event, so it draws exactly as the user's does.
  step(ROUND, () => {
    say(
      room,
      first,
      "I'll take the API and the routes.",
      image
        ? keepFile(store, { name: MEMBER_PHOTO, mime: "image/png", bytes: MEMBER_PHOTO_BYTES })
        : undefined,
    )
    room.activity = [{ memberId: second, status: "running" }]
  })
  step(PASS, () => {
    room.events.push(
      event(
        room,
        "turn.settled",
        { kind: "gateway", id: "gw-1" },
        {
          member_id: second,
          thread_id: "room-thread",
          passed: true,
        },
      ),
    )
  })
  // The second round: Coder answers the reply it read.
  step(SECOND, () => {
    say(room, second, "Coder here. I'll take the screen and the tests.")
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

export async function handleRooms(req, res, path, { json, readBody, readRaw, noteEvent }, store) {
  if (!path.startsWith("/api/plugins/gots/rooms")) return false
  const fail = (status, message) => json(res, status, { error: { message } })
  if (path === "/api/plugins/gots/rooms" && req.method === "POST") {
    // A room made from the app (`rooms.create`): the id is the app's, so a retried create is the same
    // room; the roster's rules are the Host's, and its refusal says which in its own words.
    const body = await readBody(req)
    const roomId = typeof body?.room_id === "string" ? body.room_id.trim() : ""
    if (!roomId) return (fail(400, "A room needs the room_id the app minted for it."), true)
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name) return (fail(400, "A room needs a name."), true)
    const rows = Array.isArray(body?.members) ? body.members : []
    if (rows.length < 2 || rows.length > 6)
      return (fail(400, "members must contain between 2 and 6 entries"), true)
    const handles = rows.map((one) => String(one?.handle ?? ""))
    if (
      new Set(handles).size !== handles.length ||
      handles.some((handle) => handle === "all" || handle === "everyone")
    )
      return (fail(400, "member handles must be unique and cannot reserve @all or @everyone"), true)
    // The Host is idempotent on the room's id: the same id twice is the same room, not a second one.
    const known = store.rooms.get(roomId)
    if (known) return (json(res, 200, { object: "gots.room.record", ...record(known) }), true)
    const now = Date.now()
    const room = {
      room_id: roomId,
      name,
      members: rows.map((one) => ({
        member_id: one?.memberId,
        profile: one?.profile,
        handle: one?.handle,
        display_name: one?.displayName,
      })),
      seq: 0,
      events: [],
      working: false,
      activity: [],
      waiting: [],
      at: now,
      created_at: now,
      timers: [],
    }
    store.rooms.set(roomId, room)
    noteEvent("room", roomId)
    return (json(res, 200, { object: "gots.room.record", ...record(room) }), true)
  }
  const disband = /^\/api\/plugins\/gots\/rooms\/([^/]+)\/disband$/.exec(path)
  if (disband && req.method === "POST") {
    const id = decodeURIComponent(disband[1])
    const room = store.rooms.get(id)
    if (!room) return (fail(404, "This host has no such room."), true)
    // The Host stops the room's work and leaves a tombstone: every device's next merge reads the room
    // as the row's deletion, which is what the plugin projects for a disbanded room.
    for (const timer of room.timers) clearTimeout(timer)
    room.disbanded_at = Date.now()
    noteEvent("room", id)
    return (json(res, 200, { object: "gots.room.record", at: room.disbanded_at, deleted: true }), true)
  }
  const rename = /^\/api\/plugins\/gots\/rooms\/([^/]+)$/.exec(path)
  if (rename && req.method === "POST") {
    const room = store.rooms.get(decodeURIComponent(rename[1]))
    if (!room) return (fail(404, "This host has no such room."), true)
    const body = await readBody(req)
    const name = typeof body?.name === "string" ? body.name.trim() : ""
    if (!name) return (fail(400, "A room needs a name."), true)
    if (typeof body?.event_id !== "string" || !body.event_id)
      return (fail(400, "A rename needs the event_id the app minted for it."), true)
    room.name = name
    room.at = Date.now()
    noteEvent("room", room.room_id)
    return (json(res, 200, { object: "gots.room.record", ...record(room) }), true)
  }
  const upload = /^\/api\/plugins\/gots\/rooms\/([^/]+)\/attachment$/.exec(path)
  if (upload && req.method === "POST") {
    const room = store.rooms.get(decodeURIComponent(upload[1]))
    if (!room) return (fail(404, "This host has no such room."), true)
    const query = new URL(req.url, "http://mock").searchParams
    const uploadId = query.get("upload_id") ?? ""
    if (!uploadId) return (fail(400, "An upload needs the upload_id the app minted for it."), true)
    const name = query.get("name") ?? ""
    if (!name) return (fail(400, "An upload needs the name of the file."), true)
    // The store is idempotent on the upload id: the same id twice is the same file, not a second.
    const known = store.uploads.get(uploadId)
    if (known) {
      const held = store.attachments.get(known).meta
      json(res, 200, { object: "gots.room.attachment", attachment: held })
      return true
    }
    // The body is the file itself, and its type is the request's content type: what the store keeps
    // and what decides the file's kind. A body past the cap is refused before it is read — the
    // length is on the request, so a file the store will not take costs a header and not its bytes —
    // and the read's own check stays as the second line, for a request that declares no length.
    const mime =
      (req.headers["content-type"] ?? "").split(";", 1)[0].trim() || "application/octet-stream"
    if (Number(req.headers["content-length"] ?? 0) > ATTACHMENT_BYTES) {
      return (fail(413, tooLarge(name)), true)
    }
    const bytes = await readRaw(req)
    if (!bytes.length) return (fail(400, "The file is empty."), true)
    if (bytes.length > ATTACHMENT_BYTES) return (fail(413, tooLarge(name)), true)
    const record = keepFile(store, { name, mime, bytes })
    store.uploads.set(uploadId, record.meta.attachmentId)
    json(res, 200, { object: "gots.room.attachment", attachment: record.meta })
    return true
  }
  const sign = /^\/api\/plugins\/gots\/rooms\/([^/]+)\/attachment\/url$/.exec(path)
  if (sign && req.method === "POST") {
    const room = store.rooms.get(decodeURIComponent(sign[1]))
    if (!room) return (fail(404, "This host has no such room."), true)
    const body = await readBody(req)
    const eventId = typeof body?.event_id === "string" ? body.event_id : ""
    const attachmentId = typeof body?.attachment_id === "string" ? body.attachment_id : ""
    if (!eventId || !attachmentId) {
      return (fail(400, "An attachment's address needs its event_id and attachment_id."), true)
    }
    // Nothing is read into the app here, and the attachment is looked up only to bind the token to
    // it: like the plugin's own route, this mints an address for one room, one event and one file,
    // and the route it names is where the file's own answer lives. The token is the mock's own
    // opaque string, bound to that file.
    // A signature is stateless: every mint for a file is worth the same until it runs out, so two
    // addresses for one file both work — which is what the plugin's own HMAC gives, and what a cell
    // asked twice (a render, then a cache copy) needs.
    store.tokens += 1
    const token = `t_${store.tokens.toString(16)}`
    const record = store.attachments.get(attachmentId)
    if (record) record.tokens.add(token)
    const base = `/api/plugins/gots/rooms/${encodeURIComponent(room.room_id)}/attachment`
    const url = new URL(`${base}/${encodeURIComponent(attachmentId)}`, `http://${req.headers.host}`)
    url.searchParams.set("event", eventId)
    url.searchParams.set("token", token)
    json(res, 200, {
      object: "gots.room.attachment_url",
      path: `room/${room.room_id}/${eventId}/${attachmentId}`,
      url: url.toString(),
      expires: Math.floor(Date.now() / 1000) + 300,
    })
    return true
  }
  const bytes = /^\/api\/plugins\/gots\/rooms\/([^/]+)\/attachment\/([^/]+)$/.exec(path)
  if (bytes && req.method === "GET") {
    const query = new URL(req.url, "http://mock").searchParams
    const eventId = query.get("event") ?? ""
    const token = query.get("token") ?? ""
    // The signature is the permission: an address that doesn't cover this room's event and this file
    // is refused before anything is read, as the plugin refuses one that is forged or has run out.
    const record = store.attachments.get(decodeURIComponent(bytes[2]))
    if (!record || !record.tokens.has(token) || record.eventId !== eventId) {
      return (fail(403, "That address has run out."), true)
    }
    const headers = {
      "Content-Type": record.meta.mime,
      "Accept-Ranges": "none",
      // The app is another origin: a cell paints from this URL, and the copy it keeps is a fetch of
      // the same bytes, which a browser only hands over with this.
      "Access-Control-Allow-Origin": "*",
    }
    // What a browser shows comes in place; everything else is handed over as a download named as
    // the file, the way the plugin's route answers.
    if (!shown(record.meta.mime)) {
      const named = record.meta.name.replace(/[^A-Za-z0-9._ ()-]/g, "_")
      headers["Content-Disposition"] = `attachment; filename="${named}"`
    }
    res.writeHead(200, headers)
    res.end(record.bytes)
    return true
  }
  const send = /^\/api\/plugins\/gots\/rooms\/([^/]+)\/send$/.exec(path)
  if (send && req.method === "POST") {
    const room = store.rooms.get(decodeURIComponent(send[1]))
    if (!room) return (fail(404, "This host has no such room."), true)
    const body = await readBody(req)
    const text = typeof body?.text === "string" ? body.text.trim() : ""
    const eventId = typeof body?.event_id === "string" ? body.event_id : ""
    if (!eventId) return (fail(400, "A message needs the event_id the app minted for it."), true)
    // The files a message names are the store's already: a manifest is the five fields a file was
    // stored under, at most eight of them and each once, and a message may be files alone, as a
    // room's photo is sent. This is the plugin's own rule, so the mock refuses what the plugin
    // refuses — in its sentences, with no event appended — rather than answering a message the Host
    // would never have carried.
    const files = manifestOf(body?.attachments, store)
    if (files.refused) return (fail(400, files.refused), true)
    const carried = files.carried
    if (!text && !carried.length) {
      return (fail(400, "A message needs words or files to send."), true)
    }
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
        ...(carried.length ? { attachments: carried.map((one) => one.meta) } : {}),
      },
    )
    room.events.push(appended)
    // The store commits each file to the event it was sent under: from here it is readable through
    // that event's address and no other.
    for (const one of carried) one.eventId = appended.event_id
    room.at = Date.now()
    noteEvent("room", room.room_id)
    rounds(store, room, noteEvent, text, carried.some((one) => one.meta.kind === "image"))
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
