/**
 * A chat keeps the model it started on. Its first send pins the model in effect then, so changing
 * the bot's Default model afterwards reaches only the threads and sessions that haven't started;
 * Main, the one chat whose job is to follow the default, is never pinned.
 *
 * The HTTP boundary is faked: a host posts each run with the model the turn was sent with, answers
 * every run to the end, and the chat row says what it kept.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { queueMessage, sendMessage } from "@/lib/chat"
import { db, mainThreadId, updateProfile, type Profile } from "@/lib/db"
import { chosenOf, storedPick } from "@/lib/model-pick"
import {
  botProfile,
  chatScreen,
  click,
  composerField,
  find,
  findAll,
  json,
  mount,
  pressEnter,
  seedSettings,
  settle,
  type,
  until,
} from "./component-kit.tsx"

const sonnet = { provider: "anthropic", model: "claude-sonnet-4.5" }
const gpt = { provider: "openai", model: "gpt-5" }
const local = { provider: "llama", model: "local/llama" }

const MAIN = mainThreadId("bot-1")

/** A host's answer to the model read: what it runs, and the providers it offers. */
function modelOptions(model?: { provider: string; model: string }) {
  if (!model) return {}
  // Two providers, so the menu lists them and its Default row with them: one provider drills
  // straight into its models instead.
  return {
    ...model,
    providers: [
      {
        slug: model.provider,
        name: model.provider,
        is_current: true,
        authenticated: true,
        models: [model.model, "another-model"],
      },
      { slug: "other", name: "Other", authenticated: true, models: ["other-model"] },
    ],
  }
}

/** The same answer with the one provider a bot has, whose models the menu lists at once. */
function soloOptions(model: { provider: string; model: string }) {
  return {
    ...model,
    providers: [
      {
        slug: model.provider,
        name: model.provider,
        is_current: true,
        authenticated: true,
        models: [model.model, "another-model"],
      },
    ],
  }
}

/** One host: the model it reports, every run body it was sent, and runs that finish. */
function host(name: string, model?: { provider: string; model: string }, { solo = false } = {}) {
  const seen: { path: string; body: any }[] = []
  let runId = 0
  const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    const method = (init?.method ?? "GET").toUpperCase()
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    seen.push({ path: url.pathname, body })
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/api/model/options"))
      return json(model ? (solo ? soloOptions(model) : modelOptions(model)) : {})
    if (url.pathname.endsWith("/skills")) return json({ object: "list", data: [] })
    if (url.pathname.endsWith("/v1/runs") && method === "POST") {
      runId += 1
      return json({ run_id: `run-${runId}` })
    }
    if (method === "GET" && /^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      const answer = "Right."
      const frames = [
        { event: "message.delta", delta: answer, seq: 1 },
        { event: "run.completed", status: "completed", output: answer, seq: 2 },
      ]
      return new Response(frames.map(frame).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    return json({})
  }) as typeof fetch
  return { runs: () => seen.filter((r) => r.path.endsWith("/v1/runs")) }
}

/**
 * A host behind a captive portal on its model read: the read never comes back on its own, only when
 * the request is given up on. The tick holds the event loop open meanwhile, as a page's own would:
 * Node drops a process whose only timer is the abort one.
 */
function slowModelRead(name: string) {
  const reads: string[] = []
  const answer = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.host.startsWith(name) && url.pathname.endsWith("/api/model/options")) {
      reads.push(url.pathname)
      return new Promise<Response>((_resolve, reject) => {
        const held = setInterval(() => {}, 250)
        init?.signal?.addEventListener("abort", () => {
          clearInterval(held)
          reject(new DOMException("The read timed out.", "TimeoutError"))
        })
      })
    }
    return answer(input, init)
  }) as typeof fetch
  return { reads }
}

