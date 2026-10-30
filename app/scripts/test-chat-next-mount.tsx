/**
 * chat-next on the app's own routes (ADR 0065): with its Developer switch on, a plain chat at
 * `/c/<id>` opens on chat-next, read from the chat's own bot and session; with it off, or for a chat
 * chat-next can't run yet, the current screen draws it as before.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { readAgents, readLiveRun } from "@/chat-next/api"
import { attachmentsText } from "@/lib/attachment-text"
import { BreakReminderActivityContext } from "@/components/break-reminder-context"
import { FIRST_ROWS } from "@/components/chat/first-rows"
import { db, type Profile, type Settings } from "@/lib/db"
import { BUSY_WORDS } from "@/lib/busy-words"

import { fakeHost } from "./chat-next-host.ts"
import { SALES, block, cardOf, codeOf, drawn, replyRow, warm } from "./openui-kit.tsx"
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
  text,
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

const writing = (words: string) => BUSY_WORDS.writing.some((word) => words.includes(`${word}…`))

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

/** Whether an element reads in the chat's face, from itself or any ancestor. */
const inChatFace = (element: Element | null, what: string) => {
  assert.ok(element, `${what} is on screen`)
  return Boolean(element.closest(".font-code"))
}

for (const [name, project] of [
  ["a code session", true],
  ["a plain chat", false],
] as const) {
  test(`${name} reads what is said in it in JetBrains Mono, and none of the chrome`, async () => {
    const id = project ? "c-mono" : "c-mono-chat"
    const host = project ? await sessionOnChatNext(id) : (await onChatNext(id)).host
    host.seed([{ user: "Look around", reply: "Found it.", tools: 1 }])
    await mount(chatScreen(id), async () => {
      await until(() => replies().length > 0, "the turn is drawn")
      const pane = find("[data-chat-next]")
      assert.equal(pane?.classList.contains("font-code"), false, "the pane is not in the face")
      assert.equal(inChatFace(find('[data-slot="header-row"]'), "the header"), false, "the header")
      assert.ok(inChatFace(composerField(), "the composer"), "the composer's text")
      assert.ok(
        inChatFace(find('[data-chat-next] [data-slot="bubble-content"]'), "the user's bubble"),
        "the user's bubble",
      )
      assert.ok(
        inChatFace(find('[data-chat-next] [data-slot="markdown"]'), "the reply"),
        "the reply's words",
      )
      const row = find('[data-chat-next] [data-slot="tool-group"]')
      assert.ok(row?.querySelector(".font-code"), "the tool call's row label")

      await click(row)
      assert.equal(
        inChatFace(find('[data-slot="sheet-title"]'), "the sheet's heading"),
        false,
        "the sheet's heading",
      )
      const call = findAll("ol button")[0] ?? null
      assert.ok(inChatFace(call, "the call"), "the call in the sheet's list")
      await click(call)
      assert.ok(inChatFace(find("pre"), "the call's output"), "the call's input or output")
      assert.equal(
        inChatFace(find('[data-slot="sheet-title"]'), "the sheet's heading"),
        false,
        "the detail's heading",
      )
    })
  })
}

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

test("a reply's thinking draws as the thought rows the app's thread draws everywhere", async () => {
  const { host } = await onChatNext("c-think")
  host.seed([
    {
      user: "Look around",
      reply: "Found it.",
      tools: 1,
      thoughts: ["I should look first.", "Now say so."],
    },
  ])
  await mount(chatScreen("c-think"), async () => {
    await until(() => replies().length > 0, "the turn is drawn")
    // Stretches only a tool call separates are one row, as everywhere else the app draws a reply.
    const rows = findAll('[data-chat-next] [data-slot="thinking-line"]')
    assert.equal(rows.length, 1)
    await click(rows[0].querySelector("button"))
    const body = find('[data-slot="thinking-body"]')?.textContent ?? ""
    assert.match(body, /I should look first\./)
    assert.match(body, /Now say so\./)
  })
})

test("an approval and a question are the app's own cards, answered where chat-next answers", async () => {
  const { host } = await onChatNext("c-prompts")
  await mount(chatScreen("c-prompts"), async () => {
    const run = await midReply(host, "Clean up")
    run.requestApproval("rm -rf /tmp/x", "delete in root path")
    await until(() => Boolean(button("Allow once")), "the approval card, with its choices")
    assert.match(text(), /Approval needed/)
    assert.match(text(), /rm -rf \/tmp\/x/)
    assert.ok(button("Deny") && button("Allow in chat") && button("Always allow"))
    await click(button("Allow once"))
    await until(() => host.approvals.length === 1, "the host was given the answer")
    assert.deepEqual(host.approvals[0].choice, "once")

    run.ask({ question: "Which do you prefer?", choices: ["tea", "coffee"], multi_select: false })
    await until(() => /Which do you prefer\?/.test(text()), "the question card")
    await click(findAll("button").find((one) => one.textContent?.includes("coffee")) ?? null)
    await click(button("Send"))
    await until(() => host.answers.length === 1, "the host was given the answer")
    assert.equal(host.answers[0].answer, "coffee")
  })
})

