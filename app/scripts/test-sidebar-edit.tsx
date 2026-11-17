/**
 * The sidebar's edit mode as a reader opens and leaves it, and as they arrange it: the header's
 * button is the switch, Escape gives the button and the links back, a row in the mode is no link, a
 * row can be put away and brought back, and a row can be moved by its own controls — each press
 * writing the account's record and saying what it did.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act, useEffect, useState } from "react"
import { MemoryRouter } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { CANVAS_UNREACHABLE, useCanvasStore } from "@/lib/canvases"
import { adoptAppearance, db, getSettings } from "@/lib/db"
import { DEFAULT_SIDEBAR_LAYOUT } from "@/lib/sidebar-layout"
import { syncedAppearance } from "@/lib/sync"

import {
  Path,
  botProfile,
  click,
  find,
  findAll,
  json,
  missing,
  mount,
  path,
  seedSettings,
  settle,
  until,
  withToasts,
  wordsOf,
} from "./component-kit.tsx"

const bot = botProfile("bot-main", { id: "bot-1", name: "Mainly" })

/**
 * The canvas the reader pinned to the sidebar, as its bot's plugin lists it: the row's mark, its
 * title and its clock — no page, since a pin is a row and not an open.
 */
const PINNED = {
  id: "p1",
  title: "A pinned timetable",
  session_id: "gots-chat-p1",
  chat_id: "chat-p1",
  version: 2,
  pinned: true,
  archived: false,
  at: 20,
  created_at: 1,
  tools: [],
}

/** The bot's plugin, as far as the sidebar's pins are read: its features, and the list it holds. */
function servePinned() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.114.0", features: ["canvas"] })
    if (url.pathname.endsWith("/canvases"))
      return json({ object: "gots.canvases", canvases: [PINNED] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

/** A device with one bot, every lab switch on, and the canvas the reader pinned on its sidebar. */
async function seed() {
  await seedSettings({ activeProfileId: bot.id, meetings: true, appearanceAt: 0 })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.conversations.clear()
  servePinned()
}

const sidebar = () => (
  <MemoryRouter initialEntries={["/"]}>
    <Path />
    <ConversationList />
  </MemoryRouter>
)

/** The header's switch, by the words its name says at rest. */
const editButton = () => find('button[aria-label="Edit sidebar"]')
/** The same switch, named for what its press does while the mode is open. */
const doneButton = () => find('button[aria-label="Done editing sidebar"]')
/** The mode itself: the group the sidebar's own state opens. */
const group = () => find('[role="group"][aria-label="Sidebar layout"]')
/** A row's own words, before the control the mode puts beside them. */
const labelOf = (row: Element | null) =>
  wordsOf(row).replace(/(?:Hide|Show|Unpin|Unpinning|Try again)$/, "")
/** A row's move control, named for the row it moves and the place it goes. */
const moveControl = (label: string, direction: "up" | "down") =>
  find(`button[aria-label="Move ${label} ${direction}"]`)
/** The mode's live region: what a reorder says to a reader who cannot see the rows move. */
const liveRegion = () => group()?.querySelector('[role="status"]')

/** Escape, pressed where the reader's focus already is. */
async function pressEscape() {
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    )
  })
  await settle()
}

