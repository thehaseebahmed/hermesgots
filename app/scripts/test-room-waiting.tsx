/**
 * A room that needs the user, at a phone's width and a tablet's (F4).
 *
 * The Host holds an approval and a member asks a question; the room draws each in the composer's
 * place, with the chat's own card — the member's name, the command, the choices — and answers it
 * where it is. A reply addressed to `@user` is read out of the log as the room's needs-you mark, and
 * Stop is the composer's own control, held while a round runs. At rest the room draws the chat's
 * composer: words, Send, and neither a model pill nor a file to attach.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { RoomChat } from "@/components/room/room-chat"
import { db, type Profile } from "@/lib/db"
import {
  atWidth,
  botProfile,
  click,
  find,
  json,
  missing,
  mount,
  seedSettings,
  settle,
  text,
  until,
  wordsOf,
} from "./component-kit.tsx"

const HOST = "http://room-waiting.test/v1"
const ROOM = "room-1"
const BOT = "bot-1"
const AT = Date.now()

const members = [
  { memberId: "m1", profile: "default", handle: "hermes", displayName: "Hermes" },
  { memberId: "m2", profile: "coder", handle: "coder", displayName: "Coder" },
]

const bot: Profile = botProfile("room-waiting", {
  id: BOT,
  name: "Hermes",
  baseUrl: HOST,
  apiKey: "test-key",
  hermesProfile: "default",
})

interface Call {
  method: string
  path: string
  body: Record<string, unknown> | null
}

/** What the Host holds now: the wakes it is waiting on, and the log as this device reads it. */
let waiting: unknown[] = []
/** The connection whose Host never declares `rooms_questions`, so its room draws no question card. */
const NO_QUESTIONS = "http://room-waiting-off.test/v1"
let canStop = true
let answering = false
let log: { seq: number; eventId: string; kind: string; text?: string; memberId?: string; name?: string }[] = []
const calls: Call[] = []

function read() {
  return {
    object: "gots.room",
    room: { id: ROOM, name: "Planning", members },
    events: log,
    cursor: log.at(-1)?.seq ?? 0,
    latestSeq: log.at(-1)?.seq ?? 0,
    hasMore: false,
    working: answering,
    activity: [],
    waiting,
    canStop,
    canSend: true,
  }
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input))
  const method = (init?.method ?? "GET").toUpperCase()
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
  if (url.pathname.endsWith("/plugins/gots/info")) {
    // The feature list is remembered per connection, so a host that withholds a row is its own.
    const features = url.origin.startsWith(new URL(NO_QUESTIONS).origin)
      ? ["rooms"]
      : ["rooms", "rooms_questions"]
    return json({ name: "gots", features })
  }
  if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}`) && method === "GET") return json(read())
  if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}/send`)) {
    calls.push({ method, path: url.pathname, body })
    return json({
      object: "gots.room.event",
      event: { seq: 1, eventId: "e1", kind: "message.user", text: "hello" },
    })
  }
  if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}/approve`)) {
    calls.push({ method, path: url.pathname, body })
    waiting = waiting.filter((one) => (one as { kind: string }).kind !== "approval")
    log = [
      ...log,
      { seq: log.length + 1, eventId: "e9", kind: "message.member", text: "On it.", memberId: "m1", name: "Hermes" },
    ]
    return json({ object: "gots.room.approved", approved: true })
  }
  if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}/answer`)) {
    calls.push({ method, path: url.pathname, body })
    waiting = waiting.filter((one) => (one as { kind: string }).kind !== "question")
    return json({ object: "gots.room.answered", questionId: "srq-1" })
  }
  if (url.pathname.endsWith(`/plugins/gots/rooms/${ROOM}/stop`)) {
    calls.push({ method, path: url.pathname, body })
    answering = false
    log = [
      ...log,
      { seq: log.length + 1, eventId: "e10", kind: "room.stop_requested" },
      { seq: log.length + 2, eventId: "e11", kind: "turn.cancelled", memberId: "m1" },
    ]
    return json({ object: "gots.room.stopped", cancelled: 1 })
  }
  return json({}, 404)
}) as typeof fetch

const APPROVAL = {
  kind: "approval",
  memberId: "m1",
  taskId: "dtask:1",
  generation: 3,
  requestId: "approval-1",
  command: "rm -rf build",
  description: "Clear the build",
}

