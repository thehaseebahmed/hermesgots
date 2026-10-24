import assert from "node:assert/strict"
import test from "node:test"
import { act, useState } from "react"
import { createRoot } from "react-dom/client"

import { BOTS } from "@/components/bots"
import { db, ensureMainThread, mainThreadId } from "@/lib/db"
import { GREETINGS } from "@/lib/greeting"
import { forgetHeldChats } from "@/lib/chat-hold"
import { lastThreadKey, useThreads } from "@/lib/threads"
import { SETUP_COPY } from "@/routes/chat"
import {
  botProfile,
  click,
  find,
  laptop,
  mount,
  path,
  phone,
  seedChats,
  settle,
  until,
} from "./component-kit.tsx"

const bot = botProfile("switch-hold", { id: "bot-1", name: "Switcher" })
const other = botProfile("switch-hold-other", { id: "bot-2", name: "Otherly" })
const MAIN = mainThreadId(bot.id)

const PROVISIONAL = [SETUP_COPY, "New chat", ...GREETINGS, ...BOTS.flatMap((one) => one.lines)]

interface Frame {
  text: string
  holding: boolean
  composer: boolean
}

const frameNow = (): Frame => {
  const panes = [...document.querySelectorAll('[data-slot="chat-pane"]')]
  const holding = panes.filter((pane) => pane.hasAttribute("inert"))
  return {
    text: panes.map((pane) => pane.textContent ?? "").join("|"),
    holding: holding.length > 0,
    composer: holding.some((pane) => pane.querySelector('textarea[aria-label="Message"]')),
  }
}

const paneFrame = (name: string): Frame => {
  const root = find(`[data-pane="${name}"]`)
  return {
    text: root?.textContent ?? "",
    holding: Boolean(root?.hasAttribute("inert")),
    composer: Boolean(root?.querySelector('textarea[aria-label="Message"]')),
  }
}

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

const greetingKeys = () =>
  Array.from({ length: localStorage.length }, (_, at) => localStorage.key(at) ?? "")
    .filter((key) => key === "memento:last-greeted" || key.startsWith("memento:line-turn:"))
    .sort()
    .map((key) => `${key}=${localStorage.getItem(key)}`)

const paneText = (name = "route") => find(`[data-pane="${name}"]`)?.textContent ?? ""
const paneTitle = () =>
  find('[data-pane="route"] [data-slot="header-title"]')?.textContent?.trim() ?? ""

const card = (id: string) => find(`[data-slot="thread-card"] a[href="/c/${id}"]`)

test("a chat switched to in place holds the one it left until its own answers are in", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seedChats(
    [
      { id: "c-a", title: "Alpha", messages: ["alpha one"] },
      { id: "c-b", title: "Beta", messages: ["beta one"] },
    ],
    { bots: [bot, other], active: bot.id },
  )
  await mount(phone("/c/c-a", "/c/c-b"), async () => {
    await until(async () => paneText().includes("alpha one"), "the chat on screen")
    const before = paneText()
    const greeting = greetingKeys()
    const seen = recordFrames(frameNow)

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
    await seedChats(
      [
        { id: "t-a", title: "Thread t-a", messages: ["alpha one"] },
        { id: "t-b", title: "Thread t-b", messages: ["beta one"] },
      ],
      { bots: [bot, other], active: bot.id, botThreads: true },
    )
    await ensureMainThread(bot.id)
    localStorage.setItem(lastThreadKey(bot.id), "t-a")
    await mount(phone(`/c/${MAIN}`, "/c/t-b"), async () => {
      await until(async () => paneText("thread").includes("alpha one"), "the thread beside Main")
      await until(async () => Boolean(card("t-b")), "the other thread's card")
      const before = paneFrame("thread").text
      const greeting = greetingKeys()
      const seen = recordFrames(() => paneFrame("thread"))

      await click(card("t-b"))
      await until(async () => paneFrame("thread").text.includes("beta one"), "the thread asked for")
      await settle()

      onlyReadyFrames(seen, before, paneFrame("thread").text)
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
  await seedChats([{ id: "c-a", title: "Alpha", messages: ["alpha one"] }], {
    bots: [bot, other],
    active: bot.id,
  })
  const container = document.createElement("div")
  document.body.append(container)
  const seen = recordFrames(() => {
    const chat = find('[data-pane="route"]')
    if (!chat) return { text: "nothing", holding: false, composer: false }
    const spinner = chat.querySelector('[data-slot="spinner"]') ? "spinner" : "no-spinner"
    const title = [...chat.querySelectorAll('[data-slot="header-title"]')]
      .map((node) => node.textContent)
      .join("|")
    return {
      text: `${spinner}|${title}|${chat.textContent ?? ""}`,
      holding: chat.hasAttribute("inert"),
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
    assert.ok(!painted[0].includes(SETUP_COPY), "the setup copy is never a loading state")
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
  await seedChats(
    [
      { id: "c-a", title: "Alpha", messages: ["alpha one"] },
      { id: "c-b", title: "Beta", messages: ["beta one"] },
    ],
    { bots: [bot, other], active: bot.id },
  )
  await mount(phone("/c/c-a", "/c/c-b"), async () => {
    await until(async () => paneText().includes("alpha one"), "the chat on screen")
    const greeting = greetingKeys()
    await db.conversations.delete("c-b")
    await db.messages.where("conversationId").equals("c-b").delete()
    await settle()

    await click(find("[data-switch]"))
    await until(
      async () => !paneFrame("route").holding && !paneText().includes("alpha one"),
      "the chat that answered gone to land",
    )
    await settle()

    assert.equal(path(), "/c/c-b", "the chat keeps the place it was asked for")
    assert.ok(!paneText().includes("beta one"), "nothing of the chat this device no longer has")
    assert.ok(!paneText().includes(SETUP_COPY), "and never the setup copy")
    assert.equal(paneTitle(), "", "the header stands empty, as the row it read is gone")
    assert.ok(!paneText().includes("New chat"), "and a gone chat is never drawn as a new one")
    assert.deepEqual(
      PROVISIONAL.filter((copy) => paneText().includes(copy)),
      [],
      "its empty state draws no greeting and no bot line: the ready line mounts on no gone chat",
    )
    assert.equal(
      find('[data-pane="route"] [data-slot="spinner"]'),
      null,
      "and it is ready: the pane answers the reader rather than spinning",
    )
    assert.deepEqual(
      greetingKeys(),
      greeting,
      "a chat that answered gone consumes no line turn and swallows no greeting",
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
  await seedChats([{ id: "t-a", title: "Thread t-a", messages: ["alpha one"] }], {
    bots: [bot, other],
    active: bot.id,
    botThreads: true,
  })
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