test("the header's button is the mode's switch", async () => {
  await seed()
  await mount(sidebar(), async () => {
    await until(async () => Boolean(find('a[href="/projects"]')), "the nav")
    // An expanded sidebar draws it — the docked one with its labels, and the phone's drawer, which
    // passes no toggle and no collapsed flag either.
    assert.ok(editButton(), "the header's edit button, in the Search button's place")
    assert.equal(
      editButton()?.getAttribute("aria-pressed"),
      "false",
      "a switch that is not pressed until the mode is open",
    )
    assert.ok(missing('button[aria-label="Search"]'), "Search gone, its place taken (a Decision)")

    await click(editButton())
    await until(async () => Boolean(doneButton()), "the switch named for what its press now does")
    assert.equal(
      doneButton()?.getAttribute("aria-pressed"),
      "true",
      "pressed while the mode is open",
    )
    const mode = group()
    assert.ok(mode, "the mode is one group, labelled for what it is")
    assert.equal(
      mode.contains(document.activeElement),
      true,
      "and focus has moved into it, so the next key reaches the mode",
    )

    // Every row above the boundary is drawn, in place, named by the record's id — and none of them is
    // a link, so a press while arranging leaves the reader where they stood.
    assert.equal(
      findAll("[data-sidebar-row]").length,
      6,
      "the five features and the pin, one row each",
    )
    const row = find('[data-sidebar-row="projects"]')
    assert.ok(row, "the row, named by the id the table gives it")
    assert.equal(row.getAttribute("href"), null, "no address of its own")
    assert.equal(row.classList.contains("min-h-11"), true, "still the 44px row")
    assert.equal(labelOf(row), "Projects", "still its label, its own control beside it")
    assert.ok(
      missing('nav[aria-label="Main"] a[href="/projects"]'),
      "and no link where the row stands",
    )
    assert.equal(
      labelOf(find('[data-sidebar-row="canvas"]')).replace("Labs", ""),
      "Canvas",
      "the lab feature keeps its name, its pill beside it",
    )
    assert.equal(
      labelOf(find('[data-sidebar-row="canvas"]')).includes("Labs"),
      true,
      "and the pill itself",
    )
    const pinned = find('[data-sidebar-row="canvas:p1"]')
    assert.equal(pinned?.hasAttribute("data-canvas-pinned"), true, "the pin keeps its mark")
    assert.equal(
      labelOf(pinned),
      "A pinned timetable",
      "and the canvas's own title, its one control beside it",
    )
    await click(row)
    assert.equal(path(), "/", "a row pressed in the mode navigates nowhere")
    await click(doneButton())
    await until(async () => Boolean(editButton()), "the switch at rest once more")
    assert.equal(
      editButton()?.getAttribute("aria-pressed"),
      "false",
      "a second press leaves the mode, the one control both ways",
    )
    assert.ok(find('nav[aria-label="Main"] a[href="/projects"]'), "and the rows are links again")
  })
})

test("Escape leaves the mode, and the switch has the focus back", async () => {
  await seed()
  await mount(sidebar(), async () => {
    await until(async () => Boolean(editButton()), "the switch")
    await click(editButton())
    await until(async () => Boolean(group()), "the mode")
    await pressEscape()
    await until(async () => Boolean(editButton()), "the switch at rest again")
    assert.equal(
      editButton()?.getAttribute("aria-pressed"),
      "false",
      "the switch no longer saying the mode is open",
    )
    assert.ok(
      document.activeElement === editButton(),
      "and the focus back on it rather than lost with the rows",
    )
    assert.ok(missing('[role="group"][aria-label="Sidebar layout"]'), "the mode shut")
    assert.ok(find('nav[aria-label="Main"] a[href="/projects"]'), "the rows links again")
  })
})

/**
 * The docked sidebar, which is the one that grows a collapse control: it folds to the rail, and the
 * rail keeps no switch to come back through, so the mode has to be left on the way.
 */
function Docked() {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <ConversationList collapsed={collapsed} onToggleCollapsed={() => setCollapsed((was) => !was)} />
  )
}

test("Collapse leaves the mode before it collapses", async () => {
  await seed()
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <Docked />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(editButton()), "the switch")
      await click(editButton())
      await until(async () => Boolean(group()), "the mode")
      await click(find('button[aria-label="Collapse sidebar"]'))
      await until(async () => Boolean(find('button[aria-label="Expand sidebar"]')), "the rail")
      assert.ok(
        missing('[role="group"][aria-label="Sidebar layout"]'),
        "the mode left as the sidebar folded, not drawn on the rail",
      )
      assert.ok(missing('button[aria-label="Edit sidebar"]'), "and the rail keeps no switch")
    },
  )
})

