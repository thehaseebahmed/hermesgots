/**
 * A chat switched into the pane lands with its final content in place. The scroller that draws it is
 * the chat's own, it has placed nothing before that chat's content is whole — Main's thread cards
 * included — and the one move it makes goes to the end of that content. Nothing lands after it, so a
 * switch never scrolls the reader and never scrolls under their thumb.
 *
 * A DOM has no layout (ADR 0019), so this test hands the scroller the box a browser would report and
 * reads the order of the moves it asked for; what a real browser's geometry does is the browser
 * proof's to say.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { mainThreadId } from "@/lib/db"
import { forgetHeldChats } from "@/lib/chat-hold"
import {
  botProfile,
  click,
  find,
  mount,
  path,
  phone,
  seedChats,
  settle,
  text,
  until,
} from "./component-kit.tsx"

const first = botProfile("switch-scroll-first", { id: "bot-1", name: "First" })
const second = botProfile("switch-scroll-second", { id: "bot-2", name: "Second" })
const MAIN_A = mainThreadId(first.id)
const MAIN_B = mainThreadId(second.id)

const SAID_A = ["alpha one", "alpha two"]
const SAID_B = ["beta one", "beta two", "beta three", "beta four"]

const HOUR = 3_600_000
const MIDNIGHT = new Date().setHours(0, 0, 0, 0)
const at = (hours: number) => MIDNIGHT + hours * HOUR

/** Two bots' Main threads, each with its own messages and its own threads drawn as cards. */
const seed = () =>
  seedChats(
    [
      {
        id: MAIN_A,
        profileId: first.id,
        title: "Main",
        main: true,
        messages: SAID_A.map((content, index) => ({
          id: `a-${index}`,
          content,
          at: at(9 + index),
        })),
      },
      {
        id: MAIN_B,
        profileId: second.id,
        title: "Main",
        main: true,
        messages: SAID_B.map((content, index) => ({
          id: `b-${index}`,
          content,
          at: at(9 + index),
        })),
      },
      {
        id: "t-a1",
        profileId: first.id,
        at: at(1),
        messages: [{ id: "ta-1", content: "the first thread's opener", at: at(1) }],
      },
      {
        id: "t-a2",
        profileId: first.id,
        at: at(2),
        messages: [{ id: "ta-2", content: "the second thread's opener", at: at(2) }],
      },
      {
        id: "t-b1",
        profileId: second.id,
        at: at(3),
        messages: [{ id: "tb-1", content: "the other bot's thread", at: at(3) }],
      },
    ],
    { bots: [first, second], active: first.id, botThreads: true },
  )

/** The box a browser would report: a viewport, and a row for each thing the content holds. */
const VIEWPORT = 720
const ROW = 120

const slot = (element: Element | null) => element?.getAttribute("data-slot")

const contentIn = (element: Element) =>
  slot(element) === "message-scroller-content"
    ? element
    : element.querySelector('[data-slot="message-scroller-content"]')

/**
 * How many rows the content is worth. Every block the app draws into it stamps its own slot — a
 * message row, a thread card, a day heading — and the primitive's own filler stamps none, so reading
 * the app's contract counts the content without reaching into the vendor's.
 */
const rowsIn = (element: Element) => {
  const content = contentIn(element)
  if (!content) return 0
  return [...content.children].filter((child) => child.hasAttribute("data-slot")).length
}

interface Move {
  element: Element
  top: number
  rows: number
  cards: number
  messages: string[]
}

const isViewport = (element: Element) => slot(element) === "message-scroller-viewport"

/**
 * What the primitive actually does to the box: it calls `scrollTo` for a position far from where it
 * is, and writes `scrollTop` for one it is already at. Both are recorded — but only a write that
 * changes the position is a move, since being told to stay put is not being scrolled.
 */
function spyScroller() {
  let moves: Move[] = []
  let records: MutationRecord[] = []
  let batches: MutationRecord[][] = []
  const proto = Element.prototype
  const height = Object.getOwnPropertyDescriptor(proto, "scrollHeight")!
  const client = Object.getOwnPropertyDescriptor(proto, "clientHeight")!
  const top = Object.getOwnPropertyDescriptor(proto, "scrollTop")!
  const html = HTMLElement.prototype as unknown as { scrollTo?: unknown }
  const hadScrollTo = "scrollTo" in html
  const hostScrollTo = html.scrollTo

  const look = (element: Element, value: number) =>
    moves.push({
      element,
      top: value,
      rows: rowsIn(element),
      cards: element.querySelectorAll('[data-slot="thread-card"]').length,
      messages: [...element.querySelectorAll("[data-message-id]")].map(
        (one) => one.getAttribute("data-message-id") ?? "",
      ),
    })

  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: Element) {
      if (slot(this) === "message-scroller-content") return rowsIn(this) * ROW
      if (isViewport(this)) return VIEWPORT + rowsIn(this) * ROW
      return height.get!.call(this)
    },
  })
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: Element) {
      if (isViewport(this)) return VIEWPORT
      return client.get!.call(this)
    },
  })
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    enumerable: top.enumerable,
    get: top.get,
    set(this: Element, value: number) {
      if (top.get!.call(this) !== value) look(this, value)
      top.set!.call(this, value)
    },
  })
  html.scrollTo = function (this: Element, options?: ScrollToOptions) {
    const value = Math.max(0, options?.top ?? 0)
    if (top.get!.call(this) !== value) look(this, value)
    top.set!.call(this, value)
  }

  const observer = new MutationObserver((batch) => {
    records.push(...batch)
    batches.push(batch)
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-pending-scroll"],
    attributeOldValue: true,
  })

  return {
    /** Everything from here on is the switch's. */
    arm() {
      observer.takeRecords()
      moves = []
      records = []
      batches = []
    },
    read() {
      const late = observer.takeRecords()
      records.push(...late)
      if (late.length) batches.push(late)
      return { moves, records, batches }
    },
    restore() {
      observer.disconnect()
      Object.defineProperty(proto, "scrollHeight", height)
      Object.defineProperty(proto, "clientHeight", client)
      Object.defineProperty(proto, "scrollTop", top)
      if (hadScrollTo) html.scrollTo = hostScrollTo
      else delete html.scrollTo
    },
  }
}

