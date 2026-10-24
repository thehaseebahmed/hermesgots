/**
 * A bot or thread switch is one change: the pane keeps the chat it showed until every answer for the
 * chat asked for has come in, then lands that chat's header and body together. These tests drive the
 * switch the way the app does — in place on a phone's route, and by remount beside Main on a laptop —
 * and read every frame painted in between, so a state that exists only for a commit can't hide.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router"

import { AppShell } from "@/components/app-shell"
import { BOTS } from "@/components/bots"
import { db, ensureMainThread, mainThreadId } from "@/lib/db"
import { lastThreadKey, useThreads } from "@/lib/threads"
import { ChatPage, forgetHeldChats } from "@/routes/chat"
import {
  botProfile,
  click,
  find,
  json,
  mount,
  Path,
  path,
  seedSettings,
  settle,
  text,
  until,
} from "./component-kit.tsx"

const bot = botProfile("switch-hold", { id: "bot-1", name: "Switcher" })
const other = botProfile("switch-hold-other", { id: "bot-2", name: "Otherly" })
const MAIN = mainThreadId(bot.id)

/** The words only a chat that is not ready says: the setup copy, an untitled header, the greeting. */
const PROVISIONAL = [
  "Point Gots at your Hermes Agent API server to start chatting.",
  "New chat",
  "Good morning.",
  "Good afternoon.",
  "Good evening.",
  ...BOTS.flatMap((one) => one.lines),
]

interface Chat {
  id: string
  title: string
  said: string
}

async function seed(chats: Chat[], patch: { botThreads?: boolean } = {}) {
  await seedSettings({ developer: true, botThreads: false, activeProfileId: bot.id, ...patch })
  await db.profiles.clear()
  await db.profiles.bulkPut([bot, other])
  await db.conversations.clear()
  await db.messages.clear()
  await db.conversations.bulkPut(
    chats.map((chat, index) => ({
      id: chat.id,
      profileId: bot.id,
      title: chat.title,
      titleEdited: true,
      hermesSessionId: `memento-${chat.id}`,
      createdAt: 10 + index,
      updatedAt: 10 + index,
      changedAt: 10,
    })),
  )
  await db.messages.bulkPut(
    chats.map((chat, index) => ({
      id: `${chat.id}-said`,
      conversationId: chat.id,
      role: "user" as const,
      content: chat.said,
      status: "done" as const,
      createdAt: 11 + index,
    })),
  )
  globalThis.fetch = async () => json({})
}

/** What a pane reads as right now: its own words, and whether it is the outgoing chat on hold. */
interface Frame {
  text: string
  /** The pane is inert: it draws the chat the switch left, and nothing can act on it. */
  holding: boolean
  /** The composer is part of what is held, so a tap on send can reach no chat at all. */
  composer: boolean
}

const frameOf = (root: Element | null | undefined): Frame => {
  const panes = [...(root?.querySelectorAll('[data-slot="chat-pane"]') ?? [])]
  // A pane that names itself is the pane whose words count; one that doesn't is read where it sits,
  // so a frame painted without a hold is still a frame this test can catch.
  const boxes = panes.length > 0 ? panes : root ? [root] : []
  const holding = panes.filter((pane) => pane.hasAttribute("inert"))
  return {
    text: boxes.map((pane) => pane.textContent ?? "").join("|"),
    holding: holding.length > 0,
    composer: holding.some((pane) => pane.querySelector('textarea[aria-label="Message"]')),
  }
}

/** Every frame the chat painted from the moment it was armed, and every word a change wrote. */
function recordFrames(read: () => Frame) {
  const frames: Frame[] = []
  const written: string[] = []
  const look = (records: MutationRecord[]) => {
    for (const record of records) {
      if (record.type === "characterData") written.push(record.target.textContent ?? "")
      for (const node of record.addedNodes) written.push(node.textContent ?? "")
    }
    frames.push(read())
  }
  const observer = new MutationObserver(look)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return {
    frames,
    written,
    stop() {
      look(observer.takeRecords())
      observer.disconnect()
    },
  }
}

/**
 * Asserts the pane painted the chat it held until the chat asked for, and never a word of the states
 * in between: not the setup copy, not an untitled header, not the line a new chat greets with.
 */
