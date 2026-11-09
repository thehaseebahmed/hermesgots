/**
 * chat-next on the app's own routes (ADR 0065): a chat at `/c/<id>` opens on chat-next when its bot
 * can be called, read from the chat's own bot and session; a chat whose bot has no address or no
 * key — or one chat-next can't run yet — the current screen draws as before.
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
import { pointLine, pointText } from "@/lib/point-marker"
import { RETRY_OPEN } from "@/lib/retry-message"

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
  sendPress,
  seedChats,
  settle,
  spyOpen,
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
async function until(check: () => boolean | Promise<boolean>, what: string) {
  const by = Date.now() + 6_000
  while (!(await check()) && Date.now() < by) {
    await settle()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
  }
  assert.ok(await check(), what)
}

const writing = (words: string) => BUSY_WORDS.writing.some((word) => words.includes(`${word}…`))

test("a plain chat opens on chat-next, read from its bot and its session", async () => {
  await seedChats([{ id: "c-next", title: "Sky colours", messages: ["held by the old screen"] }], {
    bots: [bot],
  })
  const host = fakeHost("gots-c-next")
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

test("a chat whose bot has no key stays on the current screen", async () => {
  await seedChats([{ id: "c-off", title: "Sky colours", messages: ["held by the old screen"] }], {
    bots: [{ ...bot, apiKey: "" }],
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
    "http://hermes.test/api/plugins/gots/p/work/runs/live",
    "http://hermes.test/api/plugins/gots/p/work/sessions/s1/agents",
  ])
})

/** The chat seeded on chat-next, its host, and its bot's default pick: what the next sends run on. */
async function onChatNext(
  id: string,
  patch: Partial<Profile> = {},
  {
    plugin = false,
    settings = {},
    host: hostOptions = {},
  }: {
    plugin?: boolean
    settings?: Partial<Settings>
    /** What the host is like: a cooperative stop, a slow read, a prompt it holds back. */
    host?: Parameters<typeof fakeHost>[1]
  } = {},
) {
  const defaultPick = { provider: "anthropic", model: "claude-sonnet-5-5" }
  await seedChats([{ id, title: "Sky colours" }], {
    // An address of the chat's own: what a host's plugin offers is remembered per address.
    bots: [{ ...bot, baseUrl: `http://${id}.test/v1`, modelChoice: defaultPick, ...patch }],
    settings,
  })
  return { host: fakeHost(`gots-${id}`, { ...hostOptions, plugin }), defaultPick }
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
    assert.equal(body.session_id, "gots-c-send", "the chat's own session")
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

test("a send the host refuses keeps the message in the thread, marked, and pins nothing", async () => {
  await onChatNext("c-refused")
  const answer = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input)).pathname === "/v1/runs"
      ? new Response(JSON.stringify({ error: { message: "No." } }), { status: 500 })
      : answer(input, init)) as typeof fetch
  await mount(chatScreen("c-refused"), async () => {
    await sendFromComposer("Will this go?")
    await until(
      () => Boolean(find('[data-unsent] [aria-label="Not sent"]')),
      "the message is kept in the thread, marked not sent",
    )
    assert.equal(
      find('[data-unsent] [data-slot="bubble-content"]')?.textContent,
      "Will this go?",
      "and is still drawn where it was sent, in its own bubble",
    )
    assert.equal(composerField()?.value, "", "the words are not handed back to the field")
    assert.ok(find('[data-unsent] button[aria-label="Cancel failed message"]'), "it can be taken back")
    assert.ok(
      findAll('[data-unsent] button').some((one) => one.textContent?.includes("Retry")),
      "and sent again from where it stands",
    )
    assert.equal((await db.conversations.get("c-refused"))?.modelChoice, undefined)
  })
})

/** The header's own line, as the app draws it. */
const headerLine = () => find('[data-slot="header-line"]')?.textContent ?? ""

/** Every request fails, as a host that cannot be reached does, until the returned call puts it back. */
function hostDown() {
  const answer = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch")
  }) as typeof fetch
  return () => {
    globalThis.fetch = answer
  }
}