const viewport = () => find('[data-slot="message-scroller-viewport"]')

/** Lets the frames the scroller schedules run, so a move it makes later is not read as none. */
const frames = (count: number) =>
  act(async () => {
    for (let frame = 0; frame < count; frame += 1)
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  })

/** Whether a record brought an element matching `of` into the document. */
const added = (record: MutationRecord, of: (node: Element) => boolean) =>
  record.type === "childList" &&
  [...record.addedNodes].some((node) => node instanceof Element && of(node))

/** A node that is a message row, or the block holding them, carrying one of the chat's words. */
const bringsWords = (node: Element, said: string[]) =>
  (node.matches("[data-message-id]") || Boolean(node.querySelector("[data-message-id]"))) &&
  said.some((words) => node.textContent?.includes(words))

/** A node that is a thread card, or the block holding one. */
const bringsCards = (node: Element) =>
  slot(node) === "thread-card" || Boolean(node.querySelector('[data-slot="thread-card"]'))

test("a chat switched to in place is drawn by its own scroller, and placed once at its end", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seed()
  const scroller = spyScroller()
  try {
    await mount(phone(`/c/${MAIN_A}`, `/c/${MAIN_B}`), async () => {
      await until(async () => text().includes(SAID_A[1]), "the chat on screen")
      await settle()
      const outgoing = viewport()
      assert.ok(outgoing, "the chat on screen has a scroller")
      scroller.arm()

      await click(find("[data-switch]"))
      await until(async () => text().includes(SAID_B[3]), "the chat asked for")
      await settle()
      await frames(3)

      const landed = viewport()
      assert.ok(landed, "the chat asked for has a scroller")
      assert.equal(path(), `/c/${MAIN_B}`)
      assert.notEqual(
        landed,
        outgoing,
        "a switched-in chat is drawn by a scroller of its own, not the one that showed the chat left",
      )

      const { moves, records, batches } = scroller.read()

      assert.deepEqual(
        moves.filter((move) => move.element !== landed).map((move) => move.top),
        [],
        "nothing else on screen is scrolled by the switch",
      )

      const mine = moves.filter((move) => move.element === landed)
      assert.equal(
        mine.length,
        1,
        `the chat is moved once during the switch, not ${mine.length} times: ${JSON.stringify(mine.map((move) => move.top))}`,
      )
      assert.equal(
        mine[0].top,
        mine[0].rows * ROW,
        "and the one move goes to the end of the content it holds",
      )
      assert.deepEqual(
        [...mine[0].messages].sort(),
        ["b-0", "b-1", "b-2", "b-3"],
        "and it is moved with every one of its messages already in place",
      )
      assert.equal(
        mine[0].cards,
        1,
        "and with Main's thread cards in the same frame: the thread list is part of what a chat waits for",
      )

      const arrivals = records
        .map((record, place) => (added(record, (node) => bringsWords(node, SAID_B)) ? place : -1))
        .filter((place) => place >= 0)
      assert.ok(arrivals.length > 0, "the chat's content landed")
      const carrying = batches.find((batch) =>
        batch.some((record) => added(record, (node) => bringsWords(node, SAID_B))),
      )
      assert.ok(
        carrying?.some((record) => added(record, bringsCards)),
        "the frame that first carries the chat's content already carries its cards",
      )

      const placed = records.filter(
        (record) =>
          record.type === "attributes" &&
          record.attributeName === "data-pending-scroll" &&
          isViewport(record.target as Element),
      )
      assert.equal(
        placed.length,
        1,
        "the scroller places the chat's content once, not once per thing that arrives",
      )
      const placedAt = records.indexOf(placed[0])
      assert.ok(
        arrivals.some((one) => one < placedAt),
        "the content is whole before the scroller places it",
      )
      assert.deepEqual(
        arrivals.filter((one) => one > placedAt),
        [],
        "and nothing lands after the first scroll",
      )
    })
  } finally {
    scroller.restore()
  }
})
