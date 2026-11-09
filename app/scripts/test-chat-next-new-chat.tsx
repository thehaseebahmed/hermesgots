/**
 * A chat with no record yet (ADR 0065): the address has no id and the active bot can be called, so
 * chat-next draws its blank surface — the bot's face, an empty thread and the app's own composer.
 * Nothing is written on mount, and the first send makes the chat and hands the message to the
 * thread, which sends it as its first turn.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router"

import { SETUP_COPY } from "@/components/chat/empty-states"
import { db, mainThreadId } from "@/lib/db"
import { draftKey, flushDrafts } from "@/lib/drafts"
import { ChatPage } from "@/routes/chat"

import { fakeHost } from "./chat-next-host.ts"
import {
  botProfile,
  click,
  composerField,
  find,
  findAll,
  json,
  missing,
  mount,
  seedChats,
  settle,
  type,
} from "./component-kit.tsx"

const bot = botProfile("hermes")

/** Waits on the screen as a person would: the real screen polls at its real pace, so up to 6s. */
async function until(check: () => boolean | Promise<boolean>, what: string) {
  const by = Date.now() + 6_000
  while (!(await check()) && Date.now() < by) {
    await settle()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
  }
  assert.ok(await check(), what)
}

/** A Hermes that answers for any session, made the first time a request names one: the chat a blank
 *  surface's send makes takes the session id the app mints, so no test can seed it ahead of time. */
function anySession(options: Parameters<typeof fakeHost>[1] = {}) {
  const hosts = new Map<string, ReturnType<typeof fakeHost>>()
  let last: ReturnType<typeof fakeHost> | undefined
  const hostFor = (session: string) => {
    let found = hosts.get(session)
    if (!found) hosts.set(session, (found = fakeHost(session, options)))
    last = found
    return found
  }
  const named = (pathname: string) => /\/sessions\/([^/]+)\/?/.exec(pathname)?.[1] ?? undefined
  const dispatch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const pathname = decodeURIComponent(url.pathname)
    // A run names the session it starts in its body, and its own routes name the run alone.
    const started =
      pathname === "/v1/runs" && init?.method === "POST"
        ? (JSON.parse(String(init.body ?? "{}")).session_id as string | undefined)
        : undefined
    const host = hostFor(named(pathname) ?? started ?? "")
    // A host installs itself as the process's fetch when it is made, so the dispatcher goes back.
    globalThis.fetch = dispatch as typeof fetch
    return host.handle(input, init)
  }
  globalThis.fetch = dispatch as typeof fetch
  return { hostFor }
}

/** The thread's own requests, as the app's rows draw them. */
const requests = () =>
  findAll('[data-chat-next] [data-message-id$="-u"] [data-slot="bubble-content"]').map(
    (one) => one.textContent ?? "",
  )

/** Where the screen is, and how it got there: a chat's first send replaces the new chat's address. */
const Nav = () => {
  const { pathname, state } = useLocation()
  const quiet = Boolean((state as { quiet?: boolean } | null)?.quiet)
  return <p data-nav>{`${useNavigationType()}:${pathname}:${quiet}`}</p>
}
const nav = () => find("[data-nav]")?.textContent ?? ""

/** A new chat is drawn here: no id in the address, and the bot's own blank pane. */
const blankScreen = (
  <MemoryRouter initialEntries={["/"]}>
    <Nav />
    <Routes>
      <Route path="/" element={<ChatPage slot="route" />} />
      <Route path="/c/:id" element={<ChatPage slot="route" />} />
    </Routes>
  </MemoryRouter>
)

test("a new chat opens on chat-next's blank surface and writes no record", async () => {
  await seedChats([], { bots: [bot], legacyChat: true })
  anySession()
  await mount(blankScreen, async () => {
    await until(() => Boolean(find("[data-blank]")), "chat-next's blank surface")
    assert.ok(find('[data-blank] [role="img"]'), "the bot's face")
    assert.ok(composerField(), "the app's own composer")
    assert.ok(find('button[aria-label^="Bot:"]'), "the picker, in the legacy layout")
    assert.equal(findAll('[data-slot="message"]').length, 0, "an empty thread")
    assert.equal(await db.conversations.count(), 0, "no record is written on mount")
    assert.ok(nav().startsWith("POP:/"), "and the address stays the new chat's")
  })
})

