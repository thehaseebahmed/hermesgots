/**
 * A chat is opened on its newest page, which is drawn at once; the older pages are read after it and
 * go above what is drawn until the chat is whole (ADR 0065). The host can hold a page back, so a
 * test sees the screen between the pages.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { PAGE } from "@/chat-next/pages"
import { botProfile, chatScreen, findAll, mount, seedChats } from "./component-kit.tsx"
import { eventually, openDevice, showsEverything, wait, withDevice } from "./chat-next-devices.tsx"
import { fakeHost } from "./chat-next-host.ts"

/** Thirty turns of six rows each: 180 rows, so four pages (50, 50, 50 and a short 30). */
const LONG = Array.from({ length: 30 }, (_, at) => ({
  user: `question ${at}`,
  tools: 2,
  reply: `answer ${at}`,
}))
const PAGES = [0, PAGE, 2 * PAGE, 3 * PAGE]

test("the newest page is drawn before an older one is served, with the loader while pages are read", async () => {
  const host = fakeHost("memento-first")
  host.seed(LONG)
  const second = host.hold(PAGE)
  await withDevice(openDevice(host), async (device) => {
    await eventually(() => assert.ok(device.turns().length > 0), "the first page is drawn")
    assert.deepEqual(
      host.offsets.filter((at) => at > 0),
      [PAGE],
      "the second page is asked for and held back",
    )
    assert.equal(device.older(), "reading", "the loader shows while a page is being read")
    const drawn = device.turns()
    // The first page is rows 131..180: it opens on the last two rows of turn 21, whose request is
    // in a page not read yet, so that reply is drawn alone.
    assert.deepEqual(drawn[0], {
      user: "",
      texts: ["answer 21"],
      tools: 0,
      asks: [],
      agents: [],
      seams: 0,
    })
    assert.deepEqual(drawn.slice(1), host.view().slice(22), "every turn after it is whole")
    assert.ok(device.composer(), "and the chat can be written to meanwhile")

    second.release()
    await showsEverything(device, host, "every turn once the older pages are in")
    await eventually(() => assert.equal(device.older(), undefined), "the loader goes when done")
    assert.deepEqual([...new Set(host.offsets)], PAGES, "one page after another, newest first")
  })
})

test("older pages go above the turns drawn without replacing them", async () => {
  const host = fakeHost("memento-above")
  host.seed(LONG)
  const second = host.hold(PAGE)
  await withDevice(openDevice(host), async (device) => {
    await eventually(() => assert.ok(device.turns().length > 0), "the first page is drawn")
    const before = device.sections()
    const newest = before.at(-1)!
    assert.ok(before.length < 30)
    second.release()
    await showsEverything(device, host, "the whole chat")
    const after = device.sections()
    assert.equal(after.at(-1), newest, "the newest turn is the very element it was")
    assert.deepEqual(
      after.slice(-before.length + 1),
      before.slice(1),
      "and so is each one above it",
    )
  })
})

test("the loader is never shown while nothing is read: a chat of one page, or one that is whole", async () => {
  const short = fakeHost("memento-short")
  short.seed(LONG.slice(0, 5))
  await withDevice(openDevice(short), async (device) => {
    await showsEverything(device, short, "a chat that fits the first page")
    assert.equal(device.older(), undefined)
    await wait(100)
    assert.equal(device.older(), undefined)
    assert.deepEqual(
      short.offsets.filter((at) => at > 0),
      [],
      "no older page is asked for",
    )
  })

  const host = fakeHost("memento-whole")
  host.seed(LONG)
  const shown: (string | undefined)[] = []
  await withDevice(openDevice(host), async (device) => {
    // Sampled at every step, so a loader drawn between two pages would be caught.
    for (let tries = 0; tries < 80; tries++) {
      shown.push(device.older())
      if (new Set(host.offsets).size >= 4 && device.older() === undefined) break
      await wait(5)
    }
    await showsEverything(device, host, "the whole chat")
    for (let tries = 0; tries < 10; tries++) {
      assert.equal(device.older(), undefined, "nothing is read, so nothing shows")
      await wait(10)
    }
  })
  assert.ok(shown.every((one) => one === "reading" || one === undefined))
  assert.equal(
    shown.lastIndexOf("reading") < shown.length - 1,
    true,
    "it went when the last page landed",
  )
})

test("a thread the device holds, that has not moved, costs the one page", async () => {
  const host = fakeHost("memento-held")
  host.seed(LONG)
  const first = await openDevice(host)
  const database = first.database
  await showsEverything(first, host, "the whole chat")
  await eventually(() => assert.equal(first.older(), undefined), "read to the start")
  await first.close()

  host.offsets.length = 0
  await withDevice(openDevice(host, { database }), async (device) => {
    await showsEverything(device, host, "drawn from the device")
    await wait(150)
    assert.equal(device.older(), undefined, "the chat is whole, so no loader")
    assert.ok(host.offsets.length > 0)
    assert.deepEqual(
      [...new Set(host.offsets)],
      [0],
      "only the newest page is asked for, at each poll",
    )
  })
})

