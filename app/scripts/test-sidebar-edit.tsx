/**
 * The sidebar's edit mode as a reader opens and leaves it: the header's button is the switch, a row
 * in the mode is no link, and Escape gives the button and the links back. Nothing here arranges
 * anything yet — the mode of this step is the state that takes the rows above the boundary out of
 * the link role and holds the focus, and its controls arrive in the steps after it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act, useState } from "react"
import { MemoryRouter } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { adoptAppearance, db, getSettings } from "@/lib/db"
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
const labelOf = (row: Element | null) => wordsOf(row).replace(/(?:Hide|Show)$/, "")

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
    await until(
      async () => Boolean(doneButton()),
      "the switch named for what its press now does",
    )
    assert.equal(doneButton()?.getAttribute("aria-pressed"), "true", "pressed while the mode is open")
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
    assert.equal(wordsOf(pinned), "A pinned timetable", "and the canvas's own title")
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
    <ConversationList
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((was) => !was)}
    />
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
const addresses = () =>
  findAll('nav[aria-label="Main"] a').map((row) => row.getAttribute("href"))

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
