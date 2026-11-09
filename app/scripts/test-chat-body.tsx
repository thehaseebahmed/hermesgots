/**
 * The chat body (`chat-next/chat-body.tsx`): one chat's thread, composer, pills and limit context in
 * whatever flex column holds it, with no route param, pane slot or header. Mounted by itself over a
 * seeded chat and its faked host, a send runs a turn and its reply lands in the thread, and what the
 * body wires is held here one seam at a time — the follow-up reads a turn's end makes, a message sent
 * mid-reply going to the plugin's queue or steering, the away word reaching its caller, the limit
 * notice, the pills over the composer and the earlier-messages offer of a compacted chat — since a
 * sheet mounts it without the chat pane's own tests behind it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter } from "react-router"

import { ChatBody, type ChatBodyProps } from "@/chat-next/chat-body"
import { db, type Conversation, type Settings } from "@/lib/db"
import { PreviewerProvider } from "@/components/chat/previewer"
import { limitNotice } from "@/lib/provider-usage"

import { fakeHost } from "./chat-next-host.ts"
import {
  botProfile,
  click,
  composerField,
  find,
  findAll,
  missing,
  mount,
  seedChats,
  sendPress,
  settle,
  type,
} from "./component-kit.tsx"

const bot = botProfile("hermes")
const defaultPick = { provider: "anthropic", model: "claude-sonnet-5-5" }

async function until(check: () => boolean, what: string) {
  const by = Date.now() + 6_000
  while (!check() && Date.now() < by) {
    await settle()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
  }
  assert.ok(check(), what)
}

const replies = () =>
  findAll('[data-slot="message"][data-align="start"] [data-slot="markdown"]').map(
    (one) => one.textContent,
  )

const noLimit: ChatBodyProps["limit"] = {
  usage: { notice: null, provider: undefined, noticeDismissed: false },
  onView: () => {},
}

/**
 * The chat seeded on its own host address (what a plugin offers is remembered per address), and the
 * body mounted over it in a plain container; `body` gets the host.
 */
async function withBody(
  id: string,
  {
    plugin = false,
    settings = {},
    chat: patch = {},
    onAway = () => {},
    limit = noLimit,
    prepare = async () => {},
  }: {
    plugin?: boolean
    settings?: Partial<Settings>
    chat?: Partial<Conversation>
    onAway?: (away: boolean) => void
    limit?: ChatBodyProps["limit"]
    /** Runs after the host exists and before the body mounts. */
    prepare?: (host: ReturnType<typeof fakeHost>) => Promise<void>
  },
  body: (host: ReturnType<typeof fakeHost>) => Promise<void>,
) {
  await seedChats([{ id, title: "Sky colours" }], {
    bots: [{ ...bot, baseUrl: `http://${id}.test/v1`, modelChoice: defaultPick }],
    settings: { chatNext: true, ...settings },
  })
  const host = fakeHost(`gots-${id}`, { plugin })
  await prepare(host)
  const chat = { ...(await db.conversations.get(id))!, ...patch }
  const profile = (await db.profiles.get(chat.profileId))!
  await mount(
    <MemoryRouter>
      <PreviewerProvider>
        <div data-testid="holder" className="flex h-[480px] min-h-0 flex-col">
          <ChatBody
            chat={chat}
            bot={profile}
            summaries={new Set()}
            start={undefined}
            onAway={onAway}
            limit={limit}
          />
        </div>
      </PreviewerProvider>
    </MemoryRouter>,
    async () => {
      await until(() => Boolean(composerField()), "the composer is drawn in the container")
      await body(host)
    },
  )
}

/** Starts a turn and leaves it running, so the next message lands in the middle of it. */
async function midReply(host: ReturnType<typeof fakeHost>, first: string) {
  await type(composerField(), first)
  await click(find('button[aria-label="Send"]'))
  await until(() => host.asked.runs === 1, "the first turn is running")
  await until(() => Boolean(find('button[aria-label="Stop"]')), "the composer knows it is")
  return host.latest.run!
}