const QUESTION = {
  kind: "question",
  memberId: "m2",
  questionId: "srq-1",
  questions: [
    { id: "q0", question: "Which database?", choices: ["Postgres", "SQLite"], multiSelect: false },
  ],
}

async function fresh(wake: unknown[] = [], events = log, host = HOST) {
  waiting = wake
  canStop = true
  answering = false
  log = events
  calls.length = 0
  await seedSettings({ onboarded: true })
  await db.profiles.clear()
  await db.profiles.put({ ...bot, ...(host === HOST ? {} : { baseUrl: host, apiKey: "test-key" }) })
  await db.conversations.clear()
  await db.roomLog.clear()
  await db.conversations.put({
    id: ROOM,
    profileId: BOT,
    title: "Planning",
    room: { id: ROOM, members },
    createdAt: AT - 60_000,
    updatedAt: AT,
    changedAt: AT,
  })
  await settle()
}

const screen = () => (
  <MemoryRouter initialEntries={[`/c/${ROOM}`]}>
    <Routes>
      <Route path="/c/:id" element={<RoomChat id={ROOM} slot="route" />} />
    </Routes>
  </MemoryRouter>
)

const composerField = () => find('textarea[aria-label="Message"]')

/** A control by its exact words, among the cards the room drew. */
function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (one) => wordsOf(one) === label,
  ) as HTMLButtonElement | undefined
}

/** A question's choice: the chat's row carries the label and, on the first, a recommended badge. */
function choice(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (one) => wordsOf(one).includes(label),
  ) as HTMLButtonElement | undefined
}

/** The composer's Stop is an icon, so it is named by its label rather than its words. */
const stopButton = () => document.querySelector('button[aria-label="Stop"]') as HTMLButtonElement | null

test("the approval takes the composer's place, with the chat's own card, at a phone's width",
  atWidth(390, async () => {
    await fresh([APPROVAL])
    await mount(screen(), async () => {
      await until(
        async () => Boolean(find('[data-slot="room-card"][data-card="approval"]')),
        "the approval card",
      )
      const card = find('[data-slot="room-card"][data-card="approval"]')!
      assert.match(wordsOf(card), /Approval needed/, "the chat's own approval card")
      assert.match(wordsOf(card), /Hermes/, "and it names the member asking")
      assert.match(wordsOf(card), /Clear the build/, "and says what it is for")
      assert.match(wordsOf(card), /rm -rf build/, "the command is drawn whole")
      assert.ok(button("Allow once") && button("Deny"), "the card's two answers")
      assert.equal(button("Always allow"), undefined, "the Host takes no third answer")
      assert.ok(missing('textarea[aria-label="Message"]'), "the card holds the composer's place")

      await click(button("Allow once")!)
      await until(async () => calls.length > 0, "the answer to reach the Host")
      assert.deepEqual(
        calls[0],
        {
          method: "POST",
          path: `/api/plugins/gots/rooms/${ROOM}/approve`,
          body: {
            member_id: "m1",
            task_id: "dtask:1",
            execution_generation: 3,
            request_id: "approval-1",
            choice: "once",
          },
        },
        "the Host's own coordinates, and the one answer the card offered",
      )
      await until(async () => !find('[data-slot="room-card"]'), "the card to go once answered")
    })
  }))

test("the same card is drawn, and Deny answered, at a tablet's width",
  atWidth(1024, async () => {
    await fresh([APPROVAL])
    await mount(screen(), async () => {
      await until(
        async () => Boolean(find('[data-slot="room-card"][data-card="approval"]')),
        "the approval card",
      )
      // The chat's card: an in-chat card never passes the reading column's 672px (ADR 0047).
      assert.ok(
        find('[data-slot="room-card"]')!.firstElementChild!.className.includes("max-w-[672px]"),
        "the card takes the reading column's box at a tablet's width",
      )
      await click(button("Deny")!)
      await until(async () => calls.length > 0, "the answer to reach the Host")
      assert.equal(
        (calls[0].body as Record<string, unknown>).choice,
        "deny",
        "Deny is the other answer the Host takes",
      )
    })
  }))