test("a draft typed on the blank surface is the app's own, so it outlives the surface", async () => {
  await seedChats([], { bots: [bot], legacyChat: true })
  anySession()
  await mount(blankScreen, async () => {
    await until(() => Boolean(composerField()), "the composer")
    await type(composerField(), "half a thought")
    await flushDrafts()
    assert.equal(
      (await db.drafts.get(draftKey(undefined, bot.id)))?.text,
      "half a thought",
      "the bot's new-chat draft, which is what survives the address changing",
    )
  })
  // The surface is a screen the reader can leave and come back to: the words are still there.
  await mount(blankScreen, async () => {
    await until(() => composerField()?.value === "half a thought", "the draft it kept")
  })
})

test("the blank surface's first send makes the chat and the thread sends it as its first turn", async () => {
  await seedChats([], { bots: [bot], legacyChat: true })
  const host = anySession()
  await mount(blankScreen, async () => {
    await until(() => Boolean(find("[data-blank]")), "the blank surface")
    assert.equal(await db.conversations.count(), 0, "nothing is written before the send")
    await type(composerField(), "Why is the sky blue?")
    await click(find('button[aria-label="Send"]'))
    await until(async () => (await db.conversations.count()) === 1, "the chat the send made")
    const [chat] = await db.conversations.toArray()
    await until(
      () => nav() === `REPLACE:/c/${chat.id}:true`,
      "the address replaced by the chat's own, quietly",
    )
    const session = host.hostFor(chat.hermesSessionId)
    await until(() => session.asked.runs === 1, "the thread sent the message as a turn")
    assert.deepEqual(
      session.latest.body?.input,
      [{ role: "user", content: "Why is the sky blue?" }],
      "the message the reader typed",
    )
    assert.equal(session.latest.body?.session_id, chat.hermesSessionId, "on the chat's own session")
    await until(() => requests().length > 0, "the thread's first turn drawn")
    assert.deepEqual(requests(), ["Why is the sky blue?"], "as the thread's first turn")
    // The send retired the draft the surface held, so nothing of the new chat's field is left over.
    await act(async () => void (await flushDrafts()))
    assert.equal(
      (await db.drafts.get(draftKey(undefined, bot.id)))?.text ?? "",
      "",
      "the draft the send retired",
    )
    assert.equal(composerField()?.value, "", "and the thread's composer starts empty")
  })
})

test("with chat threads off, a blank chat's first send lands in the bot's Main", async () => {
  await seedChats([], { bots: [bot] })
  const host = anySession()
  await mount(blankScreen, async () => {
    await until(() => Boolean(find("[data-blank]")), "the blank surface")
    assert.equal(await db.conversations.count(), 0, "nothing is written before the send")
    await type(composerField(), "Where do I start?")
    await click(find('button[aria-label="Send"]'))
    const main = mainThreadId(bot.id)
    await until(() => nav() === `REPLACE:/c/${main}:true`, "the address replaced by the bot's Main")
    const chats = await db.conversations.toArray()
    assert.equal(chats.length, 1, "Main alone, with no thread made beside it")
    assert.equal(chats[0].id, main, "the bot's Main")
    assert.equal(chats[0].main, true, "marked as the bot's Main")
    const session = host.hostFor(`gots-${main}`)
    await until(() => session.asked.runs === 1, "Main sent the message as a turn")
    assert.deepEqual(
      session.latest.body?.input,
      [{ role: "user", content: "Where do I start?" }],
      "the message the reader typed",
    )
    assert.equal(session.latest.body?.session_id, `gots-${main}`, "on Main's own session")
    await until(() => requests().length > 0, "Main's turn drawn")
    assert.deepEqual(requests(), ["Where do I start?"], "as Main's first message")
  })
})