test("a thread left unfinished picks up where it stopped, from the rows the device holds", async () => {
  const host = fakeHost("memento-resume")
  host.seed(LONG)
  const third = host.hold(2 * PAGE)
  const first = await openDevice(host)
  const { database } = first
  await eventually(
    () => assert.ok(host.offsets.includes(2 * PAGE), "the third page is asked for"),
    "the third page is in flight",
  )
  assert.equal(first.older(), "reading")
  // The reader leaves with the page still on its way, and it lands after the page is gone.
  await first.close()
  third.release()
  await wait(50)
  assert.equal(await database.sessionRows.count(), 2 * PAGE, "it was not written for nobody")
  assert.equal((await database.sessionStates.get(host.session))?.partial, true)

  host.offsets.length = 0
  await withDevice(openDevice(host, { database }), async (device) => {
    await showsEverything(device, host, "the whole chat")
    await eventually(() => assert.equal(device.older(), undefined), "and nothing left to read")
    assert.deepEqual(
      [...new Set(host.offsets.filter((at) => at > 0))],
      [2 * PAGE, 3 * PAGE],
      "only the pages the device lacked were read",
    )
  })
  assert.equal((await database.sessionStates.get(host.session))?.partial, undefined)
})

test("a page that fails leaves the thread as drawn, and is read again only when asked", async () => {
  const host = fakeHost("memento-fail")
  host.seed(LONG)
  const broken = host.fail(2 * PAGE)
  await withDevice(openDevice(host), async (device) => {
    await eventually(() => assert.equal(device.older(), "failed"), "the failure is said")
    // The page before the failing one is written to the device as it lands, and drawn from there.
    await wait(100)
    const drawn = device.turns()
    assert.ok(drawn.length > 8 && drawn.length < 30, "what was read is still drawn")
    assert.equal(host.offsets.filter((at) => at === 2 * PAGE).length, 1)
    // Polls go on, and none of them blanks the chat or asks for the failed page again.
    await wait(200)
    assert.equal(device.older(), "failed")
    assert.equal(host.offsets.filter((at) => at === 2 * PAGE).length, 1, "not read by itself")
    assert.deepEqual(device.turns(), drawn)
    assert.equal(document.querySelector('[role="alert"]'), null, "and the chat is not failed")

    broken.fix()
    await device.retryOlder()
    await showsEverything(device, host, "the whole chat")
    await eventually(() => assert.equal(device.older(), undefined), "the failure is gone")
    assert.equal(
      host.offsets.filter((at) => at === 2 * PAGE).length,
      2,
      "read once more, from the page that failed",
    )
  })
})

test("a page that fails while the chat is held back does not stop the newest page being drawn", async () => {
  const host = fakeHost("memento-fail-first-ok")
  host.seed(LONG)
  host.fail(PAGE)
  await withDevice(openDevice(host), async (device) => {
    await eventually(() => assert.equal(device.older(), "failed"), "the failure is said")
    await eventually(
      () => assert.deepEqual(device.turns().slice(1), host.view().slice(22)),
      "the newest page stays drawn",
    )
  })
})

test("the app's rows keep their ids while older turns are added above, which is what holds the reader's place", async () => {
  await seedChats([{ id: "c-older", title: "Long chat" }], {
    bots: [{ ...botProfile("hermes"), baseUrl: "http://c-older.test/v1" }],
    settings: { chatNext: true },
  })
  const host = fakeHost("memento-c-older")
  host.seed(LONG)
  const second = host.hold(PAGE)
  const ids = () =>
    findAll("[data-chat-next] [data-message-id]").map((one) => one.getAttribute("data-message-id")!)
  await mount(chatScreen("c-older"), async () => {
    await eventually(() => assert.ok(ids().length > 0), "the newest page is drawn")
    const newest = ids()
    assert.ok(
      document.querySelector('[data-older="reading"]'),
      "the loader is over the scroller while it reads",
    )
    assert.equal(
      document.querySelector('[data-slot="message-scroller-content"] [data-older]'),
      null,
      "and not in its flow, where adding or taking it away would move the thread",
    )
    second.release()
    await eventually(() => assert.equal(ids().length > newest.length, true), "older turns arrive")
    await eventually(
      () => assert.equal(document.querySelector("[data-older]"), null),
      "loader gone",
    )
    assert.deepEqual(
      ids().slice(-newest.length),
      newest,
      "the newest rows are drawn under the very ids they had",
    )
  })
})

test("a thread whose first read is still out says it is catching up, and stops when rows land", async () => {
  const host = fakeHost("memento-catching")
  host.seed(LONG)
  const first = host.hold(0)
  await withDevice(openDevice(host), async (device) => {
    await eventually(
      () => assert.ok(host.offsets.includes(0), "the newest page is asked for"),
      "the first page is in flight",
    )
    assert.equal(device.catching(), true, "nothing is drawn yet, and it says why")
    first.release()
    await showsEverything(device, host, "the whole chat")
    assert.equal(device.catching(), false, "it stops once the rows are in")
  })
})