/**
 * The record the account carries: Meetings first, Research put away. One reader's arrangement, as a
 * device that has heard nothing but this record would draw it — the pin the host holds standing after
 * Meetings, the row it follows in the catalogue (a rule with no exception for a pin).
 */
const ORDERED = {
  version: 1,
  order: ["meetings", "projects", "code", "canvas", "research"],
  hidden: ["research"],
}

/** The addresses the resting sidebar draws, in the order it draws them. */
const addresses = () => findAll('nav[aria-label="Main"] a').map((row) => row.getAttribute("href"))

test("a hidden row leaves the sidebar and stays in the mode, muted", async () => {
  await seed()
  await mount(sidebar(), async () => {
    await until(async () => Boolean(find('a[href="/code"]')), "the nav")
    await click(editButton())
    await until(async () => Boolean(group()), "the mode")

    await click(find('button[aria-label="Hide Code"]'))
    const row = () => find('[data-sidebar-row="code"]')
    await until(async () => Boolean(find('button[aria-label="Show Code"]')), "the row put away")
    assert.equal(row()?.hasAttribute("data-hidden"), true, "the row in the mode says it is hidden")
    assert.equal(
      row()?.classList.contains("text-muted-foreground"),
      true,
      "and stands muted, in its place",
    )
    assert.equal(
      wordsOf(row()).includes("Hidden"),
      true,
      "with the word a screen reader hears, the eye reading the muted colour",
    )
    assert.equal(row()?.previousElementSibling?.getAttribute("data-sidebar-row"), "projects")
    assert.equal(
      row()?.nextElementSibling?.getAttribute("data-sidebar-row"),
      "canvas",
      "still where the reader had it in the one list, not grouped away",
    )

    // The resting sidebar draws no hidden row — the mode did not have to close to make it so.
    await click(doneButton())
    await until(async () => Boolean(editButton()), "the switch at rest")
    assert.ok(missing('nav[aria-label="Main"] a[href="/code"]'), "Code has left the sidebar")
    assert.deepEqual(
      addresses(),
      ["/projects", "/canvas", "/research", "/meetings", "/canvas/p1"],
      "every other row stands, in its place",
    )

    const stored = await db.settings.get("settings")
    assert.deepEqual(
      stored?.sidebarLayout,
      {
        version: 1,
        order: ["projects", "code", "canvas", "research", "meetings", "canvas:p1"],
        hidden: ["code"],
      },
      "the account's record names Code put away, with the whole order beside it",
    )
    assert.ok((stored?.appearanceAt ?? 0) > 0, "and the appearance clock moved with the write")
  })

  // A reader who opens the app again finds it as they left it: the record is the account's, and the
  // sidebar a fresh mount draws reads it before it draws a row.
  await mount(sidebar(), async () => {
    await until(async () => missing('nav[aria-label="Main"] a[href="/code"]'), "the row still away")
    assert.deepEqual(
      addresses(),
      ["/projects", "/canvas", "/research", "/meetings", "/canvas/p1"],
      "a second mount over the same device draws the same sidebar",
    )
  })
})

