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

/** The thread's own requests, as the app's rows draw them: a steer's bubble is its reply's. */
const requests = () =>
  findAll('[data-chat-next] [data-message-id$="-u"] [data-slot="bubble-content"]').map(
    (one) => one.textContent ?? "",
  )
/** Each reply's words, without the rows its calls draw. */
const replies = () =>
  findAll('[data-chat-next] [data-slot="message"][data-align="start"] [data-slot="markdown"]').map(
    (one) => one.textContent,
  )

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
    await until(() => requests().length > 0, "chat-next drew the turn")
    assert.equal(find('[data-slot="header-title"]')?.textContent?.trim(), "Sky colours")
    assert.deepEqual(requests(), ["Why is the sky blue?"])
    assert.deepEqual(replies(), ["Rayleigh scattering."])
    assert.ok(find('[data-chat-next] [data-slot="tool-group"]'), "its call drawn as a tool row")
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
      () => requests()[0] === "Why is the sky blue?",
      "the message is drawn as the turn's request",
    )
    const chat = await db.conversations.get("c-send")
    assert.deepEqual(chat?.modelChoice, defaultPick, "the first send fixes the chat's model")
    host.latest.run!.finish("Rayleigh scattering.")
    await until(() => replies().includes("Rayleigh scattering."), "the reply lands")
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
    // The thread drops the optimistic row through its store, a beat after the field has the words.
    await until(() => requests().length === 0, "and nothing is left drawn as sent")
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
      () => requests().join("|") === "First question|And then this",
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
      () =>
        findAll('[data-chat-next] [data-message-id$="-a"] [data-slot="bubble-content"]').some(
          (one) => one.textContent === "Make it rhyme",
        ),
      "the steer is drawn inside the reply it steered",
    )
    assert.deepEqual(requests(), ["Write a poem"], "and opens no turn of its own")
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

/** Whether an element reads in the code face, from itself or any ancestor. */
const inCodeFace = (element: Element | null, what: string) => {
  assert.ok(element, `${what} is on screen`)
  return Boolean(element.closest(".font-code"))
}

test("a code session reads the agent's output in JetBrains Mono, and nothing else", async () => {
  const host = await sessionOnChatNext("c-mono")
  host.seed([{ user: "Look around", reply: "Found it.", tools: 1 }])
  await mount(chatScreen("c-mono"), async () => {
    await until(() => replies().length > 0, "the turn is drawn")
    const pane = find("[data-chat-next]")
    assert.equal(pane?.classList.contains("font-code"), false, "the pane is not in the face")
    assert.equal(inCodeFace(find('[data-slot="header-row"]'), "the header"), false, "the header")
    assert.equal(inCodeFace(composerField(), "the composer"), false, "the composer")
    assert.equal(
      inCodeFace(find('[data-chat-next] [data-slot="bubble-content"]'), "the user's bubble"),
      false,
      "the user's bubble",
    )
    assert.ok(
      inCodeFace(find('[data-chat-next] [data-slot="markdown"]'), "the reply"),
      "the reply's words",
    )
    const row = find('[data-chat-next] [data-slot="tool-group"]')
    assert.ok(row?.querySelector(".font-code"), "the tool call's row label")

    await click(row)
    assert.equal(
      inCodeFace(find('[data-slot="sheet-title"]'), "the sheet's heading"),
      false,
      "the sheet's heading",
    )
    const call = findAll("ol button")[0] ?? null
    assert.ok(inCodeFace(call, "the call"), "the call in the sheet's list")
    await click(call)
    assert.ok(inCodeFace(find("pre"), "the call's output"), "the call's input or output")
    assert.equal(
      inCodeFace(find('[data-slot="sheet-title"]'), "the sheet's heading"),
      false,
      "the detail's heading",
    )
  })
  await onChatNext("c-sans")
  await mount(chatScreen("c-sans"), async () => {
    await until(() => Boolean(composerField()), "the chat has loaded")
    assert.equal(findAll(".font-code").length, 0, "a plain chat has the face nowhere")
  })
})

test("a delegation draws as the app's agent card, which follows its child to done", async () => {
  const { host } = await onChatNext("c-agents", {}, { plugin: true })
  await mount(chatScreen("c-agents"), async () => {
    const run = await midReply(host, "Look into it")
    const [child] = run.delegate("Check the weather in Lisbon")
    run.finish("Delegated.")
    await until(
      () =>
        find('[data-chat-next] [data-slot="agent-card"]')?.getAttribute("data-agent") === child.id,
      "the call is the app's card for its child",
    )
    child.finish("The weather is mild.").finish("It is mild, the subagent says.")
    await until(
      () => replies().includes("It is mild, the subagent says."),
      "the wake turn lands under it",
    )
    assert.match(
      find('[data-chat-next] [data-slot="agent-card"]')?.textContent ?? "",
      /Lisbon|weather/i,
      "and the card still names what its child was asked",
    )
  })
})

test("a finished turn reads what the plugin holds beside it, and its todo list is the pill", async () => {
  const { host } = await onChatNext("c-todos", {}, { plugin: true })
  await mount(chatScreen("c-todos"), async () => {
    const run = await midReply(host, "Plan it out")
    host.todos.list = [
      { id: "1", content: "Read the brief", status: "completed" },
      { id: "2", content: "Write the plan", status: "in_progress" },
    ]
    run.finish("Planned.")
    await until(() => host.todos.reads > 0, "the turn's end read the session's todos")
    await until(
      () =>
        Boolean(find('[data-chat-next] [data-slot="composer-slot"]')?.textContent?.includes("1/2")),
      "and the list is the pill above the composer",
    )
  })
})

test("a chat's first turn takes the title Hermes gave its session", async () => {
  const { host } = await onChatNext("c-title")
  // Seeded chats carry a title the user set, which the host's never replaces.
  await db.conversations.update("c-title", { titleEdited: false })
  await mount(chatScreen("c-title"), async () => {
    const run = await midReply(host, "Why do leaves change colour?")
    host.titled.title = "Autumn leaves"
    run.finish("Chlorophyll breaks down.")
    await until(
      () => find('[data-slot="header-title"]')?.textContent?.trim() === "Autumn leaves",
      "the header carries the host's title",
    )
  })
})

test("a reply's MEDIA tag draws as the file it names, read through the chat's own bot", async () => {
  const { host } = await onChatNext("c-media", {}, { plugin: true })
  host.seed([{ user: "Draw it", reply: "Here: MEDIA:/home/h/.hermes/chart.png" }])
  await mount(chatScreen("c-media"), async () => {
    await until(
      () => Boolean(find('[data-chat-next] [aria-label="Open chart.png"]')),
      "the tag is the image's cell",
    )
    assert.equal(
      replies().some((one) => one?.includes("MEDIA:")),
      false,
      "and no tag is left as text",
    )
  })
})
