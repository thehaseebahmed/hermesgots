/**
 * What the sidebar's Waiting for input section lists: every session that waits on the user, whatever
 * kind it is — a project's session, a plain chat, a canvas's chat — read from the one shared poll of
 * every bot's `runs/live`. The section is the one place a reader looks for what needs them, so a
 * session it leaves out is a session nobody answers.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { connectionKey, noteChange } from "@/lib/live"
import { db } from "@/lib/db"
import { readLiveRuns } from "@/lib/waiting"
import { markRead } from "@/lib/read-marks"

import {
  Path,
  botProfile,
  find,
  json,
  missing,
  mount,
  seedSettings,
  settle,
  until,
  wordsOf,
} from "./component-kit.tsx"

const bot = botProfile("bot-main", { id: "bot-1", name: "Mainly" })

/** A host whose `runs/live` answers what the test hands it, changeable while the app is open. */
function serveLive(answer: () => Record<string, unknown>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.114.0", features: ["canvas"] })
    if (url.pathname.endsWith("/plugins/gots/runs/live")) return json(answer())
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

async function seed() {
  await seedSettings({ activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.conversations.clear()
}

/** A conversation of the bot's, of any kind, whose Hermes session waits. */
async function seedSession(
  id: string,
  hermesSessionId: string,
  title: string,
  extra: Record<string, unknown> = {},
) {
  await db.conversations.put({
    id,
    profileId: bot.id,
    title,
    hermesSessionId,
    createdAt: 3,
    updatedAt: 4,
    changedAt: 3,
    ...extra,
  })
}

const sidebar = () => (
  <MemoryRouter initialEntries={["/"]}>
    <Path />
    <ConversationList />
  </MemoryRouter>
)

const waitingNav = () => find('nav[aria-labelledby="waiting-heading"]')
const botDot = () => find("[data-unread]")

test("a project session that waits on a question is listed in Waiting for input", async () => {
  await seed()
  serveLive(() => ({ waiting: { "gots-waiting-project": { kind: "question", count: 1 } } }))
  await seedSession("waiting-project", "gots-waiting-project", "A project session that waits", {
    projectId: "a-project",
  })
  await mount(sidebar(), async () => {
    await until(async () => Boolean(waitingNav()?.querySelector("a")), "the waiting row")
    assert.match(wordsOf(waitingNav()), /A project session that waits/)
  })
})

test("a side chat that waits on an approval is listed in Waiting for input", async () => {
  await seed()
  serveLive(() => ({
    waiting: { "gots-waiting-chat": { kind: "approval", command: "rm -rf build" } },
  }))
  await seedSession("waiting-chat", "gots-waiting-chat", "A chat that waits")
  await mount(sidebar(), async () => {
    await until(async () => Boolean(waitingNav()), "the waiting section")
    assert.match(wordsOf(waitingNav()), /A chat that waits/, "the chat is where the reader looks")
  })
})

test("a canvas chat that waits on a question is listed in Waiting for input", async () => {
  await seed()
  serveLive(() => ({ waiting: { "gots-waiting-canvas": { kind: "question", count: 2 } } }))
  await seedSession("waiting-canvas", "gots-waiting-canvas", "A canvas chat that waits", {
    canvasId: "p1",
  })
  await mount(sidebar(), async () => {
    await until(async () => Boolean(waitingNav()), "the waiting section")
    assert.match(wordsOf(waitingNav()), /A canvas chat that waits/, "the canvas chat is listed")
  })
})

test("a side chat that starts waiting while the app is open is listed, with no notification", async () => {
  await seed()
  let waiting: Record<string, unknown> = {}
  serveLive(() => ({ waiting }))
  await seedSession("waiting-live", "gots-waiting-live", "A chat that starts waiting")
  await mount(sidebar(), async () => {
    assert.ok(
      missing('nav[aria-labelledby="waiting-heading"]'),
      "nothing waits yet, so the section is not drawn",
    )
    // The host's run begins holding a question, and the events stream says runs changed: the app is
    // open, so no push reaches this device — the poll's own answer is what the sidebar reads.
    waiting = { "gots-waiting-live": { kind: "question", count: 1 } }
    await act(async () => noteChange(connectionKey(bot), "runs"))
    await until(async () => Boolean(waitingNav()?.querySelector("a")), "the waiting row")
    assert.match(wordsOf(waitingNav()), /A chat that starts waiting/)
  })
})

test("a session that starts waiting as another stops is listed, with no notification", async () => {
  await seed()
  let waiting: Record<string, unknown> = {
    "gots-waiting-a": { kind: "question", count: 1 },
  }
  serveLive(() => ({ waiting }))
  await seedSession("waiting-a", "gots-waiting-a", "The session that stops waiting", {
    projectId: "a-project",
  })
  await seedSession("waiting-b", "gots-waiting-b", "The session that starts waiting", {
    projectId: "a-project",
  })
  await mount(sidebar(), async () => {
    await until(async () => Boolean(waitingNav()?.querySelector("a")), "the first waiting row")
    assert.match(wordsOf(waitingNav()), /The session that stops waiting/)
    // One session is answered and another's run starts waiting, all while the app is open: the
    // section follows the poll's answer, not the rows it happened to read the first time.
    waiting = { "gots-waiting-b": { kind: "approval", command: "rm -rf build" } }
    await act(async () => noteChange(connectionKey(bot), "runs"))
    await until(
      async () => wordsOf(waitingNav()).includes("The session that starts waiting"),
      "the new waiting row",
    )
    assert.ok(
      !wordsOf(waitingNav()).includes("The session that stops waiting"),
      "the answered session is gone",
    )
  })
})

test("a run that ends while the app is open dots the bot's row", async () => {
  await seed()
  // This device has read the chat as of its last turn, so its row starts clear.
  markRead("chat-run", 4)
  let live: Record<string, unknown> = {
    sessions: { "gots-run-1": "running" },
    run_ids: { "gots-run-1": "run-1" },
  }
  serveLive(() => live)
  await seedSession("chat-run", "gots-run-1", "A chat whose run ends")
  await mount(sidebar(), async () => {
    await until(async () => Boolean(find('nav[aria-labelledby="bots-heading"] a')), "the bot's row")
    assert.ok(missing("[data-unread]"), "nothing new yet: the run is still in flight")
    // The run ends on the host and the stream says runs changed. No push reaches this device — the
    // app is open — so the bot row's own unread mark is what has to say the run is done.
    live = { sessions: {}, run_ids: {} }
    await act(async () => noteChange(connectionKey(bot), "runs"))
    await until(async () => Boolean(botDot()), "the bot row's unread dot")
  })
})

test("a project session's run that ends leaves the bot's row to Code's list (ADR 0110)", async () => {
  await seed()
  markRead("session-run", 4)
  let live: Record<string, unknown> = {
    sessions: { "gots-run-2": "running" },
    run_ids: { "gots-run-2": "run-2" },
  }
  serveLive(() => live)
  await seedSession("session-run", "gots-run-2", "A session whose run ends", {
    projectId: "a-project",
  })
  await mount(sidebar(), async () => {
    await until(async () => Boolean(find('nav[aria-labelledby="bots-heading"] a')), "the bot's row")
    live = { sessions: {}, run_ids: {} }
    await act(async () => noteChange(connectionKey(bot), "runs"))
    // A session is no thread of the bot's: its news is Code's row's, which reads the same clock
    // this move writes. Dotting the bot row for it would send the reader to Main for news Main
    // cannot draw, and tapping the row would not clear it (ADR 0110).
    await until(
      async () => (await db.conversations.get("session-run"))!.updatedAt > 4,
      "the clock moved",
    )
    assert.ok(missing("[data-unread]"), "the bot row stays clear of a session's news")
  })
})

test("a late answer from an older read is not read as a run that ended", async () => {
  await seed()
  markRead("chat-order", 4)
  // The host holds each read until the test lets it go, so the two can land in either order. The
  // shared poll's read is asked first and left before the run began, so it answers "nothing runs";
  // the fresh read asked while it is out sees the run in flight.
  const release: Array<() => void> = []
  let reads = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.114.0", features: ["canvas"] })
    if (url.pathname.endsWith("/plugins/gots/runs/live")) {
      reads += 1
      const asked = reads
      await new Promise<void>((done) => release.push(done))
      return json(asked === 1 ? { sessions: {} } : { sessions: { "gots-order-1": "running" } })
    }
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
  await seedSession("chat-order", "gots-order-1", "A chat whose run is in flight")
  await mount(sidebar(), async () => {
    await until(async () => Boolean(find('nav[aria-labelledby="bots-heading"] a')), "the bot's row")
    // Ask afresh, as a screen about to act on "no run" does, and let the newer answer land first:
    // the older one, arriving after it, is the stale half of the pair.
    const fresh = readLiveRuns({ baseUrl: bot.baseUrl, apiKey: bot.apiKey }, { join: false })
    await until(async () => release.length === 2, "both reads held at the host")
    await act(async () => {
      release[1]()
      release[0]()
    })
    await fresh
    await settle()
    // The run is in flight on the newer answer, so nothing ended: reading the older answer against
    // it would dot the bot's row for a run that is still working.
    assert.equal(
      (await db.conversations.get("chat-order"))!.updatedAt,
      4,
      "the stale answer moved no clock",
    )
    assert.ok(missing("[data-unread]"), "and the bot row holds no dot for it")
  })
})