test("while a subagent works the composer is Stop, and one press stops the session's children", async () => {
  const { host } = await onChatNext("c-stop-all", {}, { plugin: true })
  await mount(chatScreen("c-stop-all"), async () => {
    await sendFromComposer("Fan out")
    await until(() => host.asked.runs === 1, "the turn is running")
    host.latest.run!.delegate("look into it")
    host.latest.run!.finish("Dispatched.")
    await until(() => host.asked.info > 0, "the plugin has said what it can do")
    await until(
      () => /subagent/i.test(text()) && !find('button[aria-label="Send"]'),
      "the child is listed and keeps the composer on Stop",
    )
    await until(() => Boolean(find('button[aria-label="Stop"]')), "Stop stays while a child works")
    await click(find('button[aria-label="Stop"]'))
    await until(() => host.asked.agentStops === 1, "the plugin was asked to stop the children")
  })
})

test("a missed question's Ask again sends through the thread's own send", async () => {
  const { host } = await onChatNext("c-ask-again")
  await mount(chatScreen("c-ask-again"), async () => {
    const run = await midReply(host, "Pick for me")
    const missed = JSON.stringify({
      responses: [{ question: "Tea or coffee?", choices_offered: [], timed_out: true }],
      outcome: "timed_out",
    })
    run.tool("clarify", "Tea or coffee?", missed)
    run.finish("No answer came.")
    await until(() => Boolean(button("Ask again")), "the missed question offers Ask again")
    await until(() => !find('button[aria-label="Stop"]'), "the first turn is over")
    await click(button("Ask again"))
    await until(() => host.asked.runs === 2, "the thread sent the message as a turn")
    assert.match(JSON.stringify(host.latest.body), /Ask me that again\./)
  })
})

test("the composer carries the chat's model pill, which names the model the chat runs on", async () => {
  const { host } = await onChatNext("c-pill")
  await mount(chatScreen("c-pill"), async () => {
    await until(() => Boolean(composerField()), "the composer is drawn")
    assert.ok(find('button[aria-label^="Model:"]'), "the model pill is in the composer")
    await sendFromComposer("Why is the sky blue?")
    await until(() => host.asked.runs === 1, "the turn was sent")
    await until(
      () => /claude-sonnet-5-5/.test(find('button[aria-label^="Model:"]')?.textContent ?? ""),
      "the pill names the pinned model",
    )
  })
})

test("the header's options rename a chat and delete it, as the current screen's do", async () => {
  await onChatNext("c-options")
  await db.sentFiles.put({ session: "memento-c-options", path: "/h/a.png", blob: new Blob(["x"]) })
  await mount(chatScreen("c-options"), async () => {
    await until(() => Boolean(find('button[aria-label="Chat options"]')), "the options button")
    await click(find('button[aria-label="Chat options"]'))
    await click(
      findAll('[role="menuitem"]').find((one) => one.textContent?.includes("Rename")) ?? null,
    )
    const field = find('input[aria-label="Chat title"]') as HTMLInputElement | null
    assert.ok(field, "the rename dialog")
    await type(field, "Renamed chat")
    await click(button("Save"))
    await until(
      () => find('[data-slot="header-title"]')?.textContent?.trim() === "Renamed chat",
      "the header carries the new title",
    )
    assert.equal((await db.conversations.get("c-options"))?.titleEdited, true)

    await click(find('button[aria-label="Chat options"]'))
    await click(
      findAll('[role="menuitem"]').find((one) => one.textContent?.includes("Delete")) ?? null,
    )
    await click(button("Delete"))
    await settle()
    assert.equal(await db.conversations.get("c-options"), undefined, "the chat is deleted")
    assert.equal(await db.sentFiles.count(), 0, "and the files it sent go with it")
  })
})

test("the dividers the plugin's record places are drawn between the turns", async () => {
  const { host } = await onChatNext("c-dividers")
  host.seed([
    { user: "First", reply: "One." },
    { user: "Second", reply: "Two." },
  ])
  await db.conversations.update("c-dividers", {
    compactions: [{ at: 0, tokens: 168_000, window: 200_000 }],
  })
  await mount(chatScreen("c-dividers"), async () => {
    await until(() => replies().length === 2, "both turns are drawn")
    await until(
      () => Boolean(find('[role="separator"][aria-label="Compaction · 168k of 200k (84%)"]')),
      "the compaction's divider, with how full the context was",
    )
  })
})

