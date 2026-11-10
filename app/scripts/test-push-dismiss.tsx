/** What the device's tray keeps when the app opens: only the screen a push is about answers it. */
import assert from "node:assert/strict"
import test from "node:test"

import { startPush } from "@/lib/push"
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
