/**
 * A switch's transition belongs to the swap, not to the address: moving between two chats shows the
 * one the reader left until the next one is ready, so a fade over that moment fades in the chat they
 * already had. These tests read every animation the shell asks for, and what was on screen when it
 * asked, so a transition played over a held chat can't pass for one played as the next chat lands.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { Link, MemoryRouter, Route, Routes } from "react-router"

import { AppShell } from "@/components/app-shell"
import { db, mainThreadId } from "@/lib/db"
import { lastThreadKey } from "@/lib/threads"
import { ChatPage, forgetHeldChats } from "@/routes/chat"
import {
  botProfile,
  click,
  find,
  findText,
  json,
  mount,
  Path,
  path,
  seedSettings,
  settle,
  text,
  until,
  withReducedMotion,
} from "./component-kit.tsx"

const bot = botProfile("fade", { id: "bot-1", name: "Fader" })
const other = botProfile("fade-other", { id: "bot-2", name: "Otherly" })
const MAIN = mainThreadId(bot.id)
const MAIN_OTHER = mainThreadId(other.id)

/** The transition a chat taking another's place has always played. */
const FADE = [{ opacity: 0 }, { opacity: 1 }]
/** The one a screen opened on top of another plays. */
const PUSH = [
  { opacity: 0, transform: "translateX(24px)" },
  { opacity: 1, transform: "none" },
]

interface Chat {
  id: string
  profileId: string
  title: string
  said: string
  main?: boolean
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
      profileId: chat.profileId,
      title: chat.title,
      main: chat.main,
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

/** One animation a screen asked for, and what the panes said when it asked. */
interface Asked {
  element: string
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  /** The chat a switch left, still on screen on hold. */
  held: string
  /** The chat the pane drew as its own. */
  shown: string
  /** Every word on the screen, for a transition played by a screen that isn't a chat. */
  body: string
}

/** Records every animation asked for, so a test can read when it played and over what. */
function spyAnimations() {
  const asked: Asked[] = []
  const animate = HTMLElement.prototype.animate
  HTMLElement.prototype.animate = function (keyframes, options) {
    const panes = [...document.querySelectorAll('[data-slot="chat-pane"]')]
    const words = (held: boolean) =>
      panes
        .filter((pane) => pane.hasAttribute("inert") === held)
        .map((pane) => pane.textContent ?? "")
        .join("|")
    asked.push({
      element: this.tagName.toLowerCase(),
      keyframes: Array.isArray(keyframes) ? (keyframes as Keyframe[]) : [],
      options: typeof options === "number" ? { duration: options } : (options ?? {}),
      held: words(true),
      shown: words(false),
      body: document.body.textContent ?? "",
    })
    return animate.call(this, keyframes, options)
  }
  return {
    asked,
    /** What the shell played on the pane the screens are drawn into. */
    onPane: () => asked.filter((one) => one.element === "main"),
    /** The pane's own animations played while a switch's held chat was still the chat on screen. */
    overHeld: () => asked.filter((one) => one.element === "main" && one.held !== ""),
    restore() {
      HTMLElement.prototype.animate = animate
    },
  }
}

/** A phone's route: the shell around the one chat, and a link back to the list it came from. */
const phone = (entry: string, to: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Link to={to} data-switch>
      switch
    </Link>
    <Routes>
      <Route element={<AppShell />}>
        <Route path="c/:id" element={<ChatPage />} />
        <Route path="settings" element={<p data-settings>Settings</p>} />
      </Route>
    </Routes>
  </MemoryRouter>
)

/** A laptop's width: the bot's third pane, and the bots list, are `xl`'s. */
const laptop = (body: () => Promise<void>) => async () => {
  const width = window.innerWidth
  window.innerWidth = 1440
  try {
    await body()
  } finally {
    window.innerWidth = width
  }
}

test("a switch in place fades the chat it lands, never the one it left", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seed([
    { id: "c-a", profileId: bot.id, title: "Alpha", said: "alpha one" },
    { id: "c-b", profileId: bot.id, title: "Beta", said: "beta one" },
  ])
  await mount(phone("/c/c-a", "/c/c-b"), async () => {
    await until(async () => text().includes("alpha one"), "the chat on screen")
    const spy = spyAnimations()
    try {
      await click(find("[data-switch]"))
      await until(async () => text().includes("beta one"), "the chat asked for")
      await settle()
    } finally {
      spy.restore()
    }

    assert.deepEqual(
      spy.overHeld().map((one) => one.element),
      [],
      "no transition plays over the chat the switch left",
    )
    const played = spy.onPane()
    assert.equal(played.length, 1, "the switch plays one transition")
    assert.deepEqual(played[0].keyframes, FADE, "the fade a chat taking another's place plays")
    assert.equal(played[0].options.duration, 200, "at the pace it always had")
    assert.ok(
      played[0].shown.includes("beta one") && !played[0].shown.includes("alpha one"),
      "and it plays as the chat asked for replaces the one held",
    )
    assert.equal(path(), "/c/c-b", "the address is the chat asked for")
  })
})

