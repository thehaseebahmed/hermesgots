// A chat the user never renamed shows the title Hermes gave its session — the one the Hermes
// dashboard shows — however late it lands, and whichever way the app's change stream was going
// when it did. The app's own first-line title is a placeholder until the host's title arrives.
import { app, flow, mock, mockAuth, pass } from "./lib.mjs"

/** The host's title for a session, read the way the dashboard's own view of it is read. */
const hostTitle = async (sessionId) => {
  const found = await fetch(`${mock}/api/sessions/${encodeURIComponent(sessionId)}`, {
    headers: mockAuth,
  })
  return found.ok ? (await found.json()).session.title : undefined
}

/** Closes the open change streams and holds new ones back, as an app closed while changes landed. */
const holdEvents = (heldMs) =>
  fetch(`${mock}/__mock/events`, {
    method: "POST",
    headers: mockAuth,
    body: JSON.stringify({ held_ms: heldMs }),
  })

/** How long after a chat's opener Hermes's background title lands at the host. */
const titleDelay = (ms) =>
  fetch(`${mock}/__mock/title-delay`, {
    method: "POST",
    headers: mockAuth,
    body: JSON.stringify({ ms }),
  })

await flow("chat-title", async ({ page, send, lastReply, until, shot }) => {
  // The change stream this mock really opens (a `polling` mock answers its route with a 404).
  let streaming = false
  page.on("response", (response) => {
    if (/\/events(?:\?|$)/.test(response.url()) && response.status() === 200) streaming = true
  })
  const live = await until(() => streaming, 10_000, "the change stream").then(
    () => true,
    () => false,
  )
  await titleDelay(2000)

  /** A fresh chat with the message sent: its id, its Hermes session, its reply finished. */
  const opener = async (text) => {
    // A chat of its own, made here rather than sent into whichever one the app restored.
    const chatId = await page.evaluate(async () => {
      const { createConversation, db } = await import("/src/lib/db.ts")
      const profile = (await db.profiles.toArray())[0]
      return (await createConversation(profile.id)).id
    })
    await page.goto(`${app}/c/${chatId}`)
    await send(text)
    await until(async () => (await lastReply(chatId))?.status === "done", 25_000, "the reply")
    const sessionId = await page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      return (await db.conversations.get(id))?.hermesSessionId
    }, chatId)
    return { chatId, sessionId }
  }
  /** What the app holds for the chat, as every list and header draws it. */
  const appTitle = (chatId) =>
    page.evaluate(
      async (id) =>
        (await import("/src/lib/db.ts")).db.conversations.get(id).then((found) => found?.title),
      chatId,
    )
  /** The host titles the session, then the app takes the title it holds. */
  const settlesOn = async (chatId, sessionId, expected, what, waitMs = 15_000) => {
    await until(
      async () => (await hostTitle(sessionId)) === expected,
      waitMs,
      `the host to title the session (${what})`,
    )
    await until(
      async () => (await appTitle(chatId)) === expected,
      20_000,
      `the app to take the host's title (${what})`,
    )
  }

  // A title that lands a moment after the opener: the stream's `title` event where there is one,
  // the checks the turn leaves behind where there aren't.
  {
    const { chatId, sessionId } = await opener(
      "please explain how the queue drains while a bot is offline",
    )
    await settlesOn(chatId, sessionId, "Please explain how the", "a title that lands a moment later")
    pass("the host's title lands and the app takes it")
  }

  // A title that lands after the turn's early checks are over: a change stream still carries its
  // event, and a host without one is met by the checks reaching further out.
  await titleDelay(25_000)
  {
    const { chatId, sessionId } = await opener(
      "walk me through how the outbox drains a queued message",
    )
    await titleDelay(2000)
    await settlesOn(chatId, sessionId, "Walk me through how", "a title that lands late", 40_000)
    pass("a title that lands late still reaches the app")
  }

  // The change stream is closed when the title lands and stays so past it — the app closed right
  // after sending. The host noted the change where its watcher saw it, so the stream that opens
  // again replays it from the cursor, and the checks the turn leaves behind reach the landing
  // either way. Neither one alone was enough before: the event was sent live-only, and the checks
  // looked for ten seconds.
  await titleDelay(25_000)
  const away = await opener("summarise how reconnection picks up a missed title event")
  await titleDelay(2000)
  const landed = "Summarise how reconnection picks"
  if (live) {
    // Away before the landing, and still away past it: no stream is listening when it fires.
    streaming = false
    await holdEvents(45_000)
  }
  await until(
    async () => (await hostTitle(away.sessionId)) === landed,
    40_000,
    "the host to title the session",
  )
  if (live) await until(() => streaming, 60_000, "the change stream to open again")
  await until(
    async () => (await appTitle(away.chatId)) === landed,
    20_000,
    "the app to take the host's title after the stream was closed when it landed",
  )
  pass("a title that landed while the app was closed still reaches it")
  await shot("after")
})
