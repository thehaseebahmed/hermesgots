/**
 * *Show progress reminders*: the Developer switch that draws a progress reminder a thread would hide,
 * on both chat screens, where the refused call was, opening the note the host wrote — and nothing at
 * all with the switch off (ADR 0068).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { streamHandlers, type Turn } from "@/lib/chat"
import { db, type Message } from "@/lib/db"
import type { SessionMessage } from "@/lib/hermes"
import { DeveloperSettings } from "@/routes/settings"
import {
  botProfile,
  chatScreen,
  click,
  connection,
  find,
  findAll,
  mount,
  seedChats,
  seedSettings,
  serveTranscript,
  settle,
  until,
} from "./component-kit.tsx"
import { NOTE, stored } from "./progress-reminder-fixture.ts"

const UPDATE = "Halfway: the parser reads end to end, and the tests come next."

/** The transcript the host served when a reminder refused the first read, then the model repeated it. */
const transcript = (): SessionMessage[] => [
  { id: 1, role: "user", content: "Read the parser", timestamp: 1 },
  {
    id: 2,
    role: "assistant",
    content: null,
    timestamp: 2,
    tool_calls: [
      {
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      },
    ],
  },
  { id: 3, role: "tool", content: stored(NOTE), tool_call_id: "call-1", timestamp: 3 },
  {
    id: 4,
    role: "assistant",
    content: UPDATE,
    timestamp: 4,
    tool_calls: [
      {
        id: "call-2",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      },
    ],
  },
  { id: 5, role: "tool", content: "export const a = 1", tool_call_id: "call-2", timestamp: 5 },
]

const noteOf = () =>
  document.querySelector('[data-slot="progress-reminder-note"]')?.textContent ?? ""

const groupLabel = () =>
  (findAll('[data-slot="tool-group"]').at(-1)?.getAttribute("aria-label") ?? "").trim()

const standsBeforeTheGroup = () => {
  const reminder = findAll('[data-slot="progress-reminder"]').at(-1)
  const group = findAll('[data-slot="tool-group"]').at(-1)
  assert.ok(reminder, "the reminder row is on screen")
  assert.ok(group, "the run beside it is on screen")
  return Boolean(reminder.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING)
}

const checkedOf = (element: Element | null) => {
  assert.ok(element, "the switch is on screen")
  return element.getAttribute("aria-checked") === "true"
}

test("the Developer switch is off until it is turned on, keeps the pick, and asks no host", async () => {
  await seedSettings({ developer: true })
  const asked: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(String(input))
    return new Response(JSON.stringify({}), { status: 200 })
  }) as typeof fetch
  // The switch root sits inside Base UI's label: the bare id belongs to a clipped hidden input.
  const row = () => find("#show-progress-reminders-label [data-slot='switch']")
  await mount(<DeveloperSettings />, async () => {
    assert.equal(checkedOf(row()), false, "off until it is turned on")
    await click(row())
    assert.equal(checkedOf(row()), true, "and on once it is")
  })
  assert.deepEqual(asked, [], "the switch is the device's: nothing was asked of a host")
  assert.equal(
    (await db.settings.get("settings"))?.showProgressReminders,
    true,
    "the device kept it",
  )
  await mount(<DeveloperSettings />, async () => {
    assert.equal(checkedOf(row()), true, "a fresh read of the device finds it on")
  })
})

test("with it on, the current chat screen draws the row where the call was and opens the note", async () => {
  await seedChats([{ id: "c-reminder", title: "Sky colours" }], {
    bots: [botProfile("hermes")],
    settings: { showProgressReminders: true },
  })
  // A chat that moved since it was made catches its transcript up when it opens.
  await db.conversations.update("c-reminder", { updatedAt: 99 })
  serveTranscript(transcript())
  await mount(chatScreen("c-reminder"), async () => {
    await until(
      async () => Boolean(find('[data-slot="progress-reminder"]')),
      "the reminder row is drawn",
    )
    assert.equal(
      findAll('[data-slot="progress-reminder"]').length,
      1,
      "one row for the one refusal",
    )
    assert.ok(standsBeforeTheGroup(), "it stands where the refused call was")
    assert.equal(groupLabel(), "Read a file", "the group counts only the call that ran")
    await click(find('[data-slot="progress-reminder"]'))
    assert.equal(noteOf(), NOTE, "the sheet opens the note exactly as the host wrote it")
    assert.match(noteOf(), /^Progress reminder:/, "its pinned opening first")
  })
})

test("the row survives a reopen, drawn from the transcript the host still serves", async () => {
  await seedChats([{ id: "c-reload", title: "Sky colours" }], {
    bots: [botProfile("hermes")],
    settings: { showProgressReminders: true },
  })
  await db.conversations.update("c-reload", { updatedAt: 99 })
  serveTranscript(transcript())
  await mount(chatScreen("c-reload"), async () => {
    await until(
      async () => Boolean(find('[data-slot="progress-reminder"]')),
      "the reminder row is drawn",
    )
  })
  await settle()
  await mount(chatScreen("c-reload"), async () => {
    await until(
      async () => Boolean(find('[data-slot="progress-reminder"]')),
      "the reminder row is drawn again",
    )
    await click(find('[data-slot="progress-reminder"]'))
    assert.equal(noteOf(), NOTE, "the same note, from what the device folded")
  })
})