test("with chat threads on, a blank chat's first send still makes a thread", async () => {
  await seedChats([], { bots: [bot], settings: { chatThreads: true } })
  const host = anySession()
  await mount(blankScreen, async () => {
    await until(() => Boolean(find("[data-blank]")), "the blank surface")
    await type(composerField(), "Plan the trip")
    await click(find('button[aria-label="Send"]'))
    await until(async () => (await db.conversations.count()) === 1, "the thread the send made")
    const [thread] = await db.conversations.toArray()
    assert.notEqual(thread.id, mainThreadId(bot.id), "a thread of its own, not Main")
    assert.ok(!thread.main, "and no Main mark on it")
    await until(
      () => nav() === `REPLACE:/c/${thread.id}:true`,
      "the address replaced by the thread's",
    )
    const session = host.hostFor(thread.hermesSessionId)
    await until(() => session.asked.runs === 1, "the thread sent the message as a turn")
    assert.equal(
      session.latest.body?.session_id,
      thread.hermesSessionId,
      "on the thread's own session",
    )
  })
})

test("a keyless bot keeps the current screen and writes nothing", async () => {
  await seedChats([], { bots: [{ ...bot, baseUrl: "", apiKey: undefined }], legacyChat: true })
  globalThis.fetch = async () => json({})
  await mount(blankScreen, async () => {
    await until(
      () => (document.body.textContent ?? "").includes(SETUP_COPY),
      "the current screen's setup copy",
    )
    assert.ok(missing("[data-blank]"), "and no blank surface")
    assert.ok(missing("[data-chat-next]"), "nothing of chat-next is drawn")
    assert.ok(find('button[aria-label^="Bot:"]'), "the picker it keeps")
    assert.equal(await db.conversations.count(), 0, "no record for a bot that cannot be called")
  })
})

test("a bot with an address and no key keeps setup, not a dead composer", async () => {
  await seedChats([], {
    bots: [{ ...bot, baseUrl: "http://keyless.test/v1", apiKey: undefined }],
    legacyChat: true,
  })
  globalThis.fetch = async () => json({})
  await mount(blankScreen, async () => {
    await until(
      () => (document.body.textContent ?? "").includes(SETUP_COPY),
      "the setup copy for a bot with no key",
    )
    assert.ok(missing("[data-blank]"), "no blank surface")
    const send = find('button[aria-label="Send"]') as HTMLButtonElement | null
    assert.ok(send, "the composer is drawn")
    assert.equal(send.disabled, true, "and it cannot send without a key")
  })
})

test("a model picked on the blank surface is the one the chat is made with", async () => {
  const sonnet = { provider: "anthropic", model: "claude-sonnet-4.5" }
  // An address of its own: the model read is remembered per connection.
  const modelBot = { ...botProfile("model-pick"), modelChoice: sonnet }
  await seedChats([], { bots: [modelBot], legacyChat: true })
  anySession()
  const appFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/api/model/options"))
      return json({
        provider: "anthropic",
        model: "claude-sonnet-4.5",
        providers: [
          {
            slug: "anthropic",
            name: "Anthropic",
            is_current: true,
            authenticated: true,
            models: ["claude-sonnet-4.5", "claude-opus-5"],
          },
        ],
      })
    return appFetch(input, init)
  }) as typeof fetch
  await mount(blankScreen, async () => {
    await until(() => Boolean(find('button[aria-label^="Model:"]')), "the model pill")
    await click(find('button[aria-label^="Model:"]'))
    const picked = findAll("button").find((one) =>
      (one.textContent ?? "").includes("claude-opus-5"),
    )
    assert.ok(picked, "the model list with the other model on it")
    await click(picked)
    await type(composerField(), "Pick this one")
    await click(find('button[aria-label="Send"]'))
    await until(async () => (await db.conversations.count()) === 1, "the chat the send made")
    const [chat] = await db.conversations.toArray()
    assert.deepEqual(
      chat.modelChoice,
      { provider: "anthropic", model: "claude-opus-5" },
      "the pick rides into the record the first send makes",
    )
  })
})