/** A host that refuses the first turn and streams the next, so a first send can fail and retry. */
function refusesOnce(name: string) {
  const sent: any[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    if (url.pathname.endsWith("/capabilities")) return json({ features: {} })
    if (url.pathname.endsWith("/api/model/options")) return json({})
    if (url.pathname.endsWith("/skills")) return json({ object: "list", data: [] })
    if (url.pathname.endsWith("/v1/chat/completions") && init?.method === "POST") {
      sent.push(body)
      if (sent.length === 1) return json({ error: { message: "No key to run it." } }, 401)
      const chunk = JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "Right." }, finish_reason: null }],
      })
      const done = JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })
      return new Response(`data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    }
    return json({})
  }) as typeof fetch
  return { sent }
}

/** A host that runs every turn, and counts the model reads it was asked for. */
function countingHost(name: string, model?: { provider: string; model: string }) {
  const reads: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    const method = (init?.method ?? "GET").toUpperCase()
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/api/model/options")) {
      reads.push(url.pathname)
      return json(model ? modelOptions(model) : {})
    }
    if (url.pathname.endsWith("/skills")) return json({ object: "list", data: [] })
    if (url.pathname.endsWith("/v1/runs") && method === "POST")
      return json({ run_id: `run-${reads.length}` })
    if (method === "GET" && /^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      const frames = [
        { event: "message.delta", delta: "Right.", seq: 1 },
        { event: "run.completed", status: "completed", output: "Right.", seq: 2 },
      ]
      return new Response(frames.map((one) => `data: ${JSON.stringify(one)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    return json({})
  }) as typeof fetch
  return { reads }
}

/** A host whose queue the plugin refuses, so the message waits here instead. */
function refusesQueue(name: string) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith(name)) return json({})
    if (url.pathname.endsWith("/capabilities"))
      return json({ features: { run_submission: true, run_events_sse: true } })
    if (url.pathname.endsWith("/plugins/memento/info")) return json({ features: ["queue"] })
    if (url.pathname.endsWith("/api/model/options")) return json({})
    if (url.pathname.endsWith("/skills")) return json({ object: "list", data: [] })
    if (url.pathname.endsWith("/queue")) return json({ error: { message: "No queue here." } }, 500)
    return json({})
  }) as typeof fetch
}

async function seed(name: string, bot: Partial<Profile> = {}): Promise<Profile> {
  const profile = botProfile(name, { id: "bot-1", name: "Pinner", ...bot })
  await seedSettings({ developer: true, botThreads: true, activeProfileId: profile.id })
  await db.profiles.clear()
  await db.profiles.put(profile)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut([
    {
      id: MAIN,
      profileId: profile.id,
      title: "Main",
      hermesSessionId: `memento-${MAIN}`,
      createdAt: 1,
      updatedAt: 1,
      changedAt: 0,
      main: true,
    },
    {
      id: "t1",
      profileId: profile.id,
      title: "Trip to Lisbon",
      hermesSessionId: "t1-hermes",
      createdAt: 1,
      updatedAt: 5,
      changedAt: 1,
    },
  ])
  return profile
}

const choiceOf = async (id: string) => (await db.conversations.get(id))?.modelChoice
const messagesOf = (id: string) => db.messages.where("conversationId").equals(id).toArray()
const pill = () => find('button[aria-label^="Model:"]')

/** The pin the chat holds once the host's answer to a background read has landed. */
async function pinned(id: string) {
  await until(async () => Boolean(chosenOf(await choiceOf(id))), `the pin on ${id}`)
  return chosenOf(await choiceOf(id))
}

/** The threads a bot has besides Main and the seeded one. */
async function started() {
  const all = await db.conversations.toArray()
  return all.filter((chat) => chat.id !== MAIN && chat.id !== "t1")
}

test("a chat keeps the model its first send ran on when the default changes", async () => {
  const bot = await seed("pin-keep", { modelChoice: sonnet })
  const host_ = host("pin-keep")
  await sendMessage("t1", "hello")
  assert.equal(host_.runs().length, 1)
  assert.equal(host_.runs()[0].body.model, sonnet.model)
  assert.deepEqual(await choiceOf("t1"), sonnet, "the first send fixed the chat's model")
  await updateProfile(bot.id, { modelChoice: gpt })
  await sendMessage("t1", "and again")
  assert.equal(host_.runs().length, 2, "the chat's second turn")
  assert.equal(host_.runs()[1].body.model, sonnet.model, "still the chat's own model")
  assert.equal(host_.runs()[1].body.provider, sonnet.provider)
})