test("a row moves by its own controls, and the order is the account's", async () => {
  await seed()
  await mount(sidebar(), async () => {
    await until(async () => Boolean(find('a[href="/meetings"]')), "the nav")
    await click(editButton())
    await until(async () => Boolean(group()), "the mode")

    // Every row carries both controls, named for the row, and each is the 44px box a press needs.
    assert.equal(
      moveControl("Projects", "up")?.hasAttribute("disabled"),
      true,
      "the first row has nowhere up to go",
    )
    assert.equal(
      moveControl("Projects", "down")?.hasAttribute("disabled"),
      false,
      "and one place down to go",
    )
    assert.equal(
      moveControl("A pinned timetable", "down")?.hasAttribute("disabled"),
      true,
      "the last row has nowhere down to go",
    )
    assert.equal(
      moveControl("Meetings", "up")?.classList.contains("size-11"),
      true,
      "the control is 44px tall, the box a thumb gets",
    )

    await click(moveControl("Meetings", "up"))
    await until(
      async () => wordsOf(liveRegion()) === "Meetings moved to 4 of 6",
      "the live region saying where the row went",
    )
    assert.equal(
      liveRegion()?.getAttribute("aria-live"),
      "polite",
      "politely, so it waits for the reader rather than interrupting them",
    )
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Move Meetings up",
      "and the focus still on the control that moved one, so the next press is the next place",
    )

    // The same control, pressed again, moves it once more: the place the last press left it is where
    // this press starts from.
    await click(moveControl("Meetings", "up"))
    await until(
      async () => wordsOf(liveRegion()) === "Meetings moved to 3 of 6",
      "the second press's words",
    )
    assert.deepEqual(
      findAll("[data-sidebar-row]").map((row) => row.getAttribute("data-sidebar-row")),
      ["projects", "code", "meetings", "canvas", "research", "canvas:p1"],
      "the mode draws the order the presses made",
    )

    await click(doneButton())
    await until(async () => Boolean(editButton()), "the switch at rest")
    assert.deepEqual(
      addresses(),
      ["/projects", "/code", "/meetings", "/canvas", "/research", "/canvas/p1"],
      "the nav's addresses swapped with the rows",
    )
    const stored = await db.settings.get("settings")
    assert.deepEqual(
      stored?.sidebarLayout,
      {
        version: 1,
        order: ["projects", "code", "meetings", "canvas", "research", "canvas:p1"],
        hidden: [],
      },
      "and the account's record holds the order the presses made",
    )
    assert.ok((stored?.appearanceAt ?? 0) > 0, "written through the appearance clock")
  })
})

test("a row's grip is the mode's alone, and it is the 44px box a thumb gets", async () => {
  await seed()
  await mount(sidebar(), async () => {
    await until(async () => Boolean(find('a[href="/projects"]')), "the nav")
    // At rest the rows are destinations: a grip drawn there is a handle on a list nobody is arranging.
    assert.equal(findAll("[data-sidebar-grip]").length, 0, "no grip is drawn outside the mode")

    await click(editButton())
    await until(async () => Boolean(group()), "the mode")
    const grips = findAll("[data-sidebar-grip]")
    assert.equal(grips.length, 6, "every row above the boundary carries one, the pin included")
    const grip = find('[data-sidebar-row="projects"] [data-sidebar-grip]')
    assert.ok(grip, "the grip stands inside the row it reorders")
    assert.equal(
      grip.classList.contains("size-11"),
      true,
      "and is the 44px box a thumb gets, the same box the move controls take",
    )
    // The gesture belongs to the grip alone: the list still scrolls and the drawer still swipes
    // everywhere else, which is what `touch-action` on this one control is for.
    assert.equal(grip.classList.contains("touch-none"), true, "the grip keeps the touch for itself")
    assert.equal(
      grip.getAttribute("tabindex"),
      "-1",
      "and stays out of the tab order, since a drag is no key press — the move controls are that path",
    )
  })
})

test("a record written on one device draws the same rows on the next", async () => {
  await seed()
  await seedSettings({ activeProfileId: bot.id, meetings: true, sidebarLayout: ORDERED })
  await mount(sidebar(), async () => {
    await until(
      async () => missing('nav[aria-label="Main"] a[href="/research"]'),
      "the arrangement this device wrote",
    )
    assert.deepEqual(
      addresses(),
      ["/meetings", "/canvas/p1", "/projects", "/code", "/canvas"],
      "Meetings first, Research put away, the unnamed pin after the row it follows",
    )
  })

  // The record as sync carries it to another device, and as that device adopts it: one doc's value
  // and the clock it arrived on.
  const { appearance } = syncedAppearance(await getSettings())
  await seed()
  await seedSettings({ activeProfileId: bot.id, meetings: true })
  await adoptAppearance(appearance.value, appearance.at)
  assert.deepEqual(
    (await getSettings()).sidebarLayout,
    ORDERED,
    "the record arrives whole, its order and its hidden list together",
  )

  await mount(sidebar(), async () => {
    await until(
      async () => missing('nav[aria-label="Main"] a[href="/research"]'),
      "the adopted arrangement",
    )
    assert.deepEqual(
      addresses(),
      ["/meetings", "/canvas/p1", "/projects", "/code", "/canvas"],
      "and the next device draws the same sidebar from it",
    )
  })
})