function onlyReadyFrames(seen: ReturnType<typeof recordFrames>, before: string, after: string) {
  seen.stop()
  assert.ok(seen.frames.length > 0, "the switch painted something")
  assert.deepEqual(
    seen.frames.map((frame) => frame.text).filter((one) => one !== before && one !== after),
    [],
    "every frame carried the chat that was there or the one asked for",
  )
  assert.deepEqual(
    seen.written.filter((words) => PROVISIONAL.some((copy) => words.includes(copy))),
    [],
    "no frame carried the setup copy, an untitled header or a greeting line",
  )
}

/** What a switch wrote of the greeting, so a test can prove it wrote nothing. */
const greetingKeys = () =>
  Array.from({ length: localStorage.length }, (_, at) => localStorage.key(at) ?? "")
    .filter((key) => key === "memento:last-greeted" || key.startsWith("memento:line-turn:"))
    .sort()
    .map((key) => `${key}=${localStorage.getItem(key)}`)

/** The routed chat, as a phone draws it: the id under the pane changes and nothing remounts. */
function SwitchTo({ to }: { to: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" data-switch onClick={() => navigate(to)}>
      switch
    </button>
  )
}

const phone = (entry: string, to: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <SwitchTo to={to} />
    <div data-chat>
      <Routes>
        <Route path="/c/:id" element={<ChatPage />} />
      </Routes>
    </div>
  </MemoryRouter>
)

const shell = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route element={<AppShell />}>
        <Route path="c/:id" element={<ChatPage />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

/** A laptop's width: the bot's third pane is `xl`'s, so a test has to say the screen is one. */
const laptop = (body: () => Promise<void>) => async () => {
  const width = window.innerWidth
  window.innerWidth = 1440
  try {
    await body()
  } finally {
    window.innerWidth = width
  }
}

const paneText = () => find("[data-chat]")?.textContent ?? ""
const phoneFrame = () => frameOf(find("[data-chat]"))

/** The card Main draws for a thread, which opens it in the pane beside it. */
const card = (id: string) => find(`[data-slot="thread-card"] a[href="/c/${id}"]`)

test("a chat switched to in place holds the one it left until its own answers are in", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seed([
    { id: "c-a", title: "Alpha", said: "alpha one" },
    { id: "c-b", title: "Beta", said: "beta one" },
  ])
  await mount(phone("/c/c-a", "/c/c-b"), async () => {
    await until(async () => paneText().includes("alpha one"), "the chat on screen")
    const before = paneText()
    const greeting = greetingKeys()
    const seen = recordFrames(phoneFrame)

    await click(find("[data-switch]"))
    await until(async () => paneText().includes("beta one"), "the chat asked for")
    await settle()

    onlyReadyFrames(seen, before, paneText())
    assert.ok(
      seen.frames.some((frame) => frame.holding && frame.text === before),
      "the chat left is the one drawn while the next one answers",
    )
    assert.ok(
      seen.frames.some((frame) => frame.holding && frame.composer),
      "and its composer is held with it, so a tap on send reaches no chat at all",
    )
    assert.deepEqual(
      seen.frames
        .filter((frame) => frame.holding && frame.text !== before)
        .map((frame) => frame.text),
      [],
      "nothing but the chat left is ever drawn inert",
    )
    assert.equal(
      seen.frames.at(-1)?.holding,
      false,
      "and the pane answers the reader once it lands",
    )
    assert.deepEqual(greetingKeys(), greeting, "the switch wrote nothing of the greeting")
  })
})

test(
  "a thread opened beside Main holds the thread it replaced until its answers are in",
  laptop(async () => {
    localStorage.clear()
    forgetHeldChats()
    await seed(
      [
        { id: "t-a", title: "Thread t-a", said: "alpha one" },
        { id: "t-b", title: "Thread t-b", said: "beta one" },
      ],
      { botThreads: true },
    )
    await ensureMainThread(bot.id)
    localStorage.setItem(lastThreadKey(bot.id), "t-a")
    await mount(shell(`/c/${MAIN}`), async () => {
      await until(async () => text().includes("alpha one"), "the thread beside Main")
      await until(async () => Boolean(card("t-b")), "the other thread's card")
      const pane = () => frameOf(find("main"))
      const before = pane().text
      const greeting = greetingKeys()
      const seen = recordFrames(pane)

      await click(card("t-b"))
      await until(async () => pane().text.includes("beta one"), "the thread asked for")
      await settle()

      onlyReadyFrames(seen, before, pane().text)
      assert.ok(
        seen.frames.some((frame) => frame.holding && frame.text === before),
        "the thread replaced is the one drawn while the next one answers",
      )
      assert.deepEqual(greetingKeys(), greeting, "the switch wrote nothing of the greeting")
    })
  }),
)