test("Main is never pinned: it follows the default as it changes", async () => {
  const bot = await seed("pin-main", { modelChoice: sonnet })
  const host_ = host("pin-main")
  await sendMessage(MAIN, "hello")
  assert.equal(await choiceOf(MAIN), undefined, "Main keeps no model of its own")
  await updateProfile(bot.id, { modelChoice: gpt })
  await sendMessage(MAIN, "and again")
  assert.equal(host_.runs().length, 2, "Main's second turn")
  assert.equal(host_.runs()[1].body.model, gpt.model, "the bot's default, as it now stands")
})

test("a bot with no default pins the model the host reports, after the turn has run", async () => {
  await seed("pin-host")
  const host_ = host("pin-host", local)
  await sendMessage("t1", "hello")
  assert.equal(host_.runs().length, 1, "the turn ran")
  assert.ok(!("model" in host_.runs()[0].body), "nothing on the device named a model to send")
  assert.deepEqual(await pinned("t1"), local, "the model the host reported, once it answered")
  await sendMessage("t1", "and again")
  assert.equal(host_.runs()[1].body.model, local.model, "the chat names it from then on")
})

test("a bot whose default is the host's last report pins the model the pill shows", async () => {
  // A picker reads `botModel`: the bot's own default, else the host's, else the copy a read left
  // here. A pin has to be that same model, or the chat is drawn on one and fixed to another.
  await seed("pin-held", { hostModel: local })
  const host_ = host("pin-held", sonnet)
  await sendMessage("t1", "hello")
  assert.deepEqual(await choiceOf("t1"), local, "the model the pill showed")
  assert.equal(host_.runs()[0].body.model, local.model, "and the turn ran on it")
})

test("a failed first send takes its pin back, so the retry runs the model then", async () => {
  const bot = await seed("pin-fail", { modelChoice: sonnet })
  const host_ = refusesOnce("pin-fail")
  await sendMessage("t1", "hello")
  assert.equal(host_.sent.length, 1, "the host refused the turn")
  assert.equal(host_.sent[0].model, sonnet.model, "the model the chat would have run on")
  assert.equal(await choiceOf("t1"), undefined, "nothing reached Hermes, so nothing is pinned")
  await updateProfile(bot.id, { modelChoice: gpt })
  await sendMessage("t1", "and again")
  assert.equal(host_.sent.length, 2, "the second turn")
  assert.equal(host_.sent[1].model, gpt.model, "the model the user set after the failure")
  assert.deepEqual(await choiceOf("t1"), gpt, "the turn that reached Hermes is the one that pinned")
})

test("a send whose own rows the store refuses takes its pin back", async () => {
  await seed("pin-quota", { modelChoice: sonnet })
  host("pin-quota")
  const messages = db.messages as unknown as { bulkAdd: (rows: unknown) => Promise<unknown> }
  const bulkAdd = messages.bulkAdd
  messages.bulkAdd = async () => {
    throw new DOMException("The quota is full.", "QuotaExceededError")
  }
  try {
    await assert.rejects(sendMessage("t1", "hello"), /quota/i)
  } finally {
    messages.bulkAdd = bulkAdd
  }
  assert.equal(await choiceOf("t1"), undefined, "no turn ran, so nothing is pinned")
})

test("a queued turn the plugin refuses takes its pin back", async () => {
  await seed("pin-queue", { modelChoice: sonnet })
  refusesQueue("pin-queue")
  const queued = await queueMessage("t1", "hello")
  assert.ok(queued, "the message waits on this device instead")
  assert.equal(await choiceOf("t1"), undefined, "the plugin never got it, so nothing is pinned")
  const waiting = (await messagesOf("t1")).find((message) => message.id === queued)
  assert.equal(waiting?.status, "queued")
})

