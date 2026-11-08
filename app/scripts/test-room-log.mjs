import assert from "node:assert/strict"
import test from "node:test"

import {
  askingMember,
  foldRoom,
  memberLabel,
  memberName,
  newestSeq,
  queuedMembers,
  workingLine,
  workingMembers,
} from "../src/lib/room-log.ts"

const members = [
  { memberId: "m1", profile: "default", handle: "hermes", displayName: "Hermes" },
  { memberId: "m2", profile: "coder", handle: "coder", displayName: "Coder" },
  { memberId: "m3", profile: "writer", handle: "writer" },
]

const user = (seq, text) => ({ seq, eventId: `e${seq}`, kind: "message.user", text, at: 1 })
const reply = (seq, memberId, text, name) => ({
  seq,
  eventId: `e${seq}`,
  kind: "message.member",
  text,
  memberId,
  ...(name ? { name } : {}),
})

test("a room folds into the user's message, each member's reply, and nothing of the round's own rows", () => {
  const rows = foldRoom(
    [
      user(1, "who is free?"),
      reply(2, "m1", "me", "Hermes"),
      { seq: 3, eventId: "e3", kind: "turn.started", memberId: "m2" },
      { seq: 4, eventId: "e4", kind: "turn.settled", memberId: "m2", passed: true },
      { seq: 5, eventId: "e5", kind: "room.activity", status: "settled" },
      reply(6, "m2", "and me", "Coder"),
    ],
    members,
  )
  assert.deepEqual(
    rows.map((row) => [row.kind, row.text]),
    [
      ["user", "who is free?"],
      ["member", "me"],
      ["member", "and me"],
    ],
  )
  assert.equal(rows[1].name, "Hermes")
  assert.equal(rows[1].memberId, "m1")
})

test("a member that passed draws nothing at all", () => {
  const rows = foldRoom(
    [
      user(1, "anyone?"),
      { seq: 2, eventId: "e2", kind: "turn.settled", memberId: "m2", passed: true },
    ],
    members,
  )
  assert.deepEqual(rows.map((row) => row.kind), ["user"], "silence is not a row")
})

test("a round the host bounded says so, once, in the host's own reason", () => {
  const rows = foldRoom(
    [
      user(1, "go on"),
      { seq: 2, eventId: "e2", kind: "room.activity", status: "bounded", reason: "max_rounds" },
    ],
    members,
  )
  assert.deepEqual(rows.at(-1), {
    seq: 2,
    kind: "notice",
    text: "The room stopped at its round limit.",
    eventId: "e2",
  })
})

test("a turn that failed carries what the host said failed", () => {
  const rows = foldRoom(
    [{ seq: 1, eventId: "e1", kind: "turn.failed", memberId: "m1", error: "rate limited" }],
    members,
  )
  assert.equal(rows[0].kind, "notice")
  assert.match(rows[0].text, /rate limited/)
})

test("a reply keeps the name the log was written with, even where the roster says another", () => {
  const rows = foldRoom([reply(1, "m1", "still me", "Hermes (renamed)")], members)
  assert.equal(rows[0].name, "Hermes (renamed)", "the log's own label outlives a roster change")
})

test("a reply the log names no label for takes the roster's name", () => {
  assert.equal(foldRoom([reply(1, "m3", "hello")], members)[0].name, "writer")
  assert.equal(memberName(members, "gone"), undefined)
})

test("rows are drawn in the host's order, and the same page read twice draws one row", () => {
  const page = [reply(3, "m2", "third"), user(1, "first"), reply(2, "m1", "second")]
  const rows = foldRoom([...page, ...page], members)
  assert.deepEqual(rows.map((row) => row.seq), [1, 2, 3])
})

test("a message with no words draws no bubble", () => {
  assert.deepEqual(foldRoom([user(1, "   "), reply(2, "m1", "")], members), [])
})

test("the newest sequence is the read mark a device's next read starts from", () => {
  assert.equal(newestSeq([{ seq: 4 }, { seq: 9 }, { seq: 2 }]), 9)
  assert.equal(newestSeq([]), 0)
})

test("who is working is the member the host has answering now, not the one queued behind it", () => {
  const activity = [
    { memberId: "m2", status: "running" },
    { memberId: "m1", status: "queued" },
  ]
  assert.deepEqual(workingMembers(members, activity).map((one) => one.displayName), ["Coder"])
  assert.deepEqual(queuedMembers(members, activity).map((one) => one.displayName), ["Hermes"])
  assert.equal(workingLine(workingMembers(members, activity), queuedMembers(members, activity)), "Coder is working…")
})

test("a member the roster does not seat is drawn by nothing, and a room at rest says nothing", () => {
  const activity = [{ memberId: "outsider", status: "running" }]
  assert.deepEqual(workingMembers(members, activity), [])
  assert.equal(workingLine([], []), undefined)
  assert.equal(workingLine(workingMembers(members, [])), undefined)
})

test("two members at work are named as two", () => {
  const activity = [
    { memberId: "m1", status: "running" },
    { memberId: "m2", status: "stopping" },
  ]
  assert.equal(workingLine(workingMembers(members, activity)), "Hermes and Coder are working…")
})

test("a room whose members are all queued says who is next instead", () => {
  const activity = [{ memberId: "m1", status: "queued" }]
  assert.equal(workingLine(workingMembers(members, activity), queuedMembers(members, activity)), "Hermes is next…")
})

