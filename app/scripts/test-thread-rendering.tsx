/**
 * One thread rendering, over the chat screen: a chat, a coding session and a delegated agent's
 * sub-thread all draw a turn the same way — the agent's reply on the page with no bubble and no
 * picture, the user's own message in its bubble — so the screen carries no branch on what kind of
 * conversation it is showing.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { AgentCards } from "@/components/chat/agent-card"
import { AgentsContext, DELEGATE_TOOL } from "@/lib/agents"
import { db, type Message, type Profile } from "@/lib/db"
import type { HermesConfig } from "@/lib/hermes"
import { ChatPage } from "@/routes/chat"
import { click, connection, findAll, json, mount, seedSettings, settle } from "./component-kit.tsx"

const server: HermesConfig = connection("thread")

const bot: Profile = {
  id: "bot-1",
  name: "Threads",
  baseUrl: server.baseUrl,
  apiKey: server.apiKey,
  model: "test/model",
  botId: "bot-1",
  createdAt: 1,
  updatedAt: 1,
}

const ASK = "Where does the parser read a reply?"
const REPLY = [
  "## The parser",
  "",
  "A reply is read in `parse.ts`, then kept as blocks.",
  "",
  "> Its tests run on the device.",
  "",
  "```ts",
  "const blocks = markdownBlocks(text)",
  "```",
].join("\n")

const turn = (): Message[] => [
  {
    id: "ask",
    conversationId: "",
    role: "user",
    content: ASK,
    status: "done",
    createdAt: 1,
  },
  {
    id: "reply",
    conversationId: "",
    role: "assistant",
    content: REPLY,
    status: "done",
    createdAt: 2,
  },
]

function host(transcript: unknown[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (/\/api\/sessions\/[^/]+\/messages$/.test(url.pathname)) return json({ data: transcript })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

async function screen(
  projectId: string | undefined,
  messages: Message[],
  body: () => Promise<void>,
) {
  await seedSettings()
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  const id = projectId ? "session-1" : "chat-1"
  await db.conversations.put({
    id,
    profileId: bot.id,
    title: projectId ? "A session" : "A chat",
    hermesSessionId: `${id}-hermes`,
    projectId,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
  await db.messages.bulkPut(messages.map((message) => ({ ...message, conversationId: id })))
  await mount(
    <MemoryRouter initialEntries={[`/c/${id}`]}>
      <Routes>
        <Route path="/c/:id" element={<ChatPage />} />
      </Routes>
    </MemoryRouter>,
    body,
  )
}

const rows = () => findAll("[data-slot=message]")

const drawn = () => rows().map((row) => row.outerHTML)

const bubble = (row: Element) => row.querySelector("[data-slot=bubble]")

const replyRow = (needle = "The parser") =>
  rows().find(
    (row) => row.getAttribute("data-align") === "start" && row.textContent?.includes(needle),
  )

async function rendered() {
  await import("@/components/chat/markdown-renderer")
  await settle()
  assert.ok(replyRow()?.querySelector("div[data-md-code]"), "the agent's markdown drew")
}

const askRow = () =>
  rows().find((row) => row.getAttribute("data-align") === "end" && row.textContent?.includes(ASK))

test("a chat and a coding session draw one thread", async () => {
  host()
  let chat: string[] = []
  await screen(undefined, turn(), async () => {
    await rendered()
    chat = drawn()
  })
  let session: string[] = []
  await screen("project-1", turn(), async () => {
    await rendered()
    session = drawn()
  })
  assert.equal(chat.length, 2, "the chat draws both turns")
  assert.deepEqual(session, chat, "and the session's thread is the same markup, not a variant")
})

test("the agent's reply sits on the page, with no bubble and no picture", async () => {
  host()
  const reply = "I read the parser first.\n\nThen I kept its blocks."
  const messages: Message[] = [
    {
      id: "ask",
      conversationId: "",
      role: "user",
      content: ASK,
      status: "done",
      createdAt: 1,
    },
    {
      id: "reply",
      conversationId: "",
      role: "assistant",
      content: reply,
      status: "done",
      createdAt: 2,
      tools: [
        {
          toolCallId: "call-1",
          tool: "read_file",
          label: "parse.ts",
          status: "completed",
          startedAt: 1_500,
          contentOffset: reply.indexOf("Then"),
        },
      ],
    },
  ]
  await screen(undefined, messages, async () => {
    const row = replyRow("I read the parser")
    assert.ok(row, "the reply is a row of the thread")
    assert.equal(bubble(row), null, "with no bubble")
    assert.equal(row.querySelector("[role=img]"), null, "and no picture beside it")
    assert.equal(row.querySelector('img[src^="/bots/"]'), null, "nothing drawn of the bot at all")
    assert.match(row.textContent ?? "", /I read the parser first\./, "its first segment")
    assert.match(row.textContent ?? "", /Then I kept its blocks\./, "and its last")
  })
})

test("the user's own message keeps its bubble, right-aligned", async () => {
  host()
  await screen("project-1", turn(), async () => {
    const ask = askRow()
    assert.ok(ask, "the message is a row of the thread")
    const asked = bubble(ask)
    assert.ok(asked, "wearing a bubble")
    assert.equal(asked?.getAttribute("data-align"), "end", "right-aligned")
    assert.equal(asked?.className.includes("opacity-60"), false, "at full strength once it went")
  })
})

test("a message that has not gone through keeps its dimmed bubble", async () => {
  host()
  const held: Message[] = [
    ...turn(),
    {
      id: "queued",
      conversationId: "",
      role: "user",
      content: "And the queue?",
      status: "queued",
      createdAt: 3,
    },
    {
      id: "failed",
      conversationId: "",
      role: "user",
      content: "And the retry?",
      status: "error",
      statusText: "Couldn't reach Hermes.",
      createdAt: 4,
    },
  ]
  await screen(undefined, held, async () => {
    for (const word of ["And the queue?", "And the retry?"]) {
      const row = rows().find((one) => one.textContent?.includes(word))
      const frame = row && bubble(row)
      assert.ok(frame, `${word} keeps its bubble`)
      assert.equal(frame?.getAttribute("data-align"), "end", "right-aligned")
      assert.match(frame?.className ?? "", /opacity-60/, "and dimmed, as a message not through yet")
    }
  })
})

test("a reply's code and quotes read on the page", async () => {
  host()
  await screen(undefined, turn(), async () => {
    await rendered()
    const reply = replyRow()
    assert.ok(reply)
    const block = reply.querySelector("div[data-md-code]")
    assert.ok(block, "the code keeps its own block")
    assert.equal(block?.closest("[data-slot=bubble]"), null, "which is on the page, not in a bubble")
    assert.match(block?.className ?? "", /bg-muted/, "and the surface it takes on the page")
    assert.match(reply.querySelector("code[data-md-code]")?.className ?? "", /bg-muted/, "the same inline")
    assert.ok(reply.querySelector("blockquote"), "the quote keeps its treatment")
  })
})

test("a delegated agent's sub-thread draws the same thread", async () => {
  const goal = "Review the parser for the reader"
  host([
    { id: 1, role: "user", content: ASK, timestamp: 1 },
    { id: 2, role: "assistant", content: REPLY, timestamp: 2 },
  ])
  const tool = {
    toolCallId: "call-1",
    tool: DELEGATE_TOOL,
    label: goal,
    status: "completed" as const,
    startedAt: 1_000,
    endedAt: 2_000,
  }
  let chat: string[] = []
  await screen(undefined, turn(), async () => {
    await rendered()
    chat = drawn()
  })
  await mount(
    <AgentsContext.Provider
      value={{
        agents: [
          {
            id: "agent-1",
            goal,
            model: "test/model",
            startedAt: 1,
            endedAt: 2,
            toolCalls: 1,
            status: "done",
          },
        ],
        server,
      }}
    >
      <AgentCards tool={tool} live={false} />
    </AgentsContext.Provider>,
    async () => {
      const card = document.querySelector("button")
      assert.ok(card, "the delegation is a card in the thread")
      await click(card)
      await rendered()
      const sub = drawn()
      assert.equal(sub.length, 2, "the agent's own turns, read from its transcript")
      assert.deepEqual(sub, chat, "drawn exactly as the chat draws them")
    },
  )
})
