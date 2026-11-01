/**
 * A bot's Main on chat-next (ADR 0065, ADR 0029): under the bot's name and its count of threads,
 * with its threads as cards in its flow, every message it sends asked of the host's triage first —
 * one the host sends to a thread leaving Main for that thread, one it keeps posted to Main — and a
 * thread of it leading back to it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { db, mainThreadId } from "@/lib/db"
import { ChatPage } from "@/routes/chat"
import { fakeHost } from "./chat-next-host.ts"
import {
  botProfile,
  click,
  composerField,
  find,
  findAll,
  mount,
  Path,
  path,
  sendPress,
  seedChats,
  settle,
  type,
} from "./component-kit.tsx"

/** Waits on the screen as a person would: the real screen polls at its real pace, so up to 6s. */
async function until(check: () => boolean, what: string) {
  const by = Date.now() + 6_000
  while (!check() && Date.now() < by) {
    await settle()
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)))
  }
  assert.ok(check(), what)
}

const requests = () =>
  findAll('[data-chat-next] [data-message-id$="-u"] [data-slot="bubble-content"]').map(
    (one) => one.textContent ?? "",
  )

const screen = (id: string) => (
  <MemoryRouter initialEntries={[`/c/${id}`]}>
    <Path />
    <Routes>
      <Route path="/c/:id" element={<ChatPage slot="route" />} />
    </Routes>
  </MemoryRouter>
)

/** A bot with its Main and one thread, on chat-next, with bot threads on. */
async function seedMain(name: string) {
  const bot = botProfile(name, { name: "Tri", baseUrl: `http://${name}.test/v1` })
  const main = mainThreadId(bot.id)
  await seedChats(
    [
      { id: main, title: "Main", main: true, at: 1 },
      { id: `${name}-t1`, title: "Trip to Lisbon", at: 2 },
    ],
    { bots: [bot], botThreads: true, settings: { chatNext: true } },
  )
  // The thread has been sent in, as one triage or a /thread made would have.
  await db.conversations.update(`${name}-t1`, { updatedAt: 5 })
  return { bot, main, thread: `${name}-t1`, host: fakeHost(`memento-${main}`, { plugin: true }) }
}

async function sendFromComposer(text: string) {
  await until(() => Boolean(composerField()), "the app's composer is drawn")
  await type(composerField(), text)
  await click(find('button[aria-label="Send"]'))
}

test("Main opens on chat-next under the bot's name, with its threads as cards in its flow", async () => {
  const { main, host } = await seedMain("main-chrome")
  host.seed([{ user: "Morning", reply: "Morning to you." }])
  await mount(screen(main), async () => {
    await until(() => requests().includes("Morning"), "Main's own turn is drawn")
    assert.ok(find("[data-chat-next]"), "on chat-next")
    assert.equal(find('[data-slot="header-title"]')?.textContent?.trim(), "Tri")
    assert.match(find("[data-chat-next] header")?.textContent ?? "", /1 thread/)
    assert.match(
      find('[data-chat-next] [data-slot="thread-card"]')?.textContent ?? "",
      /Trip to Lisbon/,
      "the bot's thread is a card in Main's flow",
    )
  })
})

test("a message the host sends to a thread leaves Main, and nothing is posted to Main", async () => {
  const { main, thread, host } = await seedMain("main-moved")
  host.triage.decision = "thread"
  host.triage.thread = thread
  host.triage.moves = [
    { id: "m1", text: "Book the flights", thread, at: Date.now(), new: false, undoable: true },
  ]
  await mount(screen(main), async () => {
    await sendFromComposer("Book the flights")
    await until(() => host.triage.asked.length === 1, "the host was asked where it belongs")
    assert.equal(host.triage.asked[0].text, "Book the flights")
    await until(
      () => /Moved to “Trip to Lisbon”/.test(find("[data-chat-next]")?.textContent ?? ""),
      "Main marks where the message left, naming its thread",
    )
    assert.deepEqual(requests(), [], "and draws it as no request of its own")
    assert.equal(host.asked.runs, 0, "nothing was started on Main")
    assert.equal(composerField()?.value, "", "and the words aren't handed back")
  })
})

test("a message the host keeps in Main is posted to Main, as any send is", async () => {
  const { main, host } = await seedMain("main-stays")
  await mount(screen(main), async () => {
    await sendFromComposer("What's the weather?")
    await until(() => host.asked.runs === 1, "the turn was posted")
    assert.equal(host.triage.asked.length, 1, "after the host was asked")
    assert.equal(host.latest.body?.session_id, `memento-${main}`, "on Main's own session")
    await until(() => requests().includes("What's the weather?"), "and drawn as Main's request")
  })
})

test("/thread from Main starts a thread with the message as its first turn", async () => {
  const { main, host } = await seedMain("main-slash")
  await mount(screen(main), async () => {
    await until(() => Boolean(composerField()), "the app's composer is drawn")
    await type(composerField(), "/thread Plan the itinerary")
    await sendPress()
    await until(() => host.asked.runs === 1, "the thread's first turn was posted")
    const made = (await db.conversations.toArray()).find(
      (one) => !one.main && one.id !== "main-slash-t1",
    )
    assert.ok(made, "a thread was made")
    assert.equal(path(), `/c/${made.id}`, "and opened")
    assert.equal(host.latest.body?.session_id, made.hermesSessionId, "on the thread's own session")
    assert.equal(host.triage.asked.length, 0, "a thread's message is never triaged")
  })
})

test("a thread of Main leads back to it", async () => {
  const { main, thread } = await seedMain("main-back")
  fakeHost(`memento-${thread}`, { plugin: true })
  await mount(screen(thread), async () => {
    await until(() => Boolean(find('[aria-label="Back to Tri"]')), "the thread leads back")
    await click(find('[aria-label="Back to Tri"]'))
    await until(() => path() === `/c/${main}`, "to its bot's Main")
  })
})

test("mid-reply too, a Main message the host sends to a thread is neither queued nor steered", async () => {
  const { main, thread, host } = await seedMain("main-mid")
  await mount(screen(main), async () => {
    await sendFromComposer("Write me a poem")
    await until(() => Boolean(find('button[aria-label="Stop"]')), "Main's reply is running")
    host.triage.decision = "thread"
    host.triage.thread = thread
    await type(composerField(), "Also book the flights")
    await sendPress()
    await until(() => host.triage.asked.length === 2, "the host was asked about it as well")
    assert.equal(host.triage.asked[1].text, "Also book the flights")
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)))
    assert.equal(host.queue.length, 0, "nothing waits on Main's queue")
    assert.equal(
      host.rows.some((row) => row.display_kind === "steer"),
      false,
      "and Main's reply wasn't steered",
    )
  })
})