test("a long chat opens on its last rows and draws the rest a beat later", async () => {
  const { host } = await onChatNext("c-long")
  host.seed(Array.from({ length: 40 }, (_, at) => ({ user: `Ask ${at}`, reply: `Answer ${at}` })))
  await mount(chatScreen("c-long"), async () => {
    const rows = () => findAll('[data-chat-next] [data-slot="message"]').length
    for (let tries = 0; !rows() && tries < 400; tries++)
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    const first = rows()
    assert.ok(first > 0 && first <= FIRST_ROWS, `the first frame drew ${first} rows`)
    await until(() => rows() === 80, "the rest of the chat follows")
  })
})

test("an account near its limit warns above the composer, and View usage opens the sheet", async () => {
  await onChatNext("c-limit", {
    providerUsage: {
      provider: "anthropic",
      at: Date.now(),
      windows: [{ label: "Session", usedPercent: 94, resetsAt: Date.now() + 3 * 3_600_000 }],
    },
  })
  await mount(chatScreen("c-limit"), async () => {
    await until(() => Boolean(button("View usage")), "the limit banner, with a way to the usage")
    await click(button("View usage"))
    await until(() => /Context/.test(text()), "the usage sheet")
  })
})

test("an interface a reply wrote draws as the app's own card, not as its code", async () => {
  const { host } = await onChatNext("c-interface")
  host.seed([{ user: "Show sales", reply: block(SALES) }])
  await warm()
  await mount(chatScreen("c-interface"), async () => {
    await until(() => findAll("[data-slot=message]").length === 2, "the turn is drawn")
    await drawn(
      () => Boolean(cardOf(replyRow("Quarterly sales"))),
      "the interface draws as the library's card",
    )
    assert.equal(codeOf(replyRow("Quarterly sales")), null, "and not as the code it came as")
  })
})

test("the header's line stays put while a reply works; the thread says what it is doing", async () => {
  const host = await sessionOnChatNext("c-activity")
  await mount(chatScreen("c-activity"), async () => {
    const line = () => find('[data-slot="header-line"]')?.textContent ?? ""
    await sendFromComposer("Look around")
    await until(() => host.asked.runs === 1, "the turn is running")
    host.latest.run!.say("Looking.")
    await until(() => writing(text()), "the thread says the reply is being written")
    await until(() => line().includes("repo"), "the header names the bot and its repos")
    assert.ok(!writing(line()), "and never what the reply is doing")
    host.latest.run!.finish("Looking.")
  })
})

test("a reply the host wrote with no finish reason is not drawn as still being written", async () => {
  const { host } = await onChatNext("c-unmarked", {}, { plugin: true })
  host.seed([{ user: "Look around", reply: "All done.", unmarked: true }])
  await mount(chatScreen("c-unmarked"), async () => {
    await until(() => replies().includes("All done."), "the turn is drawn")
    await until(() => host.asked.runs === 0 && !writing(text()), "and it is at rest")
  })
})

test("a turn the host gave up on is drawn as failed, in the host's words, and not as writing", async () => {
  const { host } = await onChatNext("c-failed", {}, { plugin: true })
  host.seed([{ user: "Look around", reply: "", failed: "Your request was not processed." }])
  await mount(chatScreen("c-failed"), async () => {
    await until(() => text().includes("Your request was not processed."), "the host's words show")
    assert.ok(!writing(text()), "and the turn is at rest")
  })
})

test("Retry sends a failed turn's request again, the host drops the failure and the thread shows the resend only", async () => {
  const { host } = await onChatNext("c-retry", {}, { plugin: true })
  host.seed([{ user: "Look around", reply: "", failed: "Your request was not processed." }])
  await mount(chatScreen("c-retry"), async () => {
    await until(() => Boolean(find("[data-retry]")), "the failed turn offers Retry")
    await click(find("[data-retry]"))
    await until(() => host.asked.runs === 1, "the request is sent again")
    assert.equal(host.asked.failedClears, 1, "after the host dropped the failed turn")
    assert.match(String(JSON.stringify(host.latest.body)), /Look around/)
    host.latest.run!.say("Looking.")
    host.latest.run!.finish("Looking.")
    await until(() => replies().includes("Looking."), "the second try answers")
    assert.deepEqual(requests(), ["Look around"], "the request shows once")
    assert.ok(!text().includes("Your request was not processed."), "and the failure is gone")
    assert.ok(!find("[data-retry]"), "with nothing left to retry")
  })
})