test("a host that isn't answering is the header's word, and the composer stays", async () => {
  await onChatNext("c-away")
  const up = hostDown()
  try {
    await mount(chatScreen("c-away"), async () => {
      await until(() => headerLine() === "This host isn't answering", "the header to name the host")
      assert.ok(find('textarea[aria-label="Message"]'), "the composer is still drawn")
      assert.equal(find('[data-chat-next] [data-away]'), null, "and no notice in the thread")
      assert.equal(find('[data-chat-next] [role="alert"]'), null, "nor a banner about the host")

      Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false })
      await act(async () => void window.dispatchEvent(new Event("offline")))
      await until(() => headerLine() === "You're offline", "the header to name the device")
    })
  } finally {
    up()
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true })
  }
})

test("the away words go on their own once the host answers, with no reopen to force the read", async () => {
  await onChatNext("c-back")
  const up = hostDown()
  try {
    await mount(chatScreen("c-back"), async () => {
      await until(() => headerLine() === "This host isn't answering", "the header to name the host")
      up()
      // No nudge here: the page's own next read takes the words back. This harness has no stream
      // open, so `test-away.mjs` is what pins the five-minute branch behind one.
      await until(
        () => headerLine() !== "This host isn't answering",
        "the header to stop naming a host that has answered",
      )
    })
  } finally {
    up()
  }
})

/** Fails the transcript read alone, as a host answering everything but `/messages` does. */
function transcriptDown() {
  const answer = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (/\/messages(\?|$)/.test(String(input))) throw new TypeError("Failed to fetch")
    return answer(input, init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = answer
  }
}

/**
 * A chat following a run whose transcript read has just missed, which is the state the away words
 * have to leave from. `run` gets the host and the call that puts the transcript read back.
 */
async function whileAwayFollowing(
  id: string,
  run: (host: ReturnType<typeof fakeHost>, restore: () => void) => Promise<void>,
) {
  const { host } = await onChatNext(id)
  await mount(chatScreen(id), async () => {
    await sendFromComposer("Count to a million")
    await until(() => host.asked.runs === 1, "the run started")
    const up = transcriptDown()
    try {
      // The run keeps streaming; a read the page makes anyway is the one that goes away.
      await act(async () => void document.dispatchEvent(new Event("visibilitychange")))
      await until(() => headerLine() === "This host isn't answering", "the header to name the host")
      await run(host, up)
    } finally {
      up()
    }
  })
}

test("a run's own events take the away words back while the transcript read still misses", async () => {
  await whileAwayFollowing("c-run-events", async (host) => {
    host.latest.run!.say("Here.")
    await until(
      () => headerLine() !== "This host isn't answering",
      "the run's own event to take the words back, with the transcript read still failing",
    )
  })
})

test("an away page still reads the transcript while it follows a run that says nothing", async () => {
  await whileAwayFollowing("c-run-quiet", async (_host, restore) => {
    // The host answers again and the run stays silent, so only a read can say the host is back.
    restore()
    await until(
      () => headerLine() !== "This host isn't answering",
      "the page to read the transcript while it follows a silent run",
    )
  })
})

