/** What the device's tray keeps when the app opens: only the screen a push is about answers it. */
import assert from "node:assert/strict"
import test from "node:test"

import { startPush } from "@/lib/push"
import { pluginRoot } from "@/lib/host-url"
import { botProfile, chatScreen, mount, seedChats, settle, until } from "./component-kit.tsx"

interface Shown {
  tag: string
  data?: Record<string, unknown>
  closed: boolean
}

/**
 * Puts `entries` in the device's tray as the service worker lists it, and gives the app a way to
 * read and close them: what `getNotifications()` and `close()` are for the app.
 */
function trayOf(entries: { tag: string; data?: Record<string, unknown> }[]) {
  const shown = entries.map((entry) => ({ ...entry, closed: false }))
  const asNotification = (entry: Shown) => ({
    tag: entry.tag,
    data: entry.data,
    close: () => void (entry.closed = true),
  })
  const registration = {
    getNotifications: async () => shown.filter((entry) => !entry.closed).map(asNotification),
  }
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { getRegistration: async () => registration },
  })
  return shown
}

/** The browser the tray lives in: the app reads a permission and a push manager to trust one. */
function browser() {
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    value: Object.assign(function Notification() {}, { permission: "granted" }),
  })
  Object.defineProperty(window, "PushManager", { configurable: true, value: class {} })
}

const bot = botProfile("push-dismiss", { id: "bot-1", name: "Pusher", apiKey: "test-key" })

/** What the app told the account: every POST it made, as its url and its body. */
function told() {
  const calls: { url: string; body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST")
      calls.push({
        url: String(input instanceof Request ? input.url : input),
        body: JSON.parse(String(init.body ?? "{}")),
      })
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
  }) as unknown as typeof fetch
  return calls
}

/** The dismissals among them: what the registry and the bot's plugin were each told. */
const dismissals = (calls: { url: string; body: unknown }[]) =>
  calls.filter((one) => /route=dismiss|push\/dismiss/.test(one.url))

const about = (chat: string, session = `gots-${chat}`) => ({
  tag: `session:${session}`,
  data: { sessionId: session },
})

const dismissed = (shown: { tag: string; closed: boolean }[]) =>
  shown.filter((entry) => entry.closed).map((entry) => entry.tag)

test("a push about a thread nobody opened stays in the tray", async () => {
  browser()
  await seedChats([{ id: "chat-a" }, { id: "chat-b" }], { bots: [bot] })
  const shown = trayOf([about("chat-a"), about("chat-b")])
  startPush()
  await settle()
  assert.deepEqual(
    dismissed(shown),
    [],
    "the app coming to the front answers nothing: both threads are still unread",
  )
})

test("opening a chat dismisses the pushes about it, and only those", async () => {
  browser()
  await seedChats([{ id: "chat-a" }, { id: "chat-b" }], { bots: [bot] })
  const shown = trayOf([about("chat-a"), about("chat-b")])
  await mount(chatScreen("chat-a"), async () => {
    await until(async () => dismissed(shown).length > 0, "the opened chat's push is dismissed")
  })
  assert.deepEqual(
    dismissed(shown),
    ["session:gots-chat-a"],
    "the thread on screen answered its own push, and the other thread's is untouched",
  )
})

test("a push whose data carries no session is matched by its tag", async () => {
  browser()
  await seedChats([{ id: "chat-a" }, { id: "chat-b" }], { bots: [bot] })
  // The phone hands over no data for a notification message, so the tag is what a dismissal
  // reads by; this drives that half through the web tray, and `pushSubject` pins the Android tag.
  const shown = trayOf([{ tag: "chat_input:gots-chat-a" }, { tag: "chat_input:gots-chat-b" }])
  await mount(chatScreen("chat-a"), async () => {
    await until(async () => dismissed(shown).length > 0, "the opened chat's push is dismissed")
  })
  assert.deepEqual(dismissed(shown), ["chat_input:gots-chat-a"])
})

test("opening a chat tells the account its subject is no news", async () => {
  browser()
  // A chat of this test's own: a subject already told is remembered for the session, so a second
  // screen about the same one would say nothing new.
  await seedChats([{ id: "chat-c" }], { bots: [bot] })
  const shown = trayOf([about("chat-c")])
  const calls = told()
  await mount(chatScreen("chat-c"), async () => {
    await until(async () => dismissed(shown).length > 0, "the opened chat's push is dismissed")
    await until(
      async () => dismissals(calls).length === 2,
      "the registry and the bot's plugin were both told",
    )
  })
  // No push protocol removes another device's notification, so the account is told and every
  // other device clears its own tray (ADR 0169).
  assert.deepEqual(
    dismissals(calls).map((one) => [one.url, one.body]),
    [
      ["/.netlify/functions/registry?route=dismiss", { session_id: "gots-chat-c" }],
      [`${pluginRoot(bot.baseUrl)}/push/dismiss`, { session_id: "gots-chat-c" }],
    ],
    "the thread on screen, and only that one: the other thread is still news",
  )
})