test("a round bounded at its message cap says which cap ended it", () => {
  const rows = foldRoom(
    [{ seq: 1, eventId: "e1", kind: "room.activity", status: "bounded", reason: "max_messages" }],
    members,
  )
  assert.equal(rows[0].text, "The room stopped at its message limit.")
})

test("a member whose turn was deferred draws the line that says it couldn't answer", () => {
  const rows = foldRoom(
    [
      { seq: 1, eventId: "e1", kind: "message.user", text: "anyone?" },
      { seq: 2, eventId: "e2", kind: "turn.deferred", memberId: "m2", reason: "member_unavailable" },
    ],
    members,
  )
  assert.deepEqual(rows.map((row) => [row.kind, row.text]), [
    ["user", "anyone?"],
    ["notice", "A member couldn't answer."],
  ], "silence would read as a pass, which is not what happened")
})

test("a bound with a reason the app doesn't know still says the room stopped", () => {
  const rows = foldRoom(
    [{ seq: 1, eventId: "e1", kind: "room.activity", status: "bounded", reason: "log_full" }],
    members,
  )
  assert.equal(rows[0].text, "The room stopped.")
})

test("a room whose host reports work without naming a member still says it is answering", () => {
  assert.equal(workingLine([], [], true), "The room is answering…")
  assert.equal(workingLine([], [], false), undefined)
})

test("a member is named by its label: the seat's name, its handle, its profile, then its id", () => {
  assert.equal(memberLabel({ memberId: "m1", profile: "p", handle: "h", displayName: "D" }), "D")
  assert.equal(memberLabel({ memberId: "m1", profile: "p", handle: "h" }), "h")
  assert.equal(memberLabel({ memberId: "m1", profile: "p" }), "p")
  assert.equal(memberLabel({ memberId: "m1" }), "m1")
})

test("a reply addressed to @user says the room needs the user", () => {
  const asking = askingMember(
    [user(1, "who is free?"), reply(2, "m1", "I can, but @user has to pick the release.", "Hermes")],
    members,
  )
  assert.deepEqual(asking, { memberId: "m1", name: "Hermes" })
})

test("the user answering ends it, and a later reply says the round moved on", () => {
  assert.equal(
    askingMember([reply(1, "m1", "which one, @user?", "Hermes"), user(2, "the second")], members),
    undefined,
    "the user has answered, so the room asks nothing",
  )
  assert.equal(
    askingMember(
      [
        reply(1, "m1", "which one, @user?", "Hermes"),
        reply(2, "m2", "I'll take the first then.", "Coder"),
      ],
      members,
    ),
    undefined,
    "the last thing said is a member's reply, and it asks nothing",
  )
})

test("a handle that only begins with @user is somebody's name, not the user", () => {
  assert.equal(askingMember([reply(1, "m1", "@usernames are fine here", "Hermes")], members), undefined)
})

test("a user's own words never ask for the user", () => {
  assert.equal(askingMember([user(1, "tell @user about it")], members), undefined)
})

test("a reply addressed to @user names the member even where the roster no longer seats it", () => {
  assert.deepEqual(askingMember([reply(1, "m9", "over to @user", "Gone")], members), {
    memberId: "m9",
    name: "Gone",
  })
})

const chart = { attachmentId: "at1", kind: "image", name: "chart.png", size: 2048, mime: "image/png" }
const brief = { attachmentId: "at2", kind: "pdf", name: "brief.pdf", size: 4096, mime: "application/pdf" }

test("a user's message and a member's reply keep the files they carry", () => {
  const rows = foldRoom(
    [
      { seq: 1, eventId: "e1", kind: "message.user", text: "here it is", attachments: [chart, brief] },
      reply(2, "m1", "read it", "Hermes"),
      { seq: 3, eventId: "e3", kind: "message.member", text: "and mine", memberId: "m2", name: "Coder", attachments: [brief] },
    ],
    members,
  )
  assert.deepEqual(rows[0].attachments, [chart, brief], "the user's own files are drawn with their words")
  assert.equal(rows[1].attachments, undefined, "a reply with no file carries no key")
  assert.deepEqual(rows[2].attachments, [brief], "a member's reply carries its file too")
})

test("a message of files and no words is drawn", () => {
  const rows = foldRoom(
    [
      { seq: 1, eventId: "e1", kind: "message.user", text: "  ", attachments: [chart] },
      { seq: 2, eventId: "e2", kind: "message.member", text: "", memberId: "m1", name: "Hermes", attachments: [brief] },
    ],
    members,
  )
  assert.deepEqual(
    rows.map((row) => [row.kind, row.attachments?.length]),
    [
      ["user", 1],
      ["member", 1],
    ],
    "a room's file rides a message with no words at all",
  )
})

test("a row with neither words nor files draws nothing", () => {
  assert.deepEqual(
    foldRoom([
      { seq: 1, eventId: "e1", kind: "message.user", text: "   " },
      { seq: 2, eventId: "e2", kind: "message.member", text: "", memberId: "m1", attachments: [] },
    ], members),
    [],
  )
})

test("every folded row carries its event's id, which its files' addresses are signed over", () => {
  const rows = foldRoom(
    [
      user(1, "here it is"),
      reply(2, "m1", "read it", "Hermes"),
      { seq: 3, eventId: "e3", kind: "turn.failed", memberId: "m2", error: "rate limited" },
    ],
    members,
  )
  assert.deepEqual(
    rows.map((row) => [row.seq, row.eventId]),
    [
      [1, "e1"],
      [2, "e2"],
      [3, "e3"],
    ],
    "a message, a reply and a notice each know the Host event they came from",
  )
})
