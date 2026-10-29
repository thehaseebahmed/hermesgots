/**
 * chat-next on the app's own routes (ADR 0065): with its Developer switch on, a plain chat at
 * `/c/<id>` opens on chat-next, read from the chat's own bot and session; with it off, or for a chat
 * chat-next can't run yet, the current screen draws it as before.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { readAgents, readLiveRun } from "@/chat-next/api"
import { db, type Profile, type Settings } from "@/lib/db"
import { fakeHost } from "./chat-next-host.ts"
import {
  botProfile,
  chatScreen,
  click,
  composerField,
  find,
  findAll,
  mount,
  pressEnter,
  seedChats,
  settle,
  type,
} from "./component-kit.tsx"

const bot = botProfile("hermes")

/** Waits on the screen as a person would: the real screen polls at its real pace, so up to 6s. */
async function until(check: () => boolean, what: string) {
  const by = Date.now() + 6_000
  while (!check() && Date.now() < by) {
    await settle()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
  }
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
async function onChatNext(
  id: string,
  patch: Partial<Profile> = {},
  { plugin = false, settings = {} }: { plugin?: boolean; settings?: Partial<Settings> } = {},
) {
  const defaultPick = { provider: "anthropic", model: "claude-sonnet-5-5" }
  await seedChats([{ id, title: "Sky colours" }], {
    // An address of the chat's own: what a host's plugin offers is remembered per address.
    bots: [{ ...bot, baseUrl: `http://${id}.test/v1`, modelChoice: defaultPick, ...patch }],
    settings: { chatNext: true, ...settings },
  })
  return { host: fakeHost(`memento-${id}`, { plugin }), defaultPick }
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

/** Starts a turn and leaves it running, so the next message lands in the middle of it. */
async function midReply(host: ReturnType<typeof fakeHost>, first: string) {
  await sendFromComposer(first)
  await until(() => host.asked.runs === 1, "the first turn is running")
  await until(() => Boolean(find('button[aria-label="Stop"]')), "the composer knows it is")
  return host.latest.run!
}

test("a message sent mid-reply goes to the plugin's queue and runs once the reply is over", async () => {
  const { host } = await onChatNext("c-queue", {}, { plugin: true })
  await mount(chatScreen("c-queue"), async () => {
    const first = await midReply(host, "First question")
    await type(composerField(), "And then this")
    await pressEnter()
    await until(() => host.queue.length === 1, "the plugin holds the message")
    assert.equal(
      host.queue[0].body.input instanceof Array,
      true,
      "with the whole run it will start",
    )
    assert.equal(host.asked.runs, 1, "and nothing was started beside the running reply")
    await until(
      () => find("[data-queued]")?.textContent?.includes("And then this") ?? false,
      "the queued message waits at the end of the thread",
    )
    first.finish("First answer.")
    // The plugin starts it once the reply is over; the thread follows the turn it opens.
    await until(() => host.queue.length === 0 && host.latest.run !== first, "the plugin started it")
    host.latest.run!.finish("Second answer.")
    await until(
      () =>
        findAll("[data-chat-next] [data-user]")
          .map((one) => one.textContent)
          .join("|") === "First question|And then this",
      "both turns are drawn, in order",
    )
    await until(() => find("[data-queued]") === null, "and nothing is left waiting")
  })
})

test("Remove takes a queued message back off the plugin", async () => {
  const { host } = await onChatNext("c-unqueue", {}, { plugin: true })
  await mount(chatScreen("c-unqueue"), async () => {
    await midReply(host, "Long job")
    await type(composerField(), "Never mind")
    await pressEnter()
    await until(() => Boolean(find("[data-remove-queued]")), "the queued message offers Remove")
    await click(find("[data-remove-queued]"))
    await until(() => host.queue.length === 0, "the plugin no longer holds it")
    await until(() => find("[data-queued]") === null, "and it is gone from the thread")
  })
})

test("with Steer by default, a message sent mid-reply steers it and is drawn in the reply", async () => {
  const { host } = await onChatNext(
    "c-steer",
    {},
    { plugin: true, settings: { steerByDefault: true } },
  )
  await mount(chatScreen("c-steer"), async () => {
    const run = await midReply(host, "Write a poem")
    await type(composerField(), "Make it rhyme")
    await pressEnter()
    await until(
      () => host.rows.some((row) => row.display_kind === "steer"),
      "the plugin steered the running reply",
    )
    assert.equal(host.queue.length, 0, "and holds nothing back")
    run.finish("Roses are red.")
    await until(
      () => find("[data-chat-next] [data-steer]")?.textContent?.includes("Make it rhyme") ?? false,
      "the steer is drawn inside the reply it steered",
    )
    assert.deepEqual(
      findAll("[data-chat-next] [data-user]").map((one) => one.textContent),
      ["Write a poem"],
      "and opens no turn of its own",
    )
  })
})

test("a bot whose plugin can't queue hands a mid-reply message back", async () => {
  const { host } = await onChatNext("c-noqueue")
  await mount(chatScreen("c-noqueue"), async () => {
    await midReply(host, "Busy now")
    await type(composerField(), "Hold this")
    await pressEnter()
    await until(() => composerField()?.value === "Hold this", "the words are back in the field")
    assert.equal(host.asked.runs, 1, "and no second run was started")
  })
})

/** A project session on chat-next, with its host's plugin answering for it. */
async function sessionOnChatNext(id: string) {
  const { host } = await onChatNext(id, {}, { plugin: true })
  await db.conversations.update(id, { projectId: "p1" })
  return host
}

const button = (label: string) =>
  findAll("button").find((one) => one.textContent?.trim() === label) ?? null

test("a project session opens on chat-next and posts its workspace before the turn", async () => {
  const host = await sessionOnChatNext("c-code")
  await mount(chatScreen("c-code"), async () => {
    await until(() => Boolean(find("[data-chat-next]")), "the session opens on chat-next")
    await sendFromComposer("Fix the build")
    await until(() => host.asked.runs === 1, "the turn started")
    assert.ok(host.workspace.posts >= 1, "the workspace was posted before it")
    assert.match(
      String(host.latest.body!.instructions),
      /Work in the worktree on hermes\/x\./,
      "and the run is told where it works",
    )
  })
})

test("a session whose repo is gone is read-only: the card says why and nothing can be sent", async () => {
  const host = await sessionOnChatNext("c-blocked")
  host.workspace.blocked = "The repo me/repo was removed from the project."
  await mount(chatScreen("c-blocked"), async () => {
    await until(
      () =>
        find("[data-chat-next]")?.textContent?.includes("was removed from the project") ?? false,
      "the session says why it is read-only",
    )
    assert.equal(composerField(), null, "and has no composer")
  })
})

test("a plan waiting is approved from its card: the mode moves and the plan's run starts", async () => {
  const host = await sessionOnChatNext("c-plan")
  host.workspace.mode = "plan"
  host.workspace.planPending = true
  await mount(chatScreen("c-plan"), async () => {
    await until(() => Boolean(button("Accept edits")), "the plan waits on its card")
    await click(button("Accept edits"))
    await until(() => host.asked.runs === 1, "approving starts the plan's run")
    assert.equal(host.workspace.mode, "accept_edits", "in the mode it was approved in")
    const input = host.latest.body!.input as { content: string }[]
    assert.match(input.at(-1)!.content, /plans\/hermes-x\.md/, "told to work through that plan")
  })
})