test("Retry without the plugin's route still sends again and the thread shows the resend only", async () => {
  const { host } = await onChatNext("c-retry-bare", {}, { plugin: false })
  host.seed([{ user: "Look around", reply: "", failed: "Your request was not processed." }])
  await mount(chatScreen("c-retry-bare"), async () => {
    await until(() => Boolean(find("[data-retry]")), "the failed turn offers Retry")
    await click(find("[data-retry]"))
    await until(() => host.asked.runs === 1, "the request is sent again")
    assert.equal(host.asked.failedClears, 0, "the host was not asked to drop anything")
    host.latest.run!.finish("Looking.")
    await until(() => replies().includes("Looking."), "the second try answers")
    assert.deepEqual(requests(), ["Look around"], "the request shows once")
    assert.ok(!text().includes("Your request was not processed."), "and the failure is hidden")
  })
})

test("a failed turn the user did not ask again stays, with Retry on the last one only", async () => {
  const { host } = await onChatNext("c-retry-last", {}, { plugin: true })
  host.seed([
    { user: "First", reply: "", failed: "Your request was not processed." },
    { user: "Second", reply: "", failed: "Your request was not processed." },
  ])
  await mount(chatScreen("c-retry-last"), async () => {
    await until(() => findAll("[data-retry]").length === 1, "one Retry, on the last turn")
    assert.deepEqual(requests(), ["First", "Second"])
    assert.equal(
      (text().match(/Your request was not processed\./g) ?? []).length,
      2,
      "both failures are shown",
    )
  })
})

test("a reply this device watched keeps what it cost, under the reply, once the transcript has it", async () => {
  const { host } = await onChatNext("c-stats")
  await mount(chatScreen("c-stats"), async () => {
    const run = await midReply(host, "Why is the sky blue?")
    run.say("Rayleigh scattering.")
    run.finish("Rayleigh scattering.")
    await until(() => /\b1 tokens\b/.test(text()), "the turn's tokens and time, under the reply")
    // The host's transcript replaced the streamed turn; the figures stay with the row that opened it.
    await until(() => !find('button[aria-label="Stop"]'), "the turn is over")
    await settle()
    assert.match(text(), /\b1 tokens\b/)
    const kept = (await db.sessionStates.get("memento-c-stats"))?.stats
    assert.equal(Object.keys(kept ?? {}).length, 1, "and the device keeps them across a reload")
  })
})

test("a reply the run carries on without the app counts toward the break reminder, until it waits", async () => {
  const { host } = await onChatNext("c-break")
  const states: boolean[] = []
  await mount(
    <BreakReminderActivityContext.Provider value={(active) => states.push(active)}>
      {chatScreen("c-break")}
    </BreakReminderActivityContext.Provider>,
    async () => {
      const run = await midReply(host, "Clean up")
      await until(() => states.at(-1) === true, "a running reply is background-safe work")
      run.requestApproval("rm -rf /tmp/x", "delete")
      await until(() => states.at(-1) === false, "a reply waiting on the user is not")
    },
  )
})

test("a file this device sent downloads from the bytes it holds, with no read of the host", async () => {
  const { host } = await onChatNext("c-held", {}, { plugin: true })
  const file = {
    id: "f0",
    name: "field notes.txt",
    type: "text/plain",
    size: 5,
    image: false,
    path: "/host/files/field notes.txt",
  }
  host.seed([{ user: attachmentsText("Read this", [file]), reply: "Read." }])
  await db.sentFiles.put({ session: "memento-c-held", path: file.path, blob: new Blob(["notes"]) })
  const saved: string[] = []
  const reads: string[] = []
  const anchor = window.HTMLAnchorElement.prototype
  const real = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, click: anchor.click }
  const fetched = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/media")) reads.push(String(input))
    return fetched(input, init)
  }) as typeof fetch
  URL.createObjectURL = () => "blob:held"
  URL.revokeObjectURL = () => {}
  anchor.click = function (this: HTMLAnchorElement) {
    saved.push(this.download)
  }
  try {
    await mount(chatScreen("c-held"), async () => {
      const row = () =>
        findAll("button").find(
          (one) => one.getAttribute("aria-label") === `Download ${file.name}`,
        ) ?? null
      await until(() => row() !== null, "the file's row")
      // The row is there a moment before the device has read what it holds.
      for (let tries = 0; !saved.length && tries < 40; tries++) {
        await click(row())
        await settle()
      }
      assert.deepEqual(saved, [file.name], "the download, under the file's own name")
      assert.deepEqual(reads, [], "the bytes were the device's own, so the host was not asked")
    })
  } finally {
    globalThis.fetch = fetched
    URL.createObjectURL = real.create
    URL.revokeObjectURL = real.revoke
    anchor.click = real.click
  }
})
