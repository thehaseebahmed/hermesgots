/**
 * chat-next on the app's own routes (ADR 0065): with its Developer switch on, a plain chat at
 * `/c/<id>` opens on chat-next, read from the chat's own bot and session; with it off, or for a chat
 * chat-next can't run yet, the current screen draws it as before.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { readAgents, readLiveRun } from "@/chat-next/api"
import { db, type Profile } from "@/lib/db"
import { fakeHost } from "./chat-next-host.ts"
import {
  botProfile,
  chatScreen,
  click,
  composerField,
  find,
  findAll,
  mount,
  seedChats,
  settle,
  type,
} from "./component-kit.tsx"

const bot = botProfile("hermes")

async function until(check: () => boolean, what: string) {
  for (let tries = 0; !check() && tries < 40; tries++) await settle()
  assert.ok(check(), what)
}

test("with the switch on, a plain chat opens on chat-next, read from its bot and its session", async () => {
  await seedChats([{ id: "c-next", title: "Sky colours", messages: ["held by the old screen"] }], {
    bots: [bot],
    settings: { chatNext: true },
  })
  const host = fakeHost("memento-c-next")
  host.seed([{ user: "Why is the sky blue?", reply: "Rayleigh scattering.", tools: 1 }])
  await mount(chatScreen("c-next"), async () => {
    await until(() => Boolean(find("[data-chat-next] main > section")), "chat-next drew the turn")
    assert.equal(find('[data-slot="header-title"]')?.textContent?.trim(), "Sky colours")
    assert.equal(find("[data-chat-next] [data-user]")?.textContent, "Why is the sky blue?")
    assert.deepEqual(
      findAll("[data-chat-next] [data-text]").map((one) => one.textContent),
      ["Rayleigh scattering."],
    )
    assert.ok(host.asked.transcript > 0, "the chat's own session was read from its bot's host")
    assert.equal(
      find('[data-pane="route"]')?.textContent?.includes("held by the old screen"),
      false,
      "and nothing the current screen keeps for the chat is drawn",
    )
  })
})

test("with the switch off, the same chat stays on the current screen", async () => {
  await seedChats([{ id: "c-off", title: "Sky colours", messages: ["held by the old screen"] }], {
    bots: [bot],
  })
  await mount(chatScreen("c-off"), async () => {
    await until(
      () => Boolean(find('[data-pane="route"]')?.textContent?.includes("held by the old screen")),
      "the current screen drew the chat",
    )
    assert.equal(find("[data-chat-next]"), null)
  })
})

test("a project session stays on the current screen, switch or not", async () => {
  await seedChats([{ id: "c-code", title: "A session", messages: ["held by the old screen"] }], {
    bots: [bot],
    settings: { chatNext: true },
  })
  await db.conversations.update("c-code", { projectId: "p1" })
  await mount(chatScreen("c-code"), async () => {
    await until(
      () => Boolean(find('[data-pane="route"]')?.textContent?.includes("held by the old screen")),
      "the current screen drew the session",
    )
    assert.equal(find("[data-chat-next]"), null)
  })
})

test("a bot served at /p/<profile> reaches its plugin inside the plugin's own prefix", async () => {
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input))
    return new Response(JSON.stringify({ run_ids: {}, agents: [] }), { status: 200 })
  }) as typeof fetch
  const connection = { server: "http://hermes.test/p/work/v1", key: "k" }
  await readLiveRun(connection, "s1")
  await readAgents(connection, "s1")
  assert.deepEqual(asked, [
    "http://hermes.test/api/plugins/memento/p/work/runs/live",
    "http://hermes.test/api/plugins/memento/p/work/sessions/s1/agents",
  ])
})

/** The chat seeded on chat-next, its host, and its bot's default pick: what the next sends run on. */
async function onChatNext(id: string, patch: Partial<Profile> = {}) {
  const defaultPick = { provider: "anthropic", model: "claude-sonnet-5-5" }
  await seedChats([{ id, title: "Sky colours" }], {
    bots: [{ ...bot, modelChoice: defaultPick, ...patch }],
    settings: { chatNext: true },
  })
  return { host: fakeHost(`memento-${id}`), defaultPick }
}

async function sendFromComposer(text: string) {
  await until(() => Boolean(composerField()), "the app's composer is drawn")
  await type(composerField(), text)
  await click(find('button[aria-label="Send"]'))
}

test("the app's composer sends a turn the way every send goes, and pins the chat's model", async () => {
  const { host, defaultPick } = await onChatNext("c-send")
  await mount(chatScreen("c-send"), async () => {
    await sendFromComposer("Why is the sky blue?")
    await until(() => host.asked.runs === 1, "the host was asked to run the message")
    const body = host.latest.body!
    assert.equal(body.session_id, "memento-c-send", "the chat's own session")
    assert.deepEqual(
      { provider: body.provider, model: body.model },
      defaultPick,
      "on the bot's default, which the chat had not picked away from",
    )
    assert.deepEqual(body.input, [{ role: "user", content: "Why is the sky blue?" }])
    assert.match(String(body.instructions), /todo_list/, "with the instructions every send carries")
    assert.ok(host.latest.key, "under a key, so a retried post can't start a second run")
    await until(
      () => find("[data-chat-next] [data-user]")?.textContent === "Why is the sky blue?",
      "the message is drawn as the turn's request",
    )
    const chat = await db.conversations.get("c-send")
    assert.deepEqual(chat?.modelChoice, defaultPick, "the first send fixes the chat's model")
    host.latest.run!.finish("Rayleigh scattering.")
    await until(
      () =>
        findAll("[data-chat-next] [data-text]").some(
          (one) => one.textContent === "Rayleigh scattering.",
        ),
      "the reply lands",
    )
  })
})

test("a send the host refuses hands the words back and pins nothing", async () => {
  await onChatNext("c-refused")
  const answer = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input)).pathname === "/v1/runs"
      ? new Response(JSON.stringify({ error: { message: "No." } }), { status: 500 })
      : answer(input, init)) as typeof fetch
  await mount(chatScreen("c-refused"), async () => {
    await sendFromComposer("Will this go?")
    await until(() => composerField()?.value === "Will this go?", "the words are back in the field")
    assert.equal(find("[data-chat-next] [data-user]"), null, "and nothing was drawn as sent")
    assert.equal((await db.conversations.get("c-refused"))?.modelChoice, undefined)
  })
})

test("Stop stops the run the thread is following", async () => {
  const { host } = await onChatNext("c-stop")
  await mount(chatScreen("c-stop"), async () => {
    await sendFromComposer("Count to a million")
    await until(() => host.asked.runs === 1, "the run started")
    await until(() => Boolean(find('button[aria-label="Stop"]')), "the composer offers Stop")
    await click(find('button[aria-label="Stop"]'))
    await until(() => host.asked.stops === 1, "the host was asked to stop it")
    await until(() => Boolean(find('button[aria-label="Send"]')), "and Send comes back")
  })
})
