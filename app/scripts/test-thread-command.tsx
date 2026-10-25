import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"

import { ChatPage } from "@/routes/chat"
import { db, mainThreadId, type Conversation } from "@/lib/db"
import {
  botProfile,
  composerField,
  findAll,
  json,
  mount,
  offersCommand,
  pressEnter,
  seedSettings,
  settle,
  slashOptions,
  type,
  until,
} from "./component-kit.tsx"

const bot = botProfile("bot-thread", { id: "bot-1", name: "Threader" })
const MAIN = mainThreadId(bot.id)
const THREAD = "t1"
const PICK = { provider: "picked", model: "picked/model" }

async function seed(patch: { developer?: boolean; botThreads?: boolean } = {}) {
  await seedSettings({
    developer: true,
    botThreads: true,
    activeProfileId: bot.id,
    ...patch,
  })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.drafts.clear()
  await db.conversations.bulkPut([
    {
      id: MAIN,
      profileId: bot.id,
      title: "Main",
      hermesSessionId: `memento-${MAIN}`,
      createdAt: 1,
      updatedAt: 1,
      changedAt: 0,
      main: true,
      modelChoice: PICK,
    },
    {
      id: THREAD,
      profileId: bot.id,
      title: "Trip to Lisbon",
      hermesSessionId: "t1-hermes",
      createdAt: 1,
      updatedAt: 5,
      changedAt: 1,
    },
  ])
}

function host(name: string) {
  const seen: { path: string; body: any }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    seen.push({ path: url.pathname, body })
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/memento/info"))
      return json({ features: ["attachments", "queue", "triage", "moves"] })
    if (url.pathname.endsWith("/skills")) return json({ object: "list", data: [] })
    if (url.pathname.endsWith("/triage"))
      return json({ decision: "new", thread: "made-by-triage", item: { id: "q_1" } })
    if (url.pathname.endsWith("/attachments") && init?.method === "POST")
      return json({
        name: url.searchParams.get("name"),
        path: `/host/${url.searchParams.get("name")}`,
        size: 3,
      })
    if (url.pathname.endsWith("/v1/runs") && init?.method === "POST")
      return json({ error: { message: "stopped here" } }, 500)
    if (url.pathname.endsWith("/moves")) return json({ moves: [] })
    return json({})
  }) as typeof fetch
  return seen
}

const Where = () => <p data-path>{useLocation().pathname}</p>
const where = () => document.querySelector("[data-path]")?.textContent ?? ""

const screen = (id: string) => (
  <MemoryRouter initialEntries={[`/c/${id}`]}>
    <Routes>
      <Route index element={<Where />} />
      <Route
        path="c/:id"
        element={
          <>
            <ChatPage slot="route" />
            <Where />
          </>
        }
      />
    </Routes>
  </MemoryRouter>
)

const chats = () => db.conversations.toArray()
const messagesOf = (id: string) => db.messages.where("conversationId").equals(id).toArray()
const triaged = (seen: { path: string }[]) => seen.filter((r) => r.path.endsWith("/triage"))
const runs = (seen: { path: string; body: any }[]) =>
  seen.filter((r) => r.path.endsWith("/v1/runs"))

async function started(): Promise<Conversation[]> {
  const all = await chats()
  return all.filter((chat) => chat.id !== MAIN && chat.id !== THREAD)
}

test("Main's menu offers /thread and never /new", async () => {
  await seed()
  host("bot-thread")
  await mount(screen(MAIN), async () => {
    await until(async () => Boolean(composerField()), "Main's composer")
    await type(composerField(), "/")
    await until(async () => slashOptions().length > 0, "the command menu")
    assert.ok(offersCommand("/thread"), "the command is on offer")
    assert.ok(!offersCommand("/new"), "and it is the only name the command wears")
    await type(composerField(), "")
  })
})

test("/thread alone starts an empty thread and opens it", async () => {
  await seed()
  const seen = host("bot-thread")
  await mount(screen(MAIN), async () => {
    await until(async () => Boolean(composerField()), "Main's composer")
    await type(composerField(), "/thread")
    await until(async () => offersCommand("/thread"), "the command in the menu")
    await pressEnter()
    await until(async () => where() !== `/c/${MAIN}`, "the thread to open")
    const [thread] = await started()
    assert.equal(where(), `/c/${thread.id}`, "the new thread is what's on screen")
    assert.deepEqual(await messagesOf(thread.id), [], "an empty thread, as the command alone says")
    assert.deepEqual(triaged(seen), [], "the host was never asked where it goes")
    assert.deepEqual(runs(seen), [], "and nothing was sent from it")
    assert.equal(composerField()?.value, "", "the command left the field")
  })
})

