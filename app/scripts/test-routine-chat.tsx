/**
 * A routine's row opens its run, read-only (G4): the chat screen's picker sends a row carrying the
 * plugin's routine marker to a screen of its own before either chat screen claims it — the run's
 * transcript, under the header naming the routine, with the composer's place saying why nothing can
 * be sent there and the way back to the bot's list. A run the host no longer holds, and one that
 * couldn't be read at all, each say so rather than spinning; and a chat that isn't a routine's is
 * still drawn by the chat screen, with its composer.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"

import { ChatPage } from "@/routes/chat"
import { db, type Conversation, type Message, type Profile } from "@/lib/db"
import { RUN_GONE, RUN_UNREAD } from "@/lib/routine-transcript"
import type { SessionMessage } from "@/lib/hermes"
import {
  Path,
  absent,
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  path,
  seedSettings,
  until,
  wordsOf,
} from "./component-kit.tsx"

/** A routine's row, its job and the run whose session it opens: derived as the plugin derives it. */
let run = "cron_job_1_1767225600"
const rowOf = () => `routine-job-1-${run}`
const TITLE = "Morning watch"
const PROMPT = "Morning watch: check the feeds."
const ANSWER = "Checked the feeds: three things worth reading."
/** The delivery's stamp, and the row's own clock. */
const AT = 1_767_225_600_000

const bot = botProfile("routine-chat", { name: "Mainly" })

/** The run's transcript, as the host serves a session's rows. */
const RUN_ROWS: SessionMessage[] = [
  { id: 900, role: "user", content: PROMPT, timestamp: AT / 1000 - 2 },
  { id: 901, role: "assistant", content: ANSWER, timestamp: AT / 1000 - 1 },
]

type Call = { method: string; path: string }

/**
 * The bot's host: the run's transcript, and — for a run an emptied host answers with its 404 — a
 * session it no longer holds. Every request is recorded, so a case can ask what was read, and in
 * particular that the plugin's old `sessions/{id}/routines` route is asked nothing.
 */
function host({
  rows = RUN_ROWS,
  status = 200,
  asked = [],
}: {
  /** The run's rows, or null for the host that no longer holds the session. */
  rows?: SessionMessage[] | null
  status?: number
  asked?: Call[]
} = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    asked.push({ method, path: url.pathname })
    if (url.pathname.endsWith("/plugins/gots/info")) return json({ name: "gots", features: [] })
    if (url.pathname.endsWith(`/api/sessions/${run}/messages`))
      return rows
        ? json({ data: rows })
        : json({ error: { message: "No such session." } }, status === 200 ? 404 : status)
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: [] })
    return json({ error: { message: `No route for ${method} ${url.pathname}` } }, 404)
  }) as unknown as typeof fetch
  return asked
}

/** A row of a bot's list, drawn the way a delivery publishes one — `routine: undefined` for a chat. */
async function seed({
  patch = {},
  messages = [],
  profile = bot,
}: {
  patch?: Partial<Conversation>
  messages?: Message[]
  profile?: Profile
} = {}) {
  await seedSettings({ developer: true, activeProfileId: profile.id })
  await db.profiles.clear()
  await db.profiles.put(profile)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put({
    id: rowOf(),
    profileId: profile.id,
    title: TITLE,
    titleEdited: true,
    hermesSessionId: run,
    createdAt: AT,
    updatedAt: AT,
    changedAt: AT,
    routine: true,
    line: ANSWER,
    ...patch,
  })
  await db.messages.bulkPut(messages.map((message) => ({ ...message, conversationId: rowOf() })))
}

/** Whether the entry on screen is one a screen marked as a step back onto a list. */
const Listed = () => {
  const state = useLocation().state as { listed?: boolean } | null
  return <p data-listed>{String(Boolean(state?.listed))}</p>
}

const screen = (entry = `/c/${rowOf()}`) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Listed />
    <Routes>
      <Route path="c/:id" element={<ChatPage slot="route" />} />
      <Route path="b/:profileId" element={<p data-list />} />
    </Routes>
  </MemoryRouter>
)

