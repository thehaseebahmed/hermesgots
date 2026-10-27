// A chat the user never renamed shows the title Hermes gave its session — the one the Hermes
// dashboard shows — however late it lands, and whichever way the app's change stream was going
// when it did. The app's own first-line title is a placeholder until the host's title arrives.
import { assert, eventsUrl, flow, mock, mockAuth, mockPost, pass } from "./lib.mjs"

/** The chat's own record on the host, the read a title comes from. */
const sessionRead = /\/api\/sessions\/[^/?]+(?:\?.*)?$/

/** The host's title for a session, read the way the dashboard's own view of it is read. */
const hostTitle = async (sessionId) => {
  const found = await fetch(`${mock}/api/sessions/${encodeURIComponent(sessionId)}`, {
    headers: mockAuth,
  })
  return found.ok ? (await found.json()).session.title : undefined
}

/** How long after a chat's opener Hermes's background title lands at the host. */
const titleDelay = (ms) => mockPost("/__mock/title-delay", { ms })

await flow("chat-title", async ({ page, send, lastReply, newChat, until, shot }) => {
  // Whether this host streams its changes at all — the same list the app reads to decide whether
  // to listen; a `polling` lane's mock answers /events with nothing and says so here.
  const info = await (await fetch(`${mock}/api/plugins/memento/info`, { headers: mockAuth })).json()
  const live = Boolean(info?.features?.includes("events"))

  let streaming = false
  page.on("response", (response) => {
    if (eventsUrl.test(response.url()) && response.status() === 200) streaming = true
  })

  /** What the app holds for the chat, as every list and header draws it. */
  const appTitle = (chatId) =>
    page.evaluate(
      async (id) =>
        (await import("/src/lib/db.ts")).db.conversations.get(id).then((found) => found?.title),
      chatId,
    )
  /** A chat of its own with the message sent: its id, its session, and the reply finished. */
  const opener = async (text) => {
    const chatId = await newChat()
    await send(text)
    await until(async () => (await lastReply(chatId))?.status === "done", 25_000, "the reply")
    const sessionId = await page.evaluate(async (id) => {
      const { db } = await import("/src/lib/db.ts")
      return (await db.conversations.get(id))?.hermesSessionId
    }, chatId)
    return { chatId, sessionId }
  }
  /** The host titles the session, then the chat shows the title it gave it. */
  const settlesOn = async (chatId, sessionId, expected, what) => {
    await until(
      async () => (await hostTitle(sessionId)) === expected,
      40_000,
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
  const first = await opener("please explain how the queue drains while a bot is offline")
  if (live) await until(() => streaming, 15_000, "the change stream to open")
  const soon = "Please explain how the"
  await settlesOn(first.chatId, first.sessionId, soon, "a title that lands soon")
  pass("the host's title lands and the app takes it")

  // A title that lands after the turn's early checks are over: a change stream still carries its
  // event, and a host without one is met by the checks reaching further out.
  await titleDelay(25_000)
  const late = await opener("walk me through how the outbox drains a queued message")
  await settlesOn(late.chatId, late.sessionId, "Walk me through how", "a title that lands late")
  pass("a title that lands late still reaches the app")

  // A title that lands while nothing is listening: the connection dies right after the reply and
  // the next one is held back past the landing, as an app put away stays away. The host noted the
  // change, so the stream that opens again replays it from the app's own cursor — a title sent
  // only to the streams open when it fires is lost here, and the checks the turn left behind are
  // held off too, so the replay is the one thing that can carry it.
  await titleDelay(25_000)
  const away = await opener("summarise how reconnection picks up a missed title event")
  const landed = "Summarise how reconnection picks"
  const placeholder = await appTitle(away.chatId)
  assert.notEqual(placeholder, landed, "the title landed before the app could be away for it")
  if (live) {
    const held = []
    const reads = []
    await page.route(eventsUrl, (route) => void held.push(route))
    await page.route(sessionRead, (route) => void reads.push(route))
    await mockPost("/__mock/events")
    await until(() => held.length > 0, 15_000, "the app's next stream, held back")
    await until(
      async () => (await hostTitle(away.sessionId)) === landed,
      40_000,
      "the host to title the session",
    )
    assert.equal(await appTitle(away.chatId), placeholder, "nothing carried the title yet")
    // The checks of the turn are spent, not answered: a read they are waiting on fails as the
    // stream opens, so the title arrives down the stream or not at all.
    for (const route of reads.splice(0)) await route.abort().catch(() => {})
    await page.unroute(sessionRead)
    for (const route of held.splice(0)) await route.continue().catch(() => {})
    await until(
      async () => (await appTitle(away.chatId)) === landed,
      10_000,
      "the app to take the title the stream carried back",
    )
    pass("a title that landed while nothing listened reaches the app when it listens again")
  } else {
    pass("no change stream to close here: this host's checks were what the late title proved")
  }
  await shot("after")
})