test("the body draws a seeded chat in a plain container and a send runs a turn", async () => {
  await withBody("c-body", {}, async (host) => {
    assert.ok(missing('[data-slot="header-title"]'), "the body draws no header")
    await type(composerField(), "Why is the sky blue?")
    await click(find('button[aria-label="Send"]'))
    await until(() => host.asked.runs === 1, "the host was asked to run the message")
    assert.equal(host.latest.body!.session_id, "gots-c-body", "the chat's own session")
    assert.deepEqual(
      { provider: host.latest.body!.provider, model: host.latest.body!.model },
      defaultPick,
      "on the bot's pick",
    )
    host.latest.run!.finish("Rayleigh scattering.")
    await until(() => replies().includes("Rayleigh scattering."), "the reply lands in the thread")
    assert.ok(
      find('[data-testid="holder"]')?.contains(composerField() ?? null),
      "the composer sits inside the container it was given",
    )
  })
})

test("a turn's end reads what the plugin holds beside the transcript", async () => {
  await withBody("c-settled", { plugin: true }, async (host) => {
    const run = await midReply(host, "Plan it out")
    const before = host.todos.reads
    run.finish("Planned.")
    await until(
      () => host.todos.reads > before,
      "the turn's end asked the plugin for the session's todos",
    )
  })
})

test("a message sent mid-reply goes to the plugin's queue", async () => {
  await withBody("c-queued", { plugin: true }, async (host) => {
    await midReply(host, "First question")
    await type(composerField(), "And then this")
    await sendPress()
    await until(() => host.queue.length === 1, "the plugin holds the message")
    assert.equal(host.queue[0].text, "And then this")
    assert.equal(host.asked.runs, 1, "and nothing was started beside the running reply")
  })
})

test("with Steer by default, a message sent mid-reply steers the running reply", async () => {
  await withBody(
    "c-steered",
    { plugin: true, settings: { steerByDefault: true } },
    async (host) => {
      await midReply(host, "Write a poem")
      await type(composerField(), "Make it rhyme")
      await sendPress()
      await until(
        () => host.rows.some((row) => row.display_kind === "steer"),
        "the plugin steered the running reply",
      )
      assert.equal(host.queue.length, 0, "and holds nothing back")
    },
  )
})

test("a host that isn't answering is said to the caller that draws the header", async () => {
  const said: boolean[] = []
  await withBody(
    "c-away",
    {
      onAway: (away) => said.push(away),
      prepare: async () => {
        globalThis.fetch = (async () => {
          throw new TypeError("Failed to fetch")
        }) as typeof fetch
      },
    },
    async () => {
      await until(() => said.includes(true), "the body told its caller the host is away")
    },
  )
})

test("the account's limit notice is drawn above the composer's text", async () => {
  const usage = limitNotice({
    provider: "openrouter",
    windows: [
      { label: "Monthly", usedPercent: 95, resetsAt: Date.now() + 3 * 24 * 60 * 60 * 1000 },
    ],
    at: Date.now(),
  })
  await withBody(
    "c-limit",
    {
      limit: {
        usage: { notice: usage, provider: "openrouter", noticeDismissed: false },
        onView: () => {},
      },
    },
    async () => {
      await until(
        () =>
          /Approaching/.test(find('[data-testid="holder"] [data-slot="alert"]')?.textContent ?? ""),
        "the notice is drawn inside the container",
      )
    },
  )
})

test("what the plugin holds for the chat is the pills over the composer", async () => {
  await withBody(
    "c-pills",
    {
      prepare: async () => {
        await db.conversations.update("c-pills", {
          todos: {
            revision: 1,
            at: Date.now(),
            items: [
              { id: "1", content: "Read the brief", status: "completed" },
              { id: "2", content: "Write the plan", status: "in_progress" },
            ],
            progress: { done: 1, total: 2 },
          },
        })
      },
    },
    async () => {
      await until(
        () => Boolean(find('[data-testid="holder"]')?.textContent?.includes("1/2")),
        "the todo list is the pill above the composer",
      )
    },
  )
})

test("a chat the host compacted offers its earlier messages", async () => {
  await withBody("c-compacted", { chat: { compactions: [{ at: 20 }] } }, async () => {
    await until(
      () => Boolean(find('[data-testid="holder"] [data-earlier]')),
      "the thread offers the archived messages",
    )
  })
})