test("the Default row survives a send, and the chat runs the default it follows", async () => {
  const bot = await seed("pin-default", { modelChoice: sonnet })
  const host_ = host("pin-default", sonnet)
  await sendMessage("t1", "hello")
  assert.deepEqual(await choiceOf("t1"), sonnet, "the chat pinned what it started on")
  await mount(chatScreen("t1"), async () => {
    await click(pill())
    const row = findAll("button").find((one) => one.textContent?.startsWith("Default"))
    await click(row ?? null)
    await until(async () => (await choiceOf("t1"))?.model === "", "the Default row on the chat")
  })
  await updateProfile(bot.id, { modelChoice: gpt })
  await sendMessage("t1", "and again")
  assert.equal(host_.runs()[1].body.model, gpt.model, "the default it follows now, not its old pin")
  assert.equal(chosenOf(await choiceOf("t1")), undefined, "and it still follows the default")
  await mount(chatScreen("t1"), async () => {
    assert.match(pill()?.getAttribute("aria-label") ?? "", /gpt-5/, "the pill shows that default")
  })
})

test("a host that names no provider leaves the chat following the default", async () => {
  await seed("pin-noprov")
  const host_ = host("pin-noprov", { provider: "", model: "local/llama" })
  await sendMessage("t1", "hello")
  await until(async () => Boolean(await choiceOf("t1")), "the answer to the host's read")
  assert.equal(chosenOf(await choiceOf("t1")), undefined, "a pin the app can't send is no pin")
  assert.deepEqual(
    await choiceOf("t1"),
    storedPick(undefined),
    "only the row that says the host was asked",
  )
  assert.equal(host_.runs().length, 1)
  assert.ok(!("model" in host_.runs()[0].body), "no model is sent, so the host runs its own")
})

test("a chat that can never pin asks the host once, not on every send", async () => {
  await seed("pin-once")
  const host_ = countingHost("pin-once")
  await sendMessage("t1", "hello")
  await until(
    async () => (await choiceOf("t1")) !== undefined,
    "the marker the host's answer leaves",
  )
  await sendMessage("t1", "and again")
  assert.equal(host_.reads.length, 1, "the second send knew the answer already")
})

test("picking the model a chat already holds writes nothing", async () => {
  await seed("pin-same", { modelChoice: sonnet })
  host("pin-same", sonnet, { solo: true })
  await db.conversations.update("t1", { modelChoice: sonnet, changedAt: 7 })
  await mount(chatScreen("t1"), async () => {
    await click(pill())
    await until(
      async () => findAll('button[aria-pressed="true"]').length > 0,
      "the menu on the model it holds",
    )
    const chosen = findAll('button[aria-pressed="true"]').find((one) =>
      one.textContent?.includes(sonnet.model),
    )
    assert.ok(chosen, "the menu lists the model the chat already holds")
    await click(chosen)
    await settle()
  })
  assert.equal((await db.conversations.get("t1"))?.changedAt, 7, "the row was left alone")
})

test("a thread started from Main doesn't inherit the Default row, but pins", async () => {
  await seed("pin-thread", { modelChoice: sonnet })
  await db.conversations.update(MAIN, { modelChoice: storedPick(undefined) })
  const host_ = host("pin-thread")
  await mount(chatScreen(MAIN), async () => {
    await until(async () => Boolean(composerField()), "Main's composer")
    await type(composerField(), "/thread hello")
    await pressEnter()
    await until(async () => (await started()).length > 0, "the thread")
    const [thread] = await started()
    await until(async () => Boolean(await choiceOf(thread.id)), "its pin")
  })
  const [thread] = await started()
  assert.deepEqual(await choiceOf(thread.id), sonnet, "the thread fixed the model it started on")
  assert.equal(host_.runs().at(-1)?.body.model, sonnet.model, "and its turn ran on it")
})

// Last: a read nothing bounds keeps the loop alive for its own timeout, so it would hold the tests
// above it for as long as that takes.
test(
  "the user's message is written before the host is asked for a model",
  { timeout: 40_000 },
  async () => {
    await seed("pin-hang")
    const host_ = host("pin-hang")
    const slow = slowModelRead("pin-hang")
    const startedAt = Date.now()
    const sending = sendMessage("t1", "hello")
    await until(async () => (await messagesOf("t1")).length > 0, "the message row", 3000)
    assert.ok(Date.now() - startedAt < 3000, "the row landed without waiting for the host")
    await sending
    assert.equal(host_.runs().length, 1, "the message was sent")
    assert.equal(slow.reads.length, 1, "the host was asked for a model, after the run")
    assert.equal(await choiceOf("t1"), undefined, "a read that never answered pins nothing")
  },
)