test(
  "a bot switch fades the pane once, as the bot asked for lands",
  laptop(async () => {
    localStorage.clear()
    forgetHeldChats()
    await seed(
      [
        { id: MAIN, profileId: bot.id, title: "Fader", said: "alpha one", main: true },
        { id: MAIN_OTHER, profileId: other.id, title: "Otherly", said: "beta one", main: true },
      ],
      { botThreads: true },
    )
    await mount(phone(`/c/${MAIN}`, `/c/${MAIN_OTHER}`), async () => {
      await until(async () => text().includes("alpha one"), "the bot on screen")
      const spy = spyAnimations()
      try {
        // The sidebar's own way to another bot, which lands on its Main.
        await click(findText("a", "Otherly"))
        await until(async () => text().includes("beta one"), "the bot asked for")
        await settle()
      } finally {
        spy.restore()
      }

      assert.deepEqual(
        spy.overHeld().map((one) => one.element),
        [],
        "no transition plays over the bot the switch left",
      )
      const played = spy.onPane()
      assert.equal(played.length, 1, "one bot changing into the next is one transition")
      assert.deepEqual(played[0].keyframes, FADE)
      assert.equal(played[0].options.duration, 200)
      assert.ok(played[0].shown.includes("beta one"), "played as the bot asked for lands")
    })
  }),
)

test(
  "a thread opened beside Main fades the pane as its answers land",
  laptop(async () => {
    localStorage.clear()
    forgetHeldChats()
    await seed(
      [
        { id: MAIN, profileId: bot.id, title: "Fader", said: "main one", main: true },
        { id: "t-a", profileId: bot.id, title: "Thread t-a", said: "alpha one" },
        { id: "t-b", profileId: bot.id, title: "Thread t-b", said: "beta one" },
      ],
      { botThreads: true },
    )
    localStorage.setItem(lastThreadKey(bot.id), "t-a")
    await mount(phone(`/c/${MAIN}`, "/c/t-b"), async () => {
      await until(async () => text().includes("alpha one"), "the thread beside Main")
      const spy = spyAnimations()
      try {
        await click(find('[data-slot="thread-card"] a[href="/c/t-b"]'))
        await until(async () => text().includes("beta one"), "the thread asked for")
        await settle()
      } finally {
        spy.restore()
      }

      assert.deepEqual(
        spy.overHeld().map((one) => one.element),
        [],
        "no transition plays over the thread the switch left",
      )
      const played = spy.onPane()
      assert.equal(played.length, 1, "the thread beside Main fades once, as it lands")
      assert.deepEqual(played[0].keyframes, FADE)
      assert.ok(played[0].shown.includes("beta one"), "played as the thread asked for lands")
    })
  }),
)

test(
  "a screen that isn't a chat keeps the transition it has",
  laptop(async () => {
    localStorage.clear()
    forgetHeldChats()
    await seed([{ id: MAIN, profileId: bot.id, title: "Fader", said: "alpha one", main: true }], {
      botThreads: true,
    })
    await mount(phone(`/c/${MAIN}`, "/settings"), async () => {
      await until(async () => text().includes("alpha one"), "the chat on screen")
      const spy = spyAnimations()
      try {
        // Opened on top of the chat, the way a push into another screen reads to the shell.
        window.history.replaceState({ idx: 1 }, "")
        await click(find("[data-switch]"))
        await until(async () => Boolean(find("[data-settings]")), "the screen asked for")
        await settle()
      } finally {
        spy.restore()
      }

      const played = spy.onPane()
      assert.equal(
        played.length,
        1,
        "the screen opened on top plays its transition, as it always did",
      )
      assert.deepEqual(played[0].keyframes, PUSH, "the slide a screen opened on top plays")
      assert.equal(played[0].options.duration, 260)
      assert.ok(played[0].body.includes("Settings"), "played as that screen arrives")
    })
  }),
)

test("with reduced motion the swap changes the same content and animates nothing", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seed([
    { id: "c-a", profileId: bot.id, title: "Alpha", said: "alpha one" },
    { id: "c-b", profileId: bot.id, title: "Beta", said: "beta one" },
  ])
  await withReducedMotion(async () => {
    await mount(phone("/c/c-a", "/c/c-b"), async () => {
      await until(async () => text().includes("alpha one"), "the chat on screen")
      const spy = spyAnimations()
      try {
        await click(find("[data-switch]"))
        await until(async () => text().includes("beta one"), "the chat asked for")
        await settle()
      } finally {
        spy.restore()
      }

      assert.deepEqual(spy.asked, [], "nothing animates")
      assert.ok(text().includes("beta one"), "and the chat asked for is the one on screen")
    })
  })
})