test("a turn sent from chat-next retires the chat's saved draft", async () => {
  const { host } = await onChatNext("c-draft-retired")
  await db.conversations.update("c-draft-retired", { draftAt: 4, draftText: "half a thought" })
  await mount(chatScreen("c-draft-retired"), async () => {
    await sendFromComposer("Send this instead")
    await until(() => host.asked.runs === 1, "the turn started")
    await until(
      async () => (await db.conversations.get("c-draft-retired"))?.draftText === undefined,
      "the saved draft to be retired",
    )
    const held = await db.conversations.get("c-draft-retired")
    assert.equal(held?.draftAt, undefined, "the mark is gone")
    assert.equal(held?.draftText, undefined, "and the text with it, on every send path")
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
    // Past the settle window: the press is answered until a quiet reading has had time to be contradicted.
    await until(() => Boolean(find('button[aria-label="Send"]')), "and Send comes back", 10_000)
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
    await sendPress()
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
    await sendPress()
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
    await sendPress()
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
    await sendPress()
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

test("a code session reads what is said in it in JetBrains Mono, and none of the chrome", async () => {
  const host = await sessionOnChatNext("c-mono")
  host.seed([{ user: "Look around", reply: "Found it.", tools: 1 }])
  await mount(chatScreen("c-mono"), async () => {
    await until(() => replies().length > 0, "the turn is drawn")
    const pane = find("[data-chat-next]")
    assert.equal(pane?.classList.contains("font-code"), false, "the pane is not in the face")
    assert.equal(inCodeFace(find('[data-slot="header-row"]'), "the header"), false, "the header")
    assert.ok(inCodeFace(composerField(), "the composer"), "the composer's text")
    assert.ok(
      inCodeFace(find('[data-chat-next] [data-slot="bubble-content"]'), "the user's bubble"),
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
})

test("a chat with a bot keeps the app's face, except a tool call's input and output", async () => {
  const { host } = await onChatNext("c-sans")
  host.seed([{ user: "Look around", reply: "Found it.", tools: 1 }])
  await mount(chatScreen("c-sans"), async () => {
    await until(() => replies().length > 0, "the turn is drawn")
    assert.equal(inCodeFace(composerField(), "the composer"), false, "the composer")
    assert.equal(
      inCodeFace(find('[data-chat-next] [data-slot="bubble-content"]'), "the user's bubble"),
      false,
      "the user's bubble",
    )
    assert.equal(
      inCodeFace(find('[data-chat-next] [data-slot="markdown"]'), "the reply"),
      false,
      "the reply's words",
    )
    const row = find('[data-chat-next] [data-slot="tool-group"]')
    assert.equal(row?.querySelector(".font-code") ?? null, null, "the tool call's row label")
    await click(row)
    await click(findAll("ol button")[0] ?? null)
    assert.ok(inCodeFace(find("pre"), "the call's output"), "the call's input or output")
  })
})

test("a chat this device holds nothing of loads under one loader mid-screen, not words", async () => {
  const { host } = await onChatNext("c-fresh")
  host.seed([{ user: "Look around", reply: "Found it.", tools: 0 }])
  const first = host.hold(0)
  await mount(chatScreen("c-fresh"), async () => {
    await until(() => Boolean(find("[data-loading-fresh]")), "the first read has the one loader")
    assert.equal(
      find('[data-slot="status-line"]'),
      null,
      "and no line of the thread speaks for it",
    )
    first.release()
    await until(() => replies().length > 0, "the chat arrives")
    assert.equal(find("[data-loading-fresh]"), null, "the loader goes with the rows")
  })
})

test("a chat this device already holds opens as a thread, with the host's answer landing behind it", async () => {
  const { host } = await onChatNext("c-held")
  const opener = { user: "Look around", reply: "Found it.", tools: 0 }
  host.seed([opener])
  await mount(chatScreen("c-held"), async () => {
    await until(() => replies().length > 0, "the chat is held")
  })
  // A turn the host wrote since this device last read it: the open's read is what brings it.
  host.seed([{ user: "And again", reply: "Still here.", tools: 0 }])
  const read = host.offsets.length
  const second = host.hold(0)
  await mount(chatScreen("c-held"), async () => {
    await until(() => host.offsets.length > read, "the newest page is asked for")
    assert.ok(replies().includes("Found it."), "the thread is drawn before the host answers")
    assert.equal(find("[data-loading-fresh]"), null, "no loader mid-screen")
    assert.equal(
      find('[data-slot="status-line"]'),
      null,
      "and no line says the thread is still being read",
    )
    second.release()
    await until(() => replies().includes("Still here."), "the host's turn to land behind it")
    assert.ok(replies().includes("Found it."), "over the rows the device already had")
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

test("a stop the host refused still leaves Stop for the run it could not stop", async () => {
  // A refusal is not a stop: the run is still live on the host, so the button that comes back has to
  // be Stop rather than Send, which would post a message into a running turn.
  const { host } = await onChatNext("c-stop-refused", {}, { plugin: true, host: { refuseStops: true } })
  await mount(chatScreen("c-stop-refused"), async () => {
    await sendFromComposer("Keep going")
    await until(() => host.asked.runs === 1, "the turn is running")
    await until(() => Boolean(find('button[aria-label="Stop"]')), "the composer offers Stop")
    await click(find('button[aria-label="Stop"]'))
    await until(() => host.asked.stops === 1, "the host refused the stop")
    await until(
      () => Boolean(find('button[aria-label="Stop"]')),
      "the run the host still holds is Stoppable again",
    )
    assert.equal(find('button[aria-label="Send"]'), null, "and Send is not offered over a live run")
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
    // The same tap as every other screen's: the one Previewer this screen mounts, not a tab.
    await click(find('[data-chat-next] [aria-label="Open chart.png"]'))
    await until(
      () => Boolean(document.querySelector('[role="dialog"] img[alt="chart.png"]')),
      "a tap opens the app's own Previewer, on the screen behind the switch too",
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

test("a press asks the plugin what it still holds, even before this device has read a child", async () => {
  // The other half of the repeated tap: a child dispatched seconds ago is not in the list yet, so a
  // press that stopped only the children it could name left one running — and needed pressing again.
  const { host } = await onChatNext("c-stop-none", {}, { plugin: true })
  await mount(chatScreen("c-stop-none"), async () => {
    await sendFromComposer("Just a turn")
    await until(() => host.asked.runs === 1, "the turn is running")
    await until(() => host.asked.info > 0, "the plugin has said what it can do")
    await until(() => Boolean(find('button[aria-label="Stop"]')), "the composer offers Stop")
    await click(find('button[aria-label="Stop"]'))
    await until(() => host.asked.agentStops === 1, "the host was asked what it still has at work")
  })
})

test("a press with no run to stop yet hands Stop back for the run that lands", async () => {
  // The window between Send and the run id it names: the press has no run to stop, and the run that
  // lands a moment later is not the one it asked about — so the button must come back to Stop rather
  // than sit as a Stopping that refuses the press meant for the new turn.
  const { host } = await onChatNext("c-stop-early", {}, { plugin: true })
  await mount(chatScreen("c-stop-early"), async () => {
    const post = host.holdRuns()
    await sendFromComposer("Start something")
    await until(() => Boolean(find('button[aria-label="Stop"]')), "the composer offers Stop")
    await click(find('button[aria-label="Stop"]'))
    await settle()
    // The host answered that it had nothing to stop, so nothing is acknowledged and the button is
    // still the reader's: the run that lands a moment later is the one the next press stops.
    assert.ok(find('button[aria-label="Stop"]'), "a press that stopped nothing is not acknowledged")
    post.release()
    await until(() => host.asked.runs === 1, "the run lands")
    await until(() => Boolean(find('button[aria-label="Stop"]')), "and Stop is the press again")
    await click(find('button[aria-label="Stop"]'))
    await until(() => host.asked.stops === 1, "the turn that landed is the one it stops")
  })
})

test("a stop is answered on the spot, so a press still unwinding is not pressed again", async () => {
  // The report: Stop tapped three times because nothing happened for a second. A subagent's stop is
  // cooperative, so the child keeps working for a moment after the press: the composer says it is
  // stopping, asks for nothing more while it does, and hands Send back once the child has ended.
  const { host } = await onChatNext(
    "c-stop-asked",
    {},
    { plugin: true, host: { cooperative: true } },
  )
  await mount(chatScreen("c-stop-asked"), async () => {
    await sendFromComposer("Fan out")
    await until(() => host.asked.runs === 1, "the turn is running")
    host.latest.run!.delegate("look into it")
    await until(() => host.asked.info > 0, "the plugin has said what it can do")
    await until(() => Boolean(find('button[aria-label="Stop"]')), "the composer offers Stop")
    await click(find('button[aria-label="Stop"]'))
    await until(() => host.asked.agentStops === 1, "the host was asked to stop the child")
    await until(() => Boolean(find('button[aria-label="Stopping"]')), "the press is answered")
    assert.equal(
      (find('button[aria-label="Stopping"]') as HTMLButtonElement).disabled,
      false,
      "and stays focusable, so a keyboard reader keeps their place and hears the new label",
    )
    await click(find('button[aria-label="Stopping"]'))
    await settle()
    assert.equal(host.asked.stops, 1, "a second tap is not a second stop")
    assert.equal(host.asked.agentStops, 1, "nor a second stop of the session's children")
    host.endAgents()
    // The quiet has to hold for one read of the children before it is believed (STOP_SETTLED_MS), so
    // this waits past that window rather than the helper's default five seconds.
    await until(
      () => Boolean(find('button[aria-label="Send"]')),
      "Send returns once it has ended",
      10_000,
    )
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
  await db.sentFiles.put({ session: "gots-c-options", path: "/h/a.png", blob: new Blob(["x"]) })
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
  // The host's clock, in the gap between the first turn and the second: that gap is the only place a
  // divider stands, since one with nothing drawn above or below it is drawn nowhere.
  const second = host.rows.find((row) => row.content === "Second")!
  await db.conversations.update("c-dividers", {
    compactions: [{ at: (second.timestamp - 0.5) * 1000, tokens: 168_000, window: 200_000 }],
  })
  await mount(chatScreen("c-dividers"), async () => {
    await until(() => replies().length === 2, "both turns are drawn")
    await until(
      () => Boolean(find('[role="separator"][aria-label="Compaction · 168k of 200k (84%)"]')),
      "the compaction's divider, with how full the context was",
    )
  })
})

test("a chat the host compacted with nothing at the seam still offers its archive", async () => {
  const { host } = await onChatNext("c-rowless")
  host.seed([
    { user: "First", reply: "One." },
    { user: "Second", reply: "Two." },
    { user: "Third", reply: "Three." },
  ])
  // Hermes archived the older turns and wrote nothing where the summary went.
  host.compact({ keep: 1, hidden: false })
  await db.conversations.update("c-rowless", {
    compactions: [{ at: Date.now(), tokens: 168_000, window: 200_000 }],
  })
  await mount(chatScreen("c-rowless"), async () => {
    await until(() => replies().length === 1, "the window the compaction left")
    const offer = find("[data-earlier]")
    assert.ok(offer, "the archive is offered over it")
    await click(offer)
    await until(() => replies().length === 3, "every turn the compaction archived")
  })
})

test("an archive the host cannot give retires the offer rather than saying it loaded", async () => {
  await onChatNext("c-lost-session")
  // The chat's record says a compaction ran and the host still holds the session, but nothing in it:
  // both reads are answered with the host's own word for a session it has no rows for.
  await db.conversations.update("c-lost-session", {
    compactions: [{ at: Date.now(), tokens: 168_000, window: 200_000 }],
  })
  await mount(chatScreen("c-lost-session"), async () => {
    await until(() => Boolean(find("[data-earlier]")), "the offer over the window")
    await click(find("[data-earlier]")!)
    await until(() => !find("[data-earlier]"), "the offer to go when the host gave nothing")
    const record = await db.sessionStates.get("gots-c-lost-session")
    assert.ok(!record?.archived, "no archive is recorded that the host never gave")
  })
})

test("a compaction mid-run draws its divider between the calls it fell between", async () => {
  const { host } = await onChatNext("c-mid-run")
  await mount(chatScreen("c-mid-run"), async () => {
    const run = await midReply(host, "go")
    run.tool("terminal", "one", '{"exit_code": 0}')
    host.compact()
    run.tool("terminal", "two", '{"exit_code": 0}')
    run.say("\n\nLanded")
    run.finish("Landed")
    await until(
      () => findAll('[data-chat-next] [role="separator"]').length === 1,
      "the compaction's one divider",
    )
    const marks = findAll(
      '[data-chat-next] [data-slot="tool-group"], [data-chat-next] [role="separator"]',
    ).map((one) => (one.getAttribute("role") === "separator" ? "divider" : "call"))
    assert.deepEqual(
      marks,
      ["call", "divider", "call"],
      "between the call before it and the one after",
    )
    assert.match(
      findAll('[data-chat-next] [role="separator"]')[0]?.getAttribute("aria-label") ?? "",
      /^Compaction/,
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

test("Retry re-asks the element a failed request pointed at", async () => {
  const { host } = await onChatNext("c-retry-point", {}, { plugin: true })
  const total = { label: "The total", selector: "#total" }
  host.seed([
    {
      user: pointText("Make this bolder", [total]),
      reply: "",
      failed: "Your request was not processed.",
    },
  ])
  await mount(chatScreen("c-retry-point"), async () => {
    await until(() => Boolean(find("[data-retry]")), "the failed turn offers Retry")
    assert.equal(
      find('[data-chat-next] [data-message-id$="-u"] [data-point-chip]')?.textContent,
      total.label,
      "the request that failed draws its point on the bubble",
    )
    await click(find("[data-retry]"))
    await until(() => host.asked.runs === 1, "the request is sent again")
    const sent = String(JSON.stringify(host.latest.body))
    assert.ok(sent.includes(RETRY_OPEN), "the message carries the retry's opening marker")
    assert.ok(sent.includes(pointLine(total)), "and the point the request was made with")
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

test("Retry re-asks the request under its own marker, and deletes none of the failed turn", async () => {
  const { host } = await onChatNext("c-retry", {}, { plugin: true })
  host.seed([
    { user: "Look around", reply: "", tools: 2, failed: "Your request was not processed." },
  ])
  const calls = () => findAll('[data-chat-next] [data-slot="tool-group"]').length
  await mount(chatScreen("c-retry"), async () => {
    await until(() => Boolean(find("[data-retry]")), "the failed turn offers Retry")
    assert.equal(calls(), 1, "the failed run's calls are drawn")
    await click(find("[data-retry]"))
    assert.equal(calls(), 1, "the failed run's calls stay as the retry goes")
    assert.deepEqual(requests(), ["Look around"], "and its request stays the only one drawn")
    assert.ok(text().includes("Your request was not processed."), "with the host's words")
    await until(() => host.asked.runs === 1, "the request is sent again")
    const sent = String(JSON.stringify(host.latest.body))
    assert.ok(sent.includes(RETRY_OPEN), "the message carries the retry's opening marker")
    assert.ok(sent.includes("Look around"), "and the request it asks again")
    assert.equal(host.asked.failedTurnClears, 0, "Retry asked the host to delete nothing")
    assert.ok(
      host.rows.some((row) => row.display_kind === "failed_turn"),
      "the host still holds the failed turn",
    )
    host.latest.run!.say("Looking.")
    host.latest.run!.finish("Looking.")
    await until(() => replies().includes("Looking."), "the second try answers")
    assert.deepEqual(requests(), ["Look around"], "the request still shows once")
    assert.equal(calls(), 1, "the failed run's calls stay above the answer")
    assert.ok(text().includes("Your request was not processed."), "and the failure with them")
    assert.equal(text().includes("RETRY"), false, "the marker reaches no word of the thread")
    assert.ok(!find("[data-retry]"), "with nothing left to retry")
    assert.ok(
      host.rows.some((row) => row.display_kind === "failed_turn"),
      "and it is still there after the retry answered",
    )
  })
})

test("Retry needs nothing of the plugin: no feature probe, just the send", async () => {
  const { host } = await onChatNext("c-retry-bare", {}, { plugin: false })
  host.seed([{ user: "Look around", reply: "", failed: "Your request was not processed." }])
  await mount(chatScreen("c-retry-bare"), async () => {
    await until(() => Boolean(find("[data-retry]")), "the failed turn offers Retry")
    const probes = host.asked.info
    await click(find("[data-retry]"))
    await until(() => host.asked.runs === 1, "the request is sent again")
    assert.equal(host.asked.info, probes, "Retry asked the plugin nothing")
    assert.equal(host.asked.failedTurnClears, 0, "and asked the host to delete nothing")
    host.latest.run!.finish("Looking.")
    await until(() => replies().includes("Looking."), "the second try answers")
    assert.deepEqual(requests(), ["Look around"], "the request still shows once")
    assert.ok(text().includes("Your request was not processed."), "and the failure with them")
  })
})

test("a retry that fails again is asked again, with the same request and one set of markers", async () => {
  const { host } = await onChatNext("c-retry-twice", {}, { plugin: true })
  host.seed([{ user: "Look around", reply: "", failed: "Your request was not processed." }])
  await mount(chatScreen("c-retry-twice"), async () => {
    await until(() => Boolean(find("[data-retry]")), "the failed turn offers Retry")
    await click(find("[data-retry]"))
    await until(() => host.asked.runs === 1, "the request is sent again")
    host.latest.run!.fail("Your request was not processed.")
    await until(
      () => findAll("[data-retry]").length === 1 && host.asked.runs === 1,
      "the second try fails too, and offers Retry in its turn",
    )
    await click(find("[data-retry]"))
    await until(() => host.asked.runs === 2, "the retry is asked again")
    const sent = String(JSON.stringify(host.latest.body))
    assert.equal(sent.split(RETRY_OPEN).length - 1, 1, "one opening marker, never a nested retry")
    assert.ok(sent.includes("Look around"), "asking the same request")
    assert.deepEqual(requests(), ["Look around"], "and the thread still draws the request once")
    host.latest.run!.finish("Looking.")
    await until(() => replies().includes("Looking."), "the third try answers")
    assert.deepEqual(requests(), ["Look around"], "with the request still drawn once")
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
    const kept = (await db.sessionStates.get("gots-c-stats"))?.stats
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

test("a file this device sent opens a tab at the URL the host signs for it", async () => {
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
  const browser = spyOpen()
  try {
    await mount(chatScreen("c-held"), async () => {
      const row = () =>
        findAll("button").find(
          (one) => one.getAttribute("aria-label") === `Download ${file.name}`,
        ) ?? null
      await until(() => row() !== null, "the file's row")
      await click(row())
      await until(async () => browser.opened.length > 0, "the tab")
      assert.match(
        browser.opened[0],
        /\/media\?path=.*token=/,
        "at the URL the host signed for the file",
      )
    })
  } finally {
    browser.restore()
  }
})