test("a collapsed sidebar draws no edit button, and an expanded one draws it", async () => {
  await seed()
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList collapsed />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(find('a[href="/projects"]')), "the rail")
      assert.ok(missing('button[aria-label="Edit sidebar"]'), "the icon rail keeps no edit button")
      assert.ok(missing('button[aria-label="Done editing sidebar"]'), "and no switch to leave with")
      assert.ok(
        missing('[role="group"][aria-label="Sidebar layout"]'),
        "nothing on the rail opens the mode",
      )
    },
  )
  // The same sidebar at a width that keeps its labels still draws the switch.
  await mount(sidebar(), async () => {
    await until(async () => Boolean(editButton()), "the expanded sidebar's button")
    assert.equal(
      editButton()?.getAttribute("aria-pressed"),
      "false",
      "a sidebar that is not collapsed draws it, resting",
    )
  })
})

/**
 * The three ways a host answers an unpin: it refuses in its own words, it never answers at all, or it
 * answers the record with the pin taken off. A request that never lands is answered here the way the
 * client's own timeout answers it — a `TimeoutError` off `fetch` (`request` in `hermes.ts` rethrows
 * one, and `withHost` turns it into the unreachable refusal) — so a case about a host gone quiet
 * proves the same thing without sitting on the fifteen seconds a real timer would take.
 */
type UnpinAnswer = "refused" | "silent" | "unpinned"

const REFUSED_WORDS = "The host won't let this pin go while its bot is busy."

