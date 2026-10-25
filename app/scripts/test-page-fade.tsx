import assert from "node:assert/strict"
import test from "node:test"
import { Route } from "react-router"

import { mainThreadId } from "@/lib/db"
import { lastThreadKey } from "@/lib/threads"
import { forgetHeldChats } from "@/lib/chat-hold"
import {
  botProfile,
  click,
  find,
  findText,
  laptop,
  mount,
  path,
  phone,
  seedChats,
  settle,
  spyAnimate,
  text,
  until,
  withReducedMotion,
} from "./component-kit.tsx"

const bot = botProfile("fade", { id: "bot-1", name: "Fader" })
const other = botProfile("fade-other", { id: "bot-2", name: "Otherly" })
const MAIN = mainThreadId(bot.id)
const MAIN_OTHER = mainThreadId(other.id)

const FADE = [{ opacity: 0 }, { opacity: 1 }]
const PUSH = [
  { opacity: 0, transform: "translateX(24px)" },
  { opacity: 1, transform: "none" },
]

const settings = <Route path="settings" element={<p data-settings>Settings</p>} />

test("a switch in place fades the chat it lands, never the one it left", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seedChats(
    [
      { id: "c-a", title: "Alpha", messages: ["alpha one"] },
      { id: "c-b", title: "Beta", messages: ["beta one"] },
    ],
    { bots: [bot, other], active: bot.id },
  )
  await mount(phone("/c/c-a", "/c/c-b", { routes: settings }), async () => {
    await until(async () => text().includes("alpha one"), "the chat on screen")
    const spy = spyAnimate()
    try {
      await click(find("[data-switch]"))
      await until(async () => text().includes("beta one"), "the chat asked for")
      await settle()
    } finally {
      spy.restore()
    }

    assert.deepEqual(
      spy.overHeld().map((one) => one.pane),
      [],
      "no transition plays over the chat the switch left",
    )
    assert.deepEqual(
      spy.onScreen().map((one) => one.element),
      [],
      "and the screen's own element is not faded: the fade is the swapped pane's",
    )
    const played = spy.onPanes()
    assert.equal(played.length, 1, "the switch plays one transition")
    assert.equal(played[0].pane, "route", "on the pane the chat asked for was swapped into")
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
    await seedChats(
      [
        { id: MAIN, profileId: bot.id, title: "Fader", main: true, messages: ["alpha one"] },
        {
          id: MAIN_OTHER,
          profileId: other.id,
          title: "Otherly",
          main: true,
          messages: ["beta one"],
        },
      ],
      { bots: [bot, other], active: bot.id, botThreads: true },
    )
    await mount(phone(`/c/${MAIN}`, `/c/${MAIN_OTHER}`), async () => {
      await until(async () => text().includes("alpha one"), "the bot on screen")
      const spy = spyAnimate()
      try {
        await click(findText("a", "Otherly"))
        await until(async () => text().includes("beta one"), "the bot asked for")
        await settle()
      } finally {
        spy.restore()
      }

      assert.deepEqual(
        spy.overHeld().map((one) => one.pane),
        [],
        "no transition plays over the bot the switch left",
      )
      const played = spy.onPanes()
      assert.equal(played.length, 1, "one bot changing into the next is one transition")
      assert.equal(played[0].pane, "main", "on the bot's own pane, where the chat was swapped")
      assert.deepEqual(played[0].keyframes, FADE)
      assert.equal(played[0].options.duration, 200)
      assert.ok(played[0].shown.includes("beta one"), "played as the bot asked for lands")
    })
  }),
)

test(
  "a thread opened beside Main fades its own pane, and animates nothing of Main's",
  laptop(async () => {
    localStorage.clear()
    forgetHeldChats()
    await seedChats(
      [
        { id: MAIN, profileId: bot.id, title: "Fader", main: true, messages: ["main one"] },
        { id: "t-a", profileId: bot.id, title: "Thread t-a", messages: ["alpha one"] },
        { id: "t-b", profileId: bot.id, title: "Thread t-b", messages: ["beta one"] },
      ],
      { bots: [bot, other], active: bot.id, botThreads: true },
    )
    localStorage.setItem(lastThreadKey(bot.id), "t-a")
    await mount(phone(`/c/${MAIN}`, "/c/t-b"), async () => {
      await until(async () => text().includes("alpha one"), "the thread beside Main")
      const spy = spyAnimate()
      try {
        await click(find('[data-slot="thread-card"] a[href="/c/t-b"]'))
        await until(async () => text().includes("beta one"), "the thread asked for")
        await settle()
      } finally {
        spy.restore()
      }

      assert.deepEqual(
        spy.overHeld().map((one) => one.pane),
        [],
        "no transition plays over the thread the switch left",
      )
      assert.deepEqual(
        spy.asked.filter((one) => one.pane === "main").map((one) => one.element),
        [],
        "Main's own pane plays nothing: the thread beside it is the only chat that changed",
      )
      assert.deepEqual(
        spy.onScreen().map((one) => one.element),
        [],
        "and the screen's own element is not faded over it",
      )
      const played = spy.onPanes()
      assert.equal(played.length, 1, "the thread beside Main fades once, as it lands")
      assert.equal(played[0].pane, "thread", "on the thread's own pane")
      assert.deepEqual(played[0].keyframes, FADE)
      assert.ok(played[0].shown.includes("beta one"), "played as the thread asked for lands")
    })
  }),
)

test("a chat's first send gives it an id without fading: nothing was left behind", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seedChats(
    [
      { id: "c-a", title: "Alpha", messages: ["alpha one"] },
      { id: "c-b", title: "Beta", messages: ["beta one"] },
    ],
    { bots: [bot, other], active: bot.id },
  )
  await mount(phone("/", "/c/c-b", { replace: true, quiet: true }), async () => {
    await until(async () => Boolean(find("[data-pane]")), "the new chat")
    const spy = spyAnimate()
    try {
      await click(find("[data-switch]"))
      await until(async () => text().includes("beta one"), "the chat the id names")
      await settle()
    } finally {
      spy.restore()
    }

    assert.deepEqual(
      spy.asked.map((one) => `${one.pane ?? one.element}:${one.keyframes.length}`),
      [],
      "no transition plays as a new chat takes the id its first message made",
    )
    assert.equal(path(), "/c/c-b", "and the chat takes the address its id names")
  })
})

test(
  "a screen that isn't a chat keeps the transition it has",
  laptop(async () => {
    localStorage.clear()
    forgetHeldChats()
    await seedChats(
      [{ id: MAIN, profileId: bot.id, title: "Fader", main: true, messages: ["alpha one"] }],
      {
        bots: [bot, other],
        active: bot.id,
        botThreads: true,
      },
    )
    await mount(phone(`/c/${MAIN}`, "/settings", { routes: settings }), async () => {
      await until(async () => text().includes("alpha one"), "the chat on screen")
      const spy = spyAnimate()
      try {
        window.history.replaceState({ idx: 1 }, "")
        await click(find("[data-switch]"))
        await until(async () => Boolean(find("[data-settings]")), "the screen asked for")
        await settle()
      } finally {
        spy.restore()
      }

      const played = spy.onScreen()
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
  await seedChats(
    [
      { id: "c-a", title: "Alpha", messages: ["alpha one"] },
      { id: "c-b", title: "Beta", messages: ["beta one"] },
    ],
    { bots: [bot, other], active: bot.id },
  )
  await withReducedMotion(async () => {
    await mount(phone("/c/c-a", "/c/c-b"), async () => {
      await until(async () => text().includes("alpha one"), "the chat on screen")
      const spy = spyAnimate()
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