test("/thread with text starts the thread with that message, on the composer's model", async () => {
  await seed()
  const seen = host("bot-thread")
  await mount(screen(MAIN), async () => {
    await until(async () => Boolean(composerField()), "Main's composer")
    await type(composerField(), "/thread plan my move")
    await pressEnter()
    await until(async () => where() !== `/c/${MAIN}`, "the thread to open")
    const [thread] = await started()
    assert.equal(where(), `/c/${thread.id}`, "the new thread is what's on screen")
    assert.deepEqual(thread.modelChoice, PICK, "the model picked in the composer it was typed in")
    await until(async () => runs(seen).length > 0, "the thread's turn to run")
    assert.equal(runs(seen)[0].body.model, PICK.model)
    assert.equal(runs(seen)[0].body.session_id, thread.hermesSessionId)
    assert.match(JSON.stringify(runs(seen)[0].body.input), /plan my move/)
    assert.deepEqual(triaged(seen), [], "the host was never asked where it goes")
    assert.deepEqual(await messagesOf(MAIN), [])
  })
})

test("/thread with a file carries the attachment with the message", async () => {
  await seed()
  const seen = host("bot-thread")
  await mount(screen(MAIN), async () => {
    await until(async () => Boolean(composerField()), "Main's composer")
    const files = findAll('input[type="file"]').find((one) => !one.getAttribute("accept"))
    assert.ok(files, "the composer's file input")
    await act(async () => {
      Object.defineProperty(files, "files", {
        configurable: true,
        value: [new File(["pdf"], "brief.pdf", { type: "application/pdf" })],
      })
      files.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await settle()
    await type(composerField(), "/thread read this")
    await pressEnter()
    await until(async () => where() !== `/c/${MAIN}`, "the thread to open")
    const [thread] = await started()
    const first = async () =>
      (await messagesOf(thread.id)).find((message) => message.role === "user")
    await until(
      async () => Boolean((await first())?.attachments?.[0]?.path),
      "the file to be saved",
    )
    assert.equal((await first())?.content, "read this")
    assert.deepEqual(
      (await first())?.attachments?.map((attachment) => [attachment.name, attachment.path]),
      [["brief.pdf", "/host/brief.pdf"]],
      "the file went with the message",
    )
    assert.match(JSON.stringify(runs(seen)[0]?.body?.input), /brief\.pdf/)
    assert.deepEqual(triaged(seen), [], "the host was never asked where it goes")
  })
})

test("inside an open thread /thread is not offered", async () => {
  await seed()
  host("bot-thread")
  await mount(screen(THREAD), async () => {
    await until(async () => Boolean(composerField()), "the thread's composer")
    await type(composerField(), "/")
    await until(async () => slashOptions().length > 0, "the command menu")
    assert.ok(!offersCommand("/thread"), "a thread can't start one")
    assert.ok(offersCommand("/new"), "and `/new` is still the command there")
  })
})

test("with the switch off the command is /new, as it was, and /thread is absent", async () => {
  await seed({ botThreads: false })
  host("bot-thread")
  await mount(screen(MAIN), async () => {
    await until(async () => Boolean(composerField()), "Main's composer")
    await type(composerField(), "/")
    await until(async () => slashOptions().length > 0, "the command menu")
    assert.ok(offersCommand("/new"), "the name threads off wear")
    assert.ok(!offersCommand("/thread"), "and never the other")
    await type(composerField(), "/new")
    await pressEnter()
    await until(async () => where() === "/", "the new chat's screen")
    assert.equal((await started()).length, 0, "a new chat, not a thread")
  })
})

test("with the switch off a message typed with /thread goes to the bot as text", async () => {
  await seed({ botThreads: false })
  const seen = host("bot-thread")
  await mount(screen(MAIN), async () => {
    await until(async () => Boolean(composerField()), "Main's composer")
    await type(composerField(), "/thread plan my move")
    await pressEnter()
    await until(async () => triaged(seen).length > 0, "the host to be asked")
    assert.equal(
      triaged(seen)[0].body.text,
      "/thread plan my move",
      "no command runs where threads are off",
    )
  })
})
