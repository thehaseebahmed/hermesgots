/**
 * chat-next on the app's own routes (ADR 0065): with its Developer switch on, a plain chat at
 * `/c/<id>` opens on chat-next, read from the chat's own bot and session; with it off, or for a chat
 * chat-next can't run yet, the current screen draws it as before.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { readAgents, readLiveRun } from "@/chat-next/api"
import { db } from "@/lib/db"
import { fakeHost } from "./chat-next-host.ts"
import {
  botProfile,
  chatScreen,
  find,
  findAll,
  mount,
  seedChats,
  settle,
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