test("a cold start paints a spinner under an empty header, never the setup copy", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seed([{ id: "c-a", title: "Alpha", said: "alpha one" }])
  const container = document.createElement("div")
  document.body.append(container)
  const seen = recordFrames(() => {
    const chat = find("[data-chat]")
    if (!chat) return { text: "nothing", holding: false, composer: false }
    const spinner = chat.querySelector('[data-slot="spinner"]') ? "spinner" : "no-spinner"
    const title = [...chat.querySelectorAll('[data-slot="header-title"]')]
      .map((node) => node.textContent)
      .join("|")
    return {
      text: `${spinner}|${title}|${chat.textContent ?? ""}`,
      holding: false,
      composer: false,
    }
  })
  const root = createRoot(container)
  try {
    await act(async () => root.render(phone("/c/c-a", "/c/c-b")))
    await settle()
    seen.stop()
    const painted = seen.frames.map((frame) => frame.text).filter((one) => one !== "nothing")
    assert.ok(painted.length > 0, "the pane painted something")
    assert.ok(painted[0].startsWith("spinner||"), `the first frame is a spinner: ${painted[0]}`)
    assert.ok(!painted[0].includes("Point Gots"), "the setup copy is never a loading state")
    const last = painted.at(-1) ?? ""
    assert.equal(last.includes("alpha one"), true, "and the first ready frame is the chat itself")
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

test("a chat answered gone lands as its own empty state, in the place it was asked for", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seed([
    { id: "c-a", title: "Alpha", said: "alpha one" },
    { id: "c-b", title: "Beta", said: "beta one" },
  ])
  await mount(phone("/c/c-a", "/c/c-b"), async () => {
    await until(async () => paneText().includes("alpha one"), "the chat on screen")
    // Deleted on another board, then opened here: the row is gone, and that is an answer too.
    await db.conversations.delete("c-b")
    await db.messages.where("conversationId").equals("c-b").delete()
    await settle()

    await click(find("[data-switch]"))
    await until(async () => !find("[data-chat] [inert]"), "the chat that answered gone to land")
    await settle()

    assert.equal(path(), "/c/c-b", "the chat keeps the place it was asked for")
    assert.ok(!paneText().includes("beta one"), "nothing of the chat this device no longer has")
    assert.ok(!paneText().includes("Point Gots"), "and never the setup copy")
    assert.ok(
      BOTS.some((one) => one.lines.some((line) => paneText().includes(line))),
      "its own empty state, as any empty chat draws one",
    )
  })
})

const answers: string[] = []

function ThreadAnswer({ profileId }: { profileId?: string }) {
  const threads = useThreads(profileId)
  const answer = threads === undefined ? "unknown" : String(threads.length)
  answers.push(`${profileId ?? "none"}:${answer}`)
  return <p data-answer>{answer}</p>
}

function Asked({ first, then }: { first?: string; then?: string }) {
  const [asking, setAsking] = useState(first)
  return (
    <>
      <button type="button" data-ask onClick={() => setAsking(then)}>
        ask
      </button>
      <ThreadAnswer profileId={asking} />
    </>
  )
}

test("a thread list asked for another bot is unknown, never no threads", async () => {
  await seed([{ id: "t-a", title: "Thread t-a", said: "alpha one" }], { botThreads: true })
  await mount(<Asked first={other.id} then={bot.id} />, async () => {
    await until(async () => find("[data-answer]")?.textContent === "0", "a bot with no threads")
    answers.length = 0
    await click(find("[data-ask]"))
    await until(async () => find("[data-answer]")?.textContent === "1", "the bot's one thread")
    assert.deepEqual(
      answers.filter((answer) => answer === `${bot.id}:0`),
      [],
      "the bot asked for is never answered with another bot's empty list",
    )
  })
})