test("with it off, the current chat screen draws nothing new", async () => {
  await seedChats([{ id: "c-hidden", title: "Sky colours" }], { bots: [botProfile("hermes")] })
  await db.conversations.update("c-hidden", { updatedAt: 99 })
  serveTranscript(transcript())
  await mount(chatScreen("c-hidden"), async () => {
    await until(async () => Boolean(find('[data-slot="tool-group"]')), "the reply is drawn")
    assert.equal(findAll('[data-slot="progress-reminder"]').length, 0, "no row is drawn")
    assert.equal(groupLabel(), "Read a file", "and the group is exactly as it was")
  })
})

test("a reply already folded with the row draws nothing once the switch is off", async () => {
  await seedChats([{ id: "c-gate", title: "Sky colours" }], { bots: [botProfile("hermes")] })
  await db.messages.bulkPut([
    {
      id: "c-gate-u",
      conversationId: "c-gate",
      role: "user",
      content: "Read the parser",
      status: "done",
      createdAt: 10,
    },
    {
      id: "c-gate-a",
      conversationId: "c-gate",
      role: "assistant",
      content: UPDATE,
      // What a fold with the switch on kept: the renderer, not a migration, is what hides it.
      reminders: [{ note: NOTE, contentOffset: 0, toolsBefore: 0 }],
      status: "done",
      createdAt: 11,
    },
  ])
  await mount(chatScreen("c-gate"), async () => {
    await until(async () => Boolean(find('[data-slot="markdown"]')), "the reply is drawn")
    assert.equal(findAll('[data-slot="progress-reminder"]').length, 0, "the switch off draws none")
  })
})

test("a reply the live stream folded draws the row and the note over a seeded device", async () => {
  await seedChats([{ id: "c-live", title: "Sky colours" }], {
    bots: [botProfile("hermes")],
    settings: { showProgressReminders: true },
  })
  const draft: Message = {
    id: "c-live-a",
    conversationId: "c-live",
    role: "assistant",
    content: "",
    tools: [],
    status: "streaming",
    createdAt: 12,
  }
  const turn: Turn = {
    conversationId: "c-live",
    config: connection("progress-live"),
    draft,
    controller: new AbortController(),
    touch: () => {},
    firstTokenAt: null,
    resumed: true,
    close: async () => {},
  }
  const onTool = streamHandlers(turn).onTool!
  onTool({ tool: "read_file", status: "running", toolCallId: "live:1" })
  onTool({ tool: "read_file", status: "failed", result: stored(NOTE) })
  await settle()
  draft.status = "done"
  await db.messages.bulkPut([
    {
      id: "c-live-u",
      conversationId: "c-live",
      role: "user",
      content: "Read the parser",
      status: "done",
      createdAt: 11,
    },
    draft,
  ])
  await mount(chatScreen("c-live"), async () => {
    await until(
      async () => Boolean(find('[data-slot="progress-reminder"]')),
      "the live reply's row is drawn",
    )
    assert.equal(findAll('[data-slot="tool-group"]').length, 0, "the only call never ran")
    await click(find('[data-slot="progress-reminder"]'))
    assert.equal(noteOf(), NOTE, "the sheet opens the note the stream carried")
  })
})

test("with it on and no reminder in the turn, nothing extra is drawn", async () => {
  await seedChats([{ id: "c-quiet", title: "Sky colours" }], {
    bots: [botProfile("hermes")],
    settings: { showProgressReminders: true },
  })
  await db.conversations.update("c-quiet", { updatedAt: 99 })
  serveTranscript([
    { id: 1, role: "user", content: "Read the parser", timestamp: 1 },
    {
      id: 2,
      role: "assistant",
      content: null,
      timestamp: 2,
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ],
    },
    { id: 3, role: "tool", content: "export const a = 1", tool_call_id: "call-1", timestamp: 3 },
    { id: 4, role: "assistant", content: "Done.", timestamp: 4, finish_reason: "stop" },
  ])
  await mount(chatScreen("c-quiet"), async () => {
    await until(async () => Boolean(find('[data-slot="tool-group"]')), "the reply is drawn")
    assert.equal(findAll('[data-slot="progress-reminder"]').length, 0, "no row appears")
  })
})

test("with it on, the new chat screen draws the same row and the same sheet", async () => {
  await seedChats([{ id: "c-next-reminder", title: "Sky colours" }], {
    bots: [botProfile("hermes")],
    settings: { chatNext: true, showProgressReminders: true },
  })
  serveTranscript(transcript())
  await mount(chatScreen("c-next-reminder"), async () => {
    await until(async () => Boolean(find("[data-chat-next]")), "the new chat screen is on screen")
    await until(
      async () => Boolean(find('[data-chat-next] [data-slot="progress-reminder"]')),
      "the reminder row is drawn",
    )
    assert.equal(
      findAll('[data-chat-next] [data-slot="progress-reminder"]').length,
      1,
      "one row for the one refusal",
    )
    assert.ok(standsBeforeTheGroup(), "it stands where the refused call was")
    await click(find('[data-slot="progress-reminder"]'))
    assert.equal(noteOf(), NOTE, "the sheet opens the note the host wrote, unmodified")
  })
})

test("with it off, the new chat screen drops the refusal as it does today", async () => {
  await seedChats([{ id: "c-next-hidden", title: "Sky colours" }], {
    bots: [botProfile("hermes")],
    settings: { chatNext: true },
  })
  serveTranscript(transcript())
  await mount(chatScreen("c-next-hidden"), async () => {
    await until(
      async () => Boolean(find('[data-chat-next] [data-slot="tool-group"]')),
      "the reply is drawn",
    )
    assert.equal(
      findAll('[data-chat-next] [data-slot="progress-reminder"]').length,
      0,
      "no row is drawn",
    )
    assert.match(groupLabel(), /^Read /, "the group drew the call that ran, and only it")
  })
})
