/**
 * A routine's message in a chat (ADR 0081): it is the bot's own message, so it wears a chip naming
 * the routine that spoke, and the chip opens the run behind it — the run's transcript, read-only,
 * with no composer (Hermes refuses a turn on the `cron` session it wrote). A run the host no longer
 * holds reads as a plain sentence; a host that doesn't advertise `routine_message` is asked nothing
 * and draws nothing; and only a routine's own message asks for a chat's runs, so a thread without one
 * asks nothing at all.
 */
import assert from "node:assert/strict"
import test from "node:test"

import type { Message, Profile } from "@/lib/db"
import type { SessionMessage } from "@/lib/hermes"
import {
  botProfile,
  chatScreen,
  findAll,
  json,
  mount,
  seedChat,
  settle,
  until,
} from "./component-kit.tsx"

const ROW = 1234
const JOB = "abc123"
const RUN = "cron_abc123_1767225600"
const TITLE = "Morning watch"
/** The delivery's stamp, milliseconds since the epoch. */
const AT = 1_767_225_600_000

const SAID = "Morning watch found three things worth reading."
const ORDINARY = "Nothing else came in overnight."
const ASKED = "How did the night go?"
const PROMPT = "Morning watch: check the feeds."
const ANSWER = "Checked the feeds: nothing new."
/** What the route names for a routine's message: the row it is drawn at, and the run behind it. */
const RUN_ROW = {
  row: ROW,
  at: AT,
  job_id: JOB,
  title: TITLE,
  run_session: RUN,
  model: "claude-sonnet-4-5",
  seconds: 12,
}

/** The run's own transcript, as the host serves a session's rows. */
const RUN_ROWS: SessionMessage[] = [
  { id: 900, role: "user", content: PROMPT, timestamp: AT / 1000 - 2 },
  { id: 901, role: "assistant", content: ANSWER, timestamp: AT / 1000 - 1 },
]

/** A chat whose bot spoke twice, the routine's message last: it stands under the reply above it. */
const MESSAGES: Message[] = [
  { id: "ask", conversationId: "", role: "user", content: ASKED, status: "done", createdAt: 1 },
  {
    id: "reply",
    conversationId: "",
    role: "assistant",
    content: ORDINARY,
    status: "done",
    createdAt: 2,
  },
  {
    id: "routine",
    conversationId: "",
    role: "assistant",
    content: SAID,
    status: "done",
    createdAt: 3,
    routine: true,
    hermesRowId: ROW,
  },
]

type Call = { method: string; path: string }

/**
 * The bot's host: what its plugin advertises, the chat's `/routines` answer, and the run's
 * transcript — `run: null` being a session the host no longer holds (its 404). Every request is
 * recorded, so a case can ask whether the chat was read at all.
 */
function host({
  features = ["routine_message"],
  routines = [RUN_ROW],
  run = RUN_ROWS,
  asked = [],
}: {
  features?: string[]
  routines?: unknown[]
  /** The run's rows, or null for the 404 an emptied host answers with. */
  run?: SessionMessage[] | null
  asked?: Call[]
} = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    asked.push({ method, path: url.pathname })
    if (url.pathname.endsWith("/plugins/gots/info")) return json({ name: "gots", features })
    if (/\/plugins\/gots\/sessions\/[^/]+\/routines$/.test(url.pathname))
      return json({ object: "gots.routines", routines })
    if (url.pathname.endsWith(`/api/sessions/${RUN}/messages`))
      return run ? json({ data: run }) : json({ error: { message: "No such session." } }, 404)
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: [] })
    return json({ error: { message: `No route for ${method} ${url.pathname}` } }, 404)
  }) as unknown as typeof fetch
  return asked
}

async function screen(
  {
    chat,
    messages = MESSAGES,
    bot,
    ...rest
  }: {
    chat: string
    /** The chat's own bot: its features are remembered per connection, so each case names its own. */
    bot: Profile
    messages?: Message[]
    features?: string[]
    routines?: unknown[]
    run?: SessionMessage[] | null
  },
  body: (asked: Call[]) => Promise<void>,
) {
  const asked = host(rest)
  await seedChat({ id: chat, messages, profile: bot })
  await mount(chatScreen(chat), () => body(asked))
  return asked
}

const askedFor = (asked: Call[], part: string) =>
  asked.filter((one) => one.path.includes(part)).length

const rows = () => findAll("[data-slot=message]")
const rowWith = (needle: string) => rows().find((row) => row.textContent?.includes(needle))
/** The pressable line: the receipt is what a reader sees, its button is what they press. */
test("a host that doesn't advertise the feature is asked for nothing and draws no chip", async () => {
  await screen(
    { chat: "routine-legacy", bot: botProfile("routine-legacy", { apiKey: undefined }), features: ["attachments"] },
    async (asked) => {
      // What it advertises is read once per connection; only then is there nothing to ask.
      await until(async () => askedFor(asked, "/plugins/gots/info") > 0, "the feature read")
      await settle()
      assert.equal(askedFor(asked, "/routines"), 0, "nothing was asked of the chat")
      assert.equal(findAll("[data-slot=routine-receipt]").length, 0, "and no line is drawn")
      assert.ok(rowWith(SAID), "the bot's message still draws, as any reply does")
    },
  )
})

test("a chat with no routine message is asked nothing, and draws nothing extra", async () => {
  // A thread mounts a message at a time as it scrolls, so a read per reply would be one request per
  // reply of every chat: only a routine's own message is the one that asks.
  await screen(
    {
      chat: "routine-none",
      bot: botProfile("routine-none", { apiKey: undefined }),
      messages: MESSAGES.slice(0, 2),
      routines: [],
    },
    async (asked) => {
      await until(async () => askedFor(asked, "/plugins/gots/info") > 0, "the feature read")
      await settle()
      assert.equal(askedFor(asked, "/routines"), 0, "nothing was asked of the chat")
      assert.equal(findAll("[data-slot=routine-receipt]").length, 0, "and nothing is drawn")
      assert.ok(rowWith(ORDINARY), "while the bot's reply still draws, as any reply does")
    },
  )
})