function serveUnpin(answer: UnpinAnswer, hold?: Promise<void>) {
  /** Every write the mode made, in the order it made it. */
  const posts: { body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    if (url.pathname.endsWith("/info")) return json({ version: "0.114.0", features: ["canvas"] })
    if (url.pathname.endsWith("/canvases") && method === "GET")
      return json({ object: "gots.canvases", canvases: [PINNED] })
    if (url.pathname.endsWith(`/canvases/${PINNED.id}`) && method === "POST") {
      posts.push({ body: JSON.parse(String(init?.body ?? "{}")) })
      // The first write is the one a case can hold open, so the control's held state is a state a
      // reader can be standing in rather than a race the answer always wins.
      if (hold && posts.length === 1) await hold
      if (answer === "refused" && posts.length === 1)
        return json({ error: { message: REFUSED_WORDS } }, 409)
      if (answer === "silent") throw new DOMException("The operation timed out.", "TimeoutError")
      return json({ canvas: { ...PINNED, pinned: false, at: 21 } })
    }
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
  return posts
}

/** The store's own pinned list, drawn beside the sidebar so a case reads what the write left. */
let pinnedIds: string[] = []
function StorePins() {
  const { pinned } = useCanvasStore()
  // Read after the commit rather than during the render: what a case asks is what the store held
  // once the row it drew had landed.
  useEffect(() => {
    pinnedIds = pinned.map((canvas) => canvas.id)
  }, [pinned])
  return null
}

/** The sidebar with the store's pinned list beside it, for a case that reads both. */
const sidebarAndStore = () => (
  <MemoryRouter initialEntries={["/"]}>
    <Path />
    <ConversationList />
    <StorePins />
  </MemoryRouter>
)

/** The pin's row in the mode. */
const pinRow = () => find('[data-sidebar-row="canvas:p1"]')
/** The one control a pin carries, named for the canvas it lets go. */
const unpinControl = () => find('[data-sidebar-row="canvas:p1"] [data-sidebar-unpin]')
/** What a row's refusal says, and it is drawn by the row it was made in. */
const refusalInRow = () => pinRow()?.querySelector('[role="alert"]') ?? null
/** The rows the mode draws, in the order it draws them. */
const rowIds = () => findAll("[data-sidebar-row]").map((row) => row.getAttribute("data-sidebar-row"))

/** Opens the mode over a sidebar whose rows have arrived. */
async function openMode() {
  await until(async () => Boolean(find('a[href="/projects"]')), "the nav")
  await click(editButton())
  await until(async () => Boolean(group()), "the mode")
}

test("an unpin the host refuses keeps the row, in the host's words", async () => {
  // A host that says no: the row stays exactly where it stood, the host's sentence under it, and the
  // control one press from asking again — no spinner, and nothing said in passing where the reader
  // is not looking.
  let release = () => {}
  const held = new Promise<void>((done) => (release = done))
  await seed()
  const posts = serveUnpin("refused", held)
  await mount(sidebarAndStore(), async () => {
    await openMode()
    await until(async () => Boolean(pinRow()), "the pin's row")
    const before = rowIds()
    assert.equal(wordsOf(unpinControl()), "Unpin", "the control, named for the canvas it lets go")
    assert.equal(
      unpinControl()?.getAttribute("aria-label"),
      "Unpin A pinned timetable",
      "and named for its canvas rather than its place",
    )

    await withToasts(async (said) => {
      await click(unpinControl())
      // The press holds that one control and leaves the row exactly where it was.
      assert.equal(wordsOf(unpinControl()), "Unpinning", "the control saying what it is doing")
      assert.equal(
        unpinControl()?.getAttribute("aria-label"),
        "Unpinning A pinned timetable",
        "the name saying the same",
      )
      assert.equal(unpinControl()?.hasAttribute("disabled"), true, "and held while the write is out")
      assert.equal(
        pinRow()?.querySelector('[data-slot="spinner"], [role="progressbar"]'),
        null,
        "no spinner of its own, which would outlive the answer anyway",
      )
      assert.deepEqual(rowIds(), before, "the row exactly where it stood")
      assert.equal(posts.length, 1, "one write out")
      assert.deepEqual(posts[0].body, { pinned: false }, "and it is the unpin, nothing more")

      // The host's answer.
      release()
      // Let the answer land inside the test's own act, so the row's render is not an update the
      // harness has to warn about.
      await settle()
      await until(async () => wordsOf(refusalInRow()).length > 0, "the host's refusal")
      assert.equal(wordsOf(refusalInRow()), REFUSED_WORDS, "in the host's own words")
      assert.equal(
        refusalInRow()?.closest("[data-sidebar-row]")?.getAttribute("data-sidebar-row"),
        "canvas:p1",
        "drawn by the row the press was made in, not at the top of the list",
      )
      assert.equal(wordsOf(unpinControl()), "Try again", "the control, one press from asking again")
      assert.equal(
        unpinControl()?.getAttribute("aria-label"),
        "Try again: unpin A pinned timetable",
        "named for what the press does",
      )
      assert.equal(unpinControl()?.hasAttribute("disabled"), false, "and pressable")
      assert.deepEqual(rowIds(), before, "the row still exactly where it stood")
      assert.equal(pinRow()?.hasAttribute("data-hidden"), false, "and not put away")
      assert.deepEqual(said, [], "nothing said in passing: the refusal stands where it was made")

      // A canvas's write is the host's record and no part of the layout: the account's arrangement is
      // where it was, and its clock has not moved.
      let stored = await db.settings.get("settings")
      assert.deepEqual(stored?.sidebarLayout, DEFAULT_SIDEBAR_LAYOUT, "the layout record untouched")
      assert.equal(stored?.appearanceAt, 0, "nor the appearance clock it rides")

      // Try again is the same write, and an answer then folds the host's record into the store.
      await click(unpinControl())
      await until(async () => posts.length === 2, "the second write")
      assert.deepEqual(posts[1].body, { pinned: false }, "the same unpin asked again")
      await until(async () => missing('[data-sidebar-row="canvas:p1"]'), "the answered record")
      assert.deepEqual(
        rowIds(),
        before.filter((id) => id !== "canvas:p1"),
        "the row leaves the mode, every other row where it stood",
      )
      assert.equal(pinnedIds.includes(PINNED.id), false, "and the store's pinned list is shorter")
      stored = await db.settings.get("settings")
      assert.deepEqual(stored?.sidebarLayout, DEFAULT_SIDEBAR_LAYOUT, "still no layout write")
    })
  })

  // A host that never answers: the client gives up its own way, and that refusal is the row's too —
  // at once here, since a `TimeoutError` is what fifteen seconds of silence would end in. The row
  // draws the words itself, so the reader who looks where they pressed finds them there: the same
  // sentence in a toast is gone before they do, and a case can hear the toaster to prove it stays
  // silent.
  await seed()
  const silent = serveUnpin("silent")
  await mount(sidebarAndStore(), async () => {
    await openMode()
    await until(async () => Boolean(pinRow()), "the pin's row")
    const before = rowIds()
    await withToasts(async (said) => {
      await click(unpinControl())
      await until(
        async () => wordsOf(refusalInRow()) === CANVAS_UNREACHABLE,
        "the client's own unreachable refusal",
      )
      assert.equal(
        wordsOf(refusalInRow()),
        CANVAS_UNREACHABLE,
        "the client's words, since the host sent none",
      )
      assert.equal(
        refusalInRow()?.closest("[data-sidebar-row]")?.getAttribute("data-sidebar-row"),
        "canvas:p1",
        "under the row, where the press was made",
      )
      assert.equal(wordsOf(unpinControl()), "Try again", "and no spinner left where the answer is")
      assert.equal(
        pinRow()?.querySelector('[data-slot="spinner"], [role="progressbar"], [role="status"]'),
        null,
        "nothing of it spinning still",
      )
      assert.deepEqual(rowIds(), before, "the row in its place")
      assert.deepEqual(silent[0]?.body, { pinned: false }, "the write was the unpin, asked once")
      assert.deepEqual(said, [], "and nothing said in passing: the row's words are drawn where it was")
      const stored = await db.settings.get("settings")
      assert.deepEqual(stored?.sidebarLayout, DEFAULT_SIDEBAR_LAYOUT, "and no layout write")
    })
  })

  // A host that answers the record: the row leaves the sidebar because the store's pinned list is
  // read, and nothing about the layout record moved to make it so.
  await seed()
  const answered = serveUnpin("unpinned")
  pinnedIds = []
  await mount(sidebarAndStore(), async () => {
    await openMode()
    await until(async () => Boolean(pinRow()), "the pin's row")
    await until(async () => pinnedIds.includes(PINNED.id), "the store holding the pin")
    const before = rowIds()

    await click(unpinControl())
    await until(async () => missing('[data-sidebar-row="canvas:p1"]'), "the row leaving the mode")
    assert.deepEqual(
      rowIds(),
      before.filter((id) => id !== "canvas:p1"),
      "the row gone from the mode, every other row standing",
    )
    assert.equal(pinnedIds.includes(PINNED.id), false, "the store's pinned list, one shorter")
    assert.equal(answered.length, 1, "one write for one press")
    assert.deepEqual(answered[0].body, { pinned: false }, "the unpin, and nothing else")
    const stored = await db.settings.get("settings")
    assert.deepEqual(
      stored?.sidebarLayout,
      DEFAULT_SIDEBAR_LAYOUT,
      "no `sidebarLayout` write on a canvas's success",
    )
    assert.equal(stored?.appearanceAt, 0, "nor a move of the appearance clock")

    // And the resting sidebar draws no row for it, since it reads the same store.
    await click(doneButton())
    await until(async () => Boolean(editButton()), "the switch at rest")
    assert.equal(missing('nav[aria-label="Main"] a[href="/canvas/p1"]'), true, "the pin's row gone")
  })
})