test("a question takes the composer's place too, offering the Host's own choices",
  atWidth(390, async () => {
    await fresh([QUESTION])
    await mount(screen(), async () => {
      await until(
        async () => Boolean(find('[data-slot="room-card"][data-card="question"]')),
        "the question card",
      )
      const card = find('[data-slot="room-card"][data-card="question"]')!
      assert.match(wordsOf(card), /Question/, "the chat's own question card")
      assert.match(wordsOf(card), /Coder/, "naming the member who asked")
      assert.match(wordsOf(card), /Which database\?/, "and asking what it asks")
      assert.ok(choice("Postgres") && choice("SQLite"), "each choice is a control of its own")
      assert.ok(missing('textarea[aria-label="Message"]'), "the card holds the composer's place")

      await click(choice("Postgres")!)
      await click(button("Send")!)
      await until(async () => calls.length > 0, "the answer to reach the Host")
      assert.deepEqual(
        calls[0],
        {
          method: "POST",
          path: `/api/plugins/gots/rooms/${ROOM}/answer`,
          body: { member_id: "m2", question_id: "srq-1", answers: { q0: "Postgres" } },
        },
        "the choice goes back as the Host asked it",
      )
    })
  }))

test("a reply addressed to @user draws the room's needs-you mark",
  atWidth(1024, async () => {
    await fresh([], [
      { seq: 1, eventId: "e1", kind: "message.user", text: "who picks?" },
      {
        seq: 2,
        eventId: "e2",
        kind: "message.member",
        text: "That's for @user to decide.",
        memberId: "m2",
        name: "Coder",
      },
    ])
    await mount(screen(), async () => {
      await until(async () => Boolean(find('[data-slot="room-needs-you"]')), "the needs-you mark")
      assert.match(wordsOf(find('[data-slot="room-needs-you"]')!), /Coder needs you/)
      assert.match(text(), /That's for @user to decide\./, "the reply itself is still drawn")
    })
  }))

test("at rest the room draws the chat's composer, without a model pill or a file to attach",
  atWidth(390, async () => {
    await fresh([], [{ seq: 1, eventId: "e1", kind: "message.user", text: "who is free?" }])
    await mount(screen(), async () => {
      await until(composerField, "the room's composer")
      assert.equal(composerField()!.getAttribute("placeholder"), "Message the room…")
      assert.equal(button("Add context"), undefined, "a room's message carries no file")
      assert.ok(missing('[data-slot="room-card"]'), "and nothing holds its place")
      assert.ok(missing('[aria-label^="Model"]'), "and no model pill")
    })
  }))

test("Stop is the composer's, while a round runs, and ends it through the Host's route",
  atWidth(390, async () => {
    await fresh([], [{ seq: 1, eventId: "e1", kind: "message.user", text: "go" }])
    answering = true
    await mount(screen(), async () => {
      await until(async () => Boolean(stopButton()), "the composer's Stop")
      await click(stopButton()!)
      await until(async () => calls.length > 0, "the stop to reach the Host")
      assert.equal(calls[0].path, `/api/plugins/gots/rooms/${ROOM}/stop`)
      assert.match(
        String((calls[0].body as Record<string, unknown>).cancel_id),
        /./,
        "the stop carries an id of this device's own",
      )
      await until(
        async () => Boolean(find('[data-slot="room-row"][data-kind="notice"]')),
        "the transcript to say the round stopped",
      )
      assert.match(text(), /The room was stopped\./, "the room says so in its own words")
    })
  }))

test("a room at rest offers no Stop, since there is no round to end",
  atWidth(1024, async () => {
    await fresh([], [{ seq: 1, eventId: "e1", kind: "message.user", text: "who is free?" }])
    await mount(screen(), async () => {
      await until(async () => Boolean(find('[data-slot="room-row"]')), "the room's own row")
      assert.ok(missing('button[aria-label="Stop"]'), "a Stop at rest could only cancel nothing")
      assert.ok(composerField(), "the composer keeps its place")
    })
  }))

test("a host that never declares rooms_questions draws no question card",
  atWidth(390, async () => {
    await fresh([QUESTION], [], NO_QUESTIONS)
    await mount(screen(), async () => {
      await until(async () => Boolean(composerField()), "the composer to draw")
      assert.ok(missing('[data-slot="room-card"]'), "no card the Host never offered")
    })
  }))