/**
 * A case of its own: a run the reader has not opened before. A run that is over is read once for the
 * page's life, so two cases sharing a session would read the first one's answer.
 */
const ownRun = (name: string) => {
  run = `cron_${name}_1767225600`
}

const rows = () => findAll("[data-slot=message]")
const drew = (words: string) => rows().some((row) => row.textContent?.includes(words))
const askedFor = (asked: Call[], part: string) =>
  asked.filter((one) => one.path.includes(part)).length

test("a routine's row opens its run read-only, under the header naming it", async () => {
  ownRun("read")
  const asked = host()
  await seed()
  await mount(screen(), async () => {
    await until(async () => drew(ANSWER), "the run's own transcript")
    assert.ok(drew(PROMPT), "the run's prompt draws too: the transcript is the session's own")
    assert.equal(
      wordsOf(find("[data-slot=header-title]")),
      TITLE,
      "the header names the routine that ran",
    )
    assert.equal(
      findAll('a[aria-label^="Chats with"]').length,
      0,
      "and the run's bar carries no list of its own: a run is not one of a bot's chats",
    )
    assert.equal(findAll("textarea").length, 0, "and nothing here can be sent")
    const note = wordsOf(find("[data-slot=routine-note]"))
    assert.match(note, /read-only/i, "the composer's place says what this screen is")
    assert.match(
      note,
      /won't take a reply/i,
      "and why: Hermes refuses a turn in a routine's run, though it allows reading it",
    )
    assert.equal(askedFor(asked, `/api/sessions/${run}/messages`), 1, "the run was read once")
    assert.equal(
      askedFor(asked, "/sessions/") - askedFor(asked, "/messages"),
      0,
      "and the plugin's old routine-message route is asked nothing: it is gone",
    )
  })
})

test("the way back is the bot's list, not the chat the run was opened from", async () => {
  ownRun("back")
  host()
  await seed()
  await mount(screen(), async () => {
    await until(async () => drew(ANSWER), "the run's own transcript")
    assert.ok(find("[data-slot=routine-note]"), "the run's own screen is what is on")
    const back = find(`[aria-label="Back to ${bot.name}"]`)
    assert.ok(back, "a control leads back")
    await click(back)
    await until(async () => path() === `/b/${bot.id}`, "the bot's list")
    absent("[data-slot=routine-note]", "and the run's screen is what was left")
    assert.equal(
      find("[data-listed]")?.textContent,
      "true",
      "and the entry it leaves says the reader stepped back onto the list",
    )
  })
})

test("a run the host no longer holds says so, rather than spinning", async () => {
  ownRun("gone")
  host({ rows: null })
  await seed()
  await mount(screen(), async () => {
    await until(async () => Boolean(find("[data-slot=routine-run-note]")), "the note")
    assert.equal(wordsOf(find("[data-slot=routine-run-note]")), RUN_GONE)
    assert.equal(findAll("textarea").length, 0, "and the screen still takes nothing")
  })
})

test("a run that couldn't be read at all is told apart from one that is gone", async () => {
  ownRun("unread")
  host({ rows: null, status: 500 })
  await seed()
  await mount(screen(), async () => {
    await until(async () => Boolean(find("[data-slot=routine-run-note]")), "the note")
    assert.equal(wordsOf(find("[data-slot=routine-run-note]")), RUN_UNREAD)
  })
})

test("a chat that isn't a routine's is still the chat screen's, with its composer", async () => {
  ownRun("plain")
  host()
  await seed({ patch: { routine: undefined, line: undefined } })
  await mount(screen(), async () => {
    await until(async () => Boolean(find("[data-chat-next]")), "the chat screen")
    absent("[data-slot=routine-note]", "a chat's composer's place is a chat's")
    await until(async () => findAll("textarea").length > 0, "the chat's composer")
  })
})
