/**
 * The sidebar's edit mode as a reader opens and leaves it, and as they arrange it: the header's
 * button is the switch, Escape gives the button and the links back, a row in the mode is no link, a
 * row can be put away by its eye and brought back by the same press, and a row moves by the arrows on
 * its column's handle — each press writing the account's record and saying what it did, with the focus
 * left on the control that moved the row. The mode's rows carry a narrow column the resting sidebar
 * does not, grown when the mode opens and closed before it goes, so the two states meet at one
 * geometry. The
 * last case is the same sidebar in a phone's drawer, where Escape is the mode's first and the sheet's
 * only after it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act, useEffect, useState } from "react"
import { MemoryRouter } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { CANVAS_UNREACHABLE, useCanvasStore } from "@/lib/canvases"
import { adoptAppearance, db, getSettings } from "@/lib/db"
import { DEFAULT_SIDEBAR_LAYOUT, type SidebarLayoutRecord } from "@/lib/sidebar-layout"
import { syncedAppearance } from "@/lib/sync"

import {
  Path,
  PINNED_CANVAS,
  atWidth,
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  missing,
  mount,
  path,
  seedSettings,
  servePinnedCanvases,
  settle,
  until,
  withToasts,
  wordsOf,
} from "./component-kit.tsx"

const bot = botProfile("bot-main", { id: "bot-1", name: "Mainly" })

/** A device with one bot, every lab switch on, and the canvas the reader pinned on its sidebar. */
async function seed() {
  await seedSettings({ activeProfileId: bot.id, meetings: true, appearanceAt: 0 })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.conversations.clear()
  servePinnedCanvases()
}

const sidebar = () => (
  <MemoryRouter initialEntries={["/"]}>
    <Path />
    <ConversationList />
  </MemoryRouter>
)

const editButton = () => find('button[aria-label="Edit sidebar"]')
const doneButton = () => find('button[aria-label="Done editing sidebar"]')
const group = () => find('[role="group"][aria-label="Sidebar layout"]')
/** A row's own words, before the control the mode puts beside them. */
const labelOf = (row: Element | null) =>
  wordsOf(row).replace(/(?:Hide|Show|Unpin|Unpinning|Try again)$/, "")
/** The mode's row, by the id the account's record files it under. */
const modeRow = (id: string) => find(`[data-sidebar-row="${id}"]`)
/** A row's grip: the narrow column's handle, which both the pointer's drag and the keys work. */
const gripOf = (id: string) => find(`[data-sidebar-row="${id}"] [data-sidebar-grip]`)
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

/** Puts the focus on a control, so the key sent next lands in it. */
async function focusOn(element: Element | null) {
  assert.ok(element, "the control that takes the focus")
  await act(async () => element.focus())
  await settle()
}

/** One arrow, at the control holding the focus, sent the way a keyboard sends it. */
async function pressKey(key: "ArrowUp" | "ArrowDown") {
  const held = document.activeElement
  assert.ok(held, "a control holding the focus")
  await act(async () => {
    held.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
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

const addresses = () => findAll('nav[aria-label="Main"] a').map((row) => row.getAttribute("href"))

test("a hidden row leaves the sidebar and stays in the mode, muted", async () => {
  await seed()
  await mount(sidebar(), async () => {
    await until(async () => Boolean(find('a[href="/code"]')), "the nav")
    await click(editButton())
    await until(async () => Boolean(group()), "the mode")

    // The eye on a row that stands: struck through, since the press is the one that puts it away, and
    // no word beside it — the glyph is the control and the name is what a reader hears.
    const hide = find('button[aria-label="Hide Code"]')
    assert.equal(
      hide?.querySelector("svg")?.classList.contains("lucide-eye-off"),
      true,
      "the struck-through eye, on the row that stands",
    )
    assert.equal(wordsOf(hide), "", "and no visible word beside it")
    assert.equal(hide?.classList.contains("size-11"), true, "in the 44px box a thumb gets")

    await click(hide)
    await until(async () => Boolean(find('button[aria-label="Show Code"]')), "the row put away")
    const row = () => find('[data-sidebar-row="code"]')
    // The press's name is the state, and the glyph draws it too: a struck-through eye on a row that
    // stands, a plain one on a row that is put away.
    const eye = find('button[aria-label="Show Code"]')
    assert.equal(
      eye?.querySelector("svg")?.classList.contains("lucide-eye"),
      true,
      "the eye that shows, where the row is put away",
    )
    assert.equal(
      eye?.querySelector("svg")?.classList.contains("lucide-eye-off"),
      false,
      "not the eye that hides",
    )
    assert.equal(wordsOf(eye), "", "and no visible word: the icon is the whole of it")
    assert.equal(eye?.classList.contains("size-11"), true, "in the 44px box a thumb gets")
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

test("a row moves by its grip's keys, and the order is the account's", async () => {
  await seed()
  await mount(sidebar(), async () => {
    await until(async () => Boolean(find('a[href="/meetings"]')), "the nav")
    await click(editButton())
    await until(async () => Boolean(group()), "the mode")

    // Every row's order is reached through its own handle: one 12px column of the row's own height,
    // named for the row it moves and a tab stop rather than a mouse's secret.
    const grip = gripOf("meetings")
    assert.ok(grip, "Meetings' own grip")
    assert.equal(grip.getAttribute("aria-label"), "Reorder Meetings", "named for the row it moves")
    assert.equal(grip.classList.contains("w-3"), true, "the column's 12px")
    assert.equal(grip.classList.contains("h-11"), true, "and the 44px a thumb's press needs")
    assert.equal(grip.hasAttribute("aria-hidden"), false, "a control a screen reader must hear")
    assert.equal(
      grip.getAttribute("tabindex"),
      null,
      "and a tab stop, which is how a key reaches it",
    )

    // One arrow, one place up — said in the live region, and the grip keeps the focus so the next
    // press is the next place.
    await focusOn(gripOf("meetings"))
    await pressKey("ArrowUp")
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
      "Reorder Meetings",
      "and the focus still on the grip that moved it, so the next press is the next place",
    )
    assert.deepEqual(
      rowIds(),
      ["projects", "code", "canvas", "meetings", "research", "canvas:p1"],
      "the row one place up, the rest where they stood",
    )

    // The same grip, pressed again, moves it once more: the place the last press left it is where
    // this press starts from.
    await pressKey("ArrowUp")
    await until(
      async () => wordsOf(liveRegion()) === "Meetings moved to 3 of 6",
      "the second press's words",
    )
    assert.deepEqual(
      rowIds(),
      ["projects", "code", "meetings", "canvas", "research", "canvas:p1"],
      "the mode draws the order the presses made",
    )

    // The first row has nowhere up to go, and a press there writes nothing and says nothing.
    await focusOn(gripOf("projects"))
    await pressKey("ArrowUp")
    assert.deepEqual(
      rowIds(),
      ["projects", "code", "meetings", "canvas", "research", "canvas:p1"],
      "the first row stays where it stands",
    )
    assert.equal(wordsOf(liveRegion()), "Meetings moved to 3 of 6", "and nothing is announced")

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

test("a row's grip is the mode's alone, and it is the 12px column's handle", async () => {
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
    assert.equal(grip.classList.contains("w-3"), true, "it is 12px wide, the column's own width")
    assert.equal(
      grip.classList.contains("h-11"),
      true,
      "and 44px tall, the box a thumb's press needs",
    )
    assert.equal(
      grip.classList.contains("size-11"),
      false,
      "not the wide box it used to stand in, which took the room a name wanted",
    )
    assert.equal(
      grip.querySelector("svg")?.classList.contains("size-3"),
      true,
      "holding a small glyph rather than a plate",
    )
    // 12px is narrower than a finger, so the box widens its pointer area with an overlay rather than
    // with layout: the `after` reaches into the gap on both sides and no further, so the column costs
    // the row 12px and a thumb still finds it.
    assert.equal(grip.classList.contains("relative"), true, "the box the overlay is placed against")
    assert.equal(grip.classList.contains("after:absolute"), true, "an overlay, outside the flow")
    assert.equal(
      grip.classList.contains("after:-inset-x-2"),
      true,
      "reaching 8px either side — the gap a mark stands in, and the name's own press left alone",
    )
    // The gesture belongs to the whole row, and the column is what a finger may start it from: the
    // `touch-action` that keeps the drawer's scroll and swipe out of the drag is the column's alone.
    const column = find('[data-sidebar-row="projects"] [data-sidebar-gutter]')
    assert.equal(
      column?.classList.contains("touch-none"),
      true,
      "the column keeps the touch for itself",
    )
    assert.equal(
      modeRow("projects")?.classList.contains("touch-none"),
      false,
      "and the row it stands on does not, so a finger elsewhere on it still scrolls the drawer",
    )
    // And it is the keyboard's way in too, so it is a tab stop a name reaches rather than a mouse's
    // secret: the mode's rows carry no second control that moves them.
    assert.equal(
      grip.getAttribute("tabindex"),
      null,
      "no `tabindex`: a tab stop like any other control",
    )
    assert.equal(grip.getAttribute("aria-hidden"), null, "nothing hides it from a screen reader")
    assert.equal(grip.getAttribute("aria-label"), "Reorder Projects", "and it is named for its row")
    assert.equal(
      findAll('[aria-label^="Move "]').length,
      0,
      "no Move up or Move down beside any row: the grip is the one way to the order",
    )
  })
})

/**
 * A host that says a session waits on the reader, beside the canvas its sidebar pins: what a
 * `Waiting` row is drawn from, so one case can hold a mark of every kind the sidebar draws.
 */
function serveWaiting() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.114.0", features: ["canvas"] })
    if (url.pathname.endsWith("/canvases"))
      return json({ object: "gots.canvases", canvases: [PINNED_CANVAS] })
    if (url.pathname.endsWith("/plugins/gots/runs/live"))
      return json({ waiting: { "gots-waiting-1": { kind: "question", count: 1 } } })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

/** The project session that host says waits: what the sidebar draws its `Waiting` row from. */
async function seedWaitingSession() {
  await db.conversations.put({
    id: "waiting-1",
    profileId: bot.id,
    title: "A session that waits",
    projectId: "a-project",
    hermesSessionId: "gots-waiting-1",
    createdAt: 3,
    updatedAt: 4,
    changedAt: 3,
  })
}

/**
 * The column is the mode's alone. The resting sidebar draws none — its spacing is the spacing it
 * shipped with — and the mode's rows mount with the column closed, which is that same resting
 * geometry, then grow it. That is what makes entering and leaving seamless: at zero the row is a
 * resting row, so the list may replace the mode's rows (or the reverse) at either end of the motion
 * without a jump.
 *
 * A DOM without layout cannot measure a tween, so this holds the parts the tween is made of: no
 * column at rest, one on every row the mode arranges and none below the boundary, its width class
 * going from zero to 12px with the transition and the reduced-motion guard on it, the grip standing
 * in it, and the column closing back to zero before the resting list returns. The sweep measures the
 * boxes before and after the motion (ADR 0019).
 */
test("the column belongs to the mode, and grows out of the resting row's geometry", async () => {
  await seed()
  serveWaiting()
  await seedWaitingSession()
  await mount(sidebar(), async () => {
    await until(
      async () => Boolean(find('nav[aria-labelledby="waiting-heading"] a')),
      "the waiting row",
    )
    await until(async () => Boolean(find('nav[aria-labelledby="bots-heading"] a')), "the bot's row")

    // At rest there is no column at all: no kind of row carries one, so the sidebar is the sidebar.
    assert.equal(findAll("[data-sidebar-gutter]").length, 0, "no column anywhere at rest")
    assert.equal(
      find('nav[aria-label="Main"] [data-sidebar-row="projects"]')?.firstElementChild?.tagName.toLowerCase(),
      "svg",
      "and a feature row starts with its mark, as it always did",
    )

    await click(editButton())
    await until(async () => Boolean(group()), "the mode")
    const column = () => find('[data-sidebar-row="projects"] [data-sidebar-gutter]')

    // One on each row the mode arranges, and none on the rows it does not.
    assert.equal(findAll("[data-sidebar-gutter]").length, 6, "one on each row the mode arranges")
    assert.ok(
      find('[data-sidebar-row="canvas:p1"] [data-sidebar-gutter]'),
      "the pinned canvas's too",
    )
    assert.equal(
      find('nav[aria-labelledby="bots-heading"] a')?.querySelector("[data-sidebar-gutter]"),
      null,
      "and none below the boundary, where nothing is arranged",
    )

    // It grows, and it is the app's own curve in both directions, never for a reader who asked for
    // less motion.
    await until(async () => column()?.getAttribute("data-open") === "", "the column grown")
    assert.equal(column()?.classList.contains("w-3"), true, "12px once it has grown")
    assert.equal(
      column()?.classList.contains("transition-[width,margin]"),
      true,
      "its width tweened, with the gap it pays back",
    )
    assert.equal(
      column()?.classList.contains("motion-reduce:transition-none"),
      true,
      "and no motion for the reader who asked for none",
    )
    assert.equal(column()?.classList.contains("overflow-hidden"), true, "clipped to its own width")
    assert.equal(
      column()?.firstElementChild?.hasAttribute("data-sidebar-grip"),
      true,
      "holding the grip, the row's handle for a pointer and for a key",
    )
    assert.equal(
      column()?.classList.contains("touch-none"),
      true,
      "and the column's own touch-action, so a finger here drags while the list still scrolls",
    )

    // Leaving runs it back to zero, and only then does the resting list take its place.
    await click(doneButton())
    await until(async () => column()?.getAttribute("data-open") == null, "the column closing")
    assert.equal(column()?.classList.contains("w-0"), true, "at zero, the resting row's geometry")
    await until(
      async () => !group() && Boolean(find('nav[aria-label="Main"] a[href="/projects"]')),
      "the resting list back",
    )
    assert.equal(findAll("[data-sidebar-gutter]").length, 0, "and no column left on it")
  })
})

/** A pointer, as the browser sends one at something inside the sidebar's rows. */
async function sendPointer(
  element: Element | null,
  type: "pointerdown" | "pointercancel",
  pointerType = "mouse",
) {
  assert.ok(element, "the thing the press lands on")
  await act(async () => {
    element.dispatchEvent(
      new window.PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType,
      }),
    )
  })
  await settle()
}

/**
 * The whole row is the handle, and a control inside it is not: a press on a row's name takes the
 * pointer's gesture, while a press on the eye or the unpin is the press that control means. A finger
 * is the exception the drawer forces — the sheet scrolls and swipes under it, so only the indicator
 * column starts a drag from a touch, and a finger on the name leaves the row to the drawer.
 *
 * The press alone is what is proved here: where a carried row lands, and what a release writes, are
 * the sweep's, since both are reckoned from boxes a DOM without layout does not have.
 */
test("a press anywhere on a row starts the drag, but a press on a control in it does not", async () => {
  await seed()
  await mount(sidebar(), async () => {
    await openMode()
    const lineOf = (id: string) => modeRow(id)?.firstElementChild ?? null
    const lifted = (id: string) => modeRow(id)?.hasAttribute("data-dragging") === true
    assert.equal(
      lineOf("projects")?.classList.contains("cursor-grab"),
      true,
      "the row says it is a handle",
    )
    assert.equal(
      lineOf("projects")?.classList.contains("active:cursor-grabbing"),
      true,
      "and holds on to it while the press is down",
    )

    await sendPointer(find('[data-sidebar-row="projects"] .truncate'), "pointerdown")
    assert.equal(lifted("projects"), true, "a press on the name takes the gesture")
    await sendPointer(lineOf("projects"), "pointercancel")
    assert.equal(lifted("projects"), false, "and a press let go of leaves the row standing")

    await sendPointer(find('button[aria-label="Hide Projects"]'), "pointerdown")
    assert.equal(
      lifted("projects"),
      false,
      "a press on the eye starts no drag: it is the eye's press",
    )
    await sendPointer(find('[data-sidebar-row="canvas:p1"] [data-sidebar-unpin]'), "pointerdown")
    assert.equal(lifted("canvas:p1"), false, "nor does a press on the unpin")

    await sendPointer(find('[data-sidebar-row="code"] .truncate'), "pointerdown", "touch")
    assert.equal(
      lifted("code"),
      false,
      "a finger on a row's name leaves the row to the drawer's scroll and swipe",
    )
    await sendPointer(
      find('[data-sidebar-row="code"] [data-sidebar-gutter]'),
      "pointerdown",
      "touch",
    )
    assert.equal(lifted("code"), true, "while a finger on the column takes the gesture")
    await sendPointer(lineOf("code"), "pointercancel")
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

/**
 * Canvas's switch off: the record still holds Canvas's row between Projects and Code, while the mode
 * draws Projects, Code, Research and Meetings. The list a press moves among is the one drawn.
 */
const CANVAS_GAP = {
  version: 1,
  order: ["projects", "canvas", "code", "research", "meetings"],
  hidden: [],
}

test("a grip's arrow beside a row the switch takes away moves the row the reader sees", async () => {
  await seed()
  // Canvas's switch off, so its row is no row of the mode's list — though the record still names it.
  await seedSettings({
    activeProfileId: bot.id,
    meetings: true,
    canvas: false,
    sidebarLayout: CANVAS_GAP,
    appearanceAt: 0,
  })
  await mount(sidebar(), async () => {
    await openMode()
    assert.deepEqual(
      rowIds(),
      ["projects", "code", "research", "meetings"],
      "the rows the switch lets through",
    )
    assert.equal(
      missing('[data-sidebar-row="canvas"]'),
      true,
      "and Canvas is no row of the list a press moves among",
    )

    // Code one place down: past Research, the next row the reader can see — not past the Canvas the
    // record holds between them, which would leave the drawn list exactly as it was.
    await focusOn(gripOf("code"))
    await pressKey("ArrowDown")
    await until(
      async () => wordsOf(liveRegion()) === "Code moved to 3 of 4",
      "the drawn count, not the record's",
    )
    assert.deepEqual(
      rowIds(),
      ["projects", "research", "code", "meetings"],
      "the row past the next one on screen",
    )
    assert.equal(
      document.activeElement?.getAttribute("aria-label"),
      "Reorder Code",
      "and the focus still on the grip that moved it",
    )
    assert.deepEqual(
      ((await db.settings.get("settings"))?.sidebarLayout?.order ?? []).filter(
        (id) => !id.startsWith("canvas:"),
      ),
      ["projects", "canvas", "research", "code", "meetings"],
      "the account's record moves Code past Research and leaves Canvas where it stood",
    )

    // And back up over the same gap: the row the reader sees is the one press away.
    await pressKey("ArrowUp")
    await until(async () => wordsOf(liveRegion()) === "Code moved to 2 of 4", "the way back")
    assert.deepEqual(
      ((await db.settings.get("settings"))?.sidebarLayout?.order ?? []).filter(
        (id) => !id.startsWith("canvas:"),
      ),
      ["projects", "canvas", "code", "research", "meetings"],
      "the order the presses started from",
    )

    // Meetings is the last row the mode draws: an arrow there has nowhere to go, and writes nothing.
    await focusOn(gripOf("meetings"))
    await pressKey("ArrowDown")
    assert.deepEqual(
      rowIds(),
      ["projects", "code", "research", "meetings"],
      "the last drawn row stays where it stands",
    )
    assert.equal(wordsOf(liveRegion()), "Code moved to 2 of 4", "and nothing is announced")
  })
})

/** A record another device, or a hand edit, left naming Code twice. */
const DOUBLED = {
  version: 1,
  order: ["projects", "code", "code", "canvas", "research", "meetings"],
  hidden: [],
}

test("a record that names a row twice draws one row and one control", async () => {
  await seed()
  await seedSettings({
    activeProfileId: bot.id,
    meetings: true,
    canvas: false,
    sidebarLayout: DOUBLED,
    appearanceAt: 0,
  })
  await mount(sidebar(), async () => {
    await until(async () => Boolean(find('a[href="/projects"]')), "the nav")
    assert.equal(
      findAll('nav[aria-label="Main"] a[href="/code"]').length,
      1,
      "one Code in the resting sidebar",
    )

    await openMode()
    assert.deepEqual(
      rowIds(),
      ["projects", "code", "research", "meetings"],
      "one row each, the id standing where it first stands, out of the rows the switch draws",
    )
    assert.equal(findAll('button[aria-label="Hide Code"]').length, 1, "one Hide control, not two")

    // A press writes the list once: the double is gone with the first edit made after it.
    await click(find('button[aria-label="Hide Code"]'))
    await until(
      async () => Boolean((await db.settings.get("settings"))?.sidebarLayout?.hidden?.length),
      "the write",
    )
    const written = (await db.settings.get("settings"))?.sidebarLayout
    assert.deepEqual(
      (written?.order ?? []).filter((id) => !id.startsWith("canvas:")),
      ["projects", "code", "canvas", "research", "meetings"],
      "the record a press writes names every row once",
    )
    assert.deepEqual(written?.hidden, ["code"], "and the row it put away, once")
    assert.deepEqual(
      rowIds(),
      ["projects", "code", "research", "meetings"],
      "and the mode still draws one row for it",
    )
  })
})

test("a record this build cannot read draws today's sidebar and is left as it stands", async () => {
  await seed()
  // Exactly what an account can put on the settings row: version 1, `hidden`, and no `order` at all.
  // The sidebar is mounted on every route, so a record it cannot read may not throw the nav away.
  const malformed = { version: 1, hidden: ["code"] } as unknown as SidebarLayoutRecord
  await seedSettings({
    activeProfileId: bot.id,
    meetings: true,
    sidebarLayout: malformed,
    appearanceAt: 0,
  })
  await mount(sidebar(), async () => {
    await until(async () => Boolean(find('a[href="/projects"]')), "the nav")
    assert.deepEqual(
      addresses(),
      ["/projects", "/code", "/canvas", "/research", "/meetings", "/canvas/p1"],
      "today's list, every row drawn",
    )
    await openMode()
    assert.deepEqual(
      rowIds(),
      ["projects", "code", "canvas", "research", "meetings", "canvas:p1"],
      "and the mode draws every row, in today's order",
    )
    assert.equal(
      find('[data-sidebar-row="code"]')?.hasAttribute("data-hidden"),
      false,
      "Code shown, as today's list has it",
    )
    assert.deepEqual(
      (await db.settings.get("settings"))?.sidebarLayout,
      malformed,
      "the record it cannot read, left exactly as it was — never written over",
    )
  })
})

test("the account keeps a record it can read and drops a value that is no record", async () => {
  await seed()
  // What sync hands the row: a value per appearance field, and the clock it arrived on.
  await adoptAppearance({ sidebarLayout: ORDERED }, 7)
  assert.deepEqual(
    (await getSettings()).sidebarLayout,
    ORDERED,
    "a record arrives, and the row keeps it",
  )

  // A value with no `order`, an `order` that is no list of ids, and a value that is no record at all:
  // none is a layout this build can carry, so none is a value to keep.
  for (const arriving of [
    { version: 1, hidden: ["code"] },
    { version: 1, order: "projects,code" },
    { version: 1, order: [1, 2], hidden: [] },
    [],
    null,
  ]) {
    await adoptAppearance({ sidebarLayout: arriving }, 8)
    assert.deepEqual(
      (await getSettings()).sidebarLayout,
      ORDERED,
      `the layout the row held, not ${JSON.stringify(arriving)}`,
    )
  }

  // And one written by a newer build is kept exactly as it arrived: it is a record, though not one
  // this build reads — dropping it would let this device push the default over the account's.
  const newer = { version: 2, order: ["projects"], hidden: [] }
  await adoptAppearance({ sidebarLayout: newer }, 9)
  assert.deepEqual(
    (await getSettings()).sidebarLayout,
    newer,
    "a newer build's record, kept on the row it arrived on",
  )
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
  const posts: { body: unknown }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    if (url.pathname.endsWith("/info")) return json({ version: "0.114.0", features: ["canvas"] })
    if (url.pathname.endsWith("/canvases") && method === "GET")
      return json({ object: "gots.canvases", canvases: [PINNED_CANVAS] })
    if (url.pathname.endsWith(`/canvases/${PINNED_CANVAS.id}`) && method === "POST") {
      posts.push({ body: JSON.parse(String(init?.body ?? "{}")) })
      // The first write is the one a case can hold open, so the control's held state is a state a
      // reader can be standing in rather than a race the answer always wins.
      if (hold && posts.length === 1) await hold
      if (answer === "refused" && posts.length === 1)
        return json({ error: { message: REFUSED_WORDS } }, 409)
      if (answer === "silent") throw new DOMException("The operation timed out.", "TimeoutError")
      return json({ canvas: { ...PINNED_CANVAS, pinned: false, at: 21 } })
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

const pinRow = () => find('[data-sidebar-row="canvas:p1"]')
const unpinControl = () => find('[data-sidebar-row="canvas:p1"] [data-sidebar-unpin]')
/** What a row's refusal says, and it is drawn by the row it was made in. */
const refusalInRow = () => pinRow()?.querySelector('[role="alert"]') ?? null
const rowIds = () =>
  findAll("[data-sidebar-row]").map((row) => row.getAttribute("data-sidebar-row"))

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
      assert.equal(
        unpinControl()?.hasAttribute("disabled"),
        true,
        "and held while the write is out",
      )
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
      assert.equal(
        pinnedIds.includes(PINNED_CANVAS.id),
        false,
        "and the store's pinned list is shorter",
      )
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
      assert.deepEqual(
        said,
        [],
        "and nothing said in passing: the row's words are drawn where it was",
      )
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
    await until(async () => pinnedIds.includes(PINNED_CANVAS.id), "the store holding the pin")
    const before = rowIds()

    await click(unpinControl())
    await until(async () => missing('[data-sidebar-row="canvas:p1"]'), "the row leaving the mode")
    assert.deepEqual(
      rowIds(),
      before.filter((id) => id !== "canvas:p1"),
      "the row gone from the mode, every other row standing",
    )
    assert.equal(
      pinnedIds.includes(PINNED_CANVAS.id),
      false,
      "the store's pinned list, one shorter",
    )
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

/** The write a device with no room for it answers every `put` with: a full quota, a locked store. */
const NO_ROOM = "The device has no room for this change."

/** Holds the settings row's own write to a refusal, for the presses a case makes inside it. */
async function withNoRoom(body: () => Promise<void>) {
  const settings = Object.getPrototypeOf(db.settings)
  const put = settings.put
  settings.put = async () => {
    throw new Error(NO_ROOM)
  }
  try {
    await body()
  } finally {
    settings.put = put
  }
}

/** A row's refusal, drawn where the press was made rather than beside the list or in a toast. */
const refusalIn = (id: string) =>
  find(`[data-sidebar-row="${id}"]`)?.querySelector('[role="alert"]') ?? null

test("a layout the device refuses is said under the row the press was made in", async () => {
  // A device with no room: the write rejects, and a press that threw its promise away would leave the
  // mode silent and the rejection unhandled. The refusal is the row's — the row stays exactly as it
  // stood, since a write that never landed changed nothing — and nothing is said in passing.
  await seed()
  await mount(sidebar(), async () => {
    await openMode()
    const before = rowIds()
    const record = (await db.settings.get("settings"))?.sidebarLayout

    await withNoRoom(async () => {
      await withToasts(async (said) => {
        // Hide: refused under the row it was pressed in.
        await click(find('button[aria-label="Hide Code"]'))
        await until(async () => wordsOf(refusalIn("code")) === NO_ROOM, "the refusal, under Code")
        assert.equal(
          find('[data-sidebar-row="code"]')?.hasAttribute("data-hidden"),
          false,
          "the row not put away",
        )
        assert.equal(
          find('button[aria-label="Hide Code"]')?.hasAttribute("disabled"),
          false,
          "the eye that was pressed, still named for the press that writes nothing here and still pressable",
        )
        assert.deepEqual(rowIds(), before, "every row exactly where it stood")
        assert.deepEqual(
          said,
          [],
          "nothing said in passing: the refusal stands where the press was",
        )

        // Dismissed, so the next press's words are the next press's own.
        await click(find(`[data-sidebar-row="code"] button[aria-label="Dismiss"]`))
        await until(
          async () => missing(`[data-sidebar-row="code"] [role="alert"]`),
          "the words gone",
        )

        // Move: the same, and a move that never landed is never announced.
        await focusOn(gripOf("code"))
        await pressKey("ArrowDown")
        await until(
          async () => wordsOf(refusalIn("code")) === NO_ROOM,
          "the refusal, the second press",
        )
        assert.deepEqual(rowIds(), before, "the rows as they stood")
        assert.equal(wordsOf(liveRegion()), "", "and nothing announced, since nothing moved")
        assert.equal(
          gripOf("code")?.getAttribute("aria-label"),
          "Reorder Code",
          "the grip that was pressed, still in its row and still the way to the order",
        )
        assert.equal(
          document.activeElement?.getAttribute("aria-label"),
          "Reorder Code",
          "still holding the focus, since nothing moved to move it",
        )
      })
    })

    assert.deepEqual(
      (await db.settings.get("settings"))?.sidebarLayout,
      record,
      "the account's record untouched by a write that never landed",
    )
    assert.ok(group(), "the mode still open, the list exactly as it stood")
  })
})

/**
 * An arrangement that is not the default: Meetings first, and Code put away. Reset's question is only
 * a question where there is something to clear.
 */
const ARRANGED = {
  version: 1,
  order: ["meetings", "projects", "code", "canvas", "research"],
  hidden: ["code"],
}

const resetControl = () => find("[data-sidebar-reset]")
const question = () => find('[role="alertdialog"]')
const inQuestion = (label: string) => findText('[role="alertdialog"] button', label)

test("Reset asks first and leaves every pin alone", async () => {
  await seed()
  await seedSettings({
    activeProfileId: bot.id,
    meetings: true,
    sidebarLayout: ARRANGED,
    appearanceAt: 0,
  })
  // A host that would answer an unpin, so a request about a canvas would be seen rather than refused.
  const posts = serveUnpin("unpinned")
  pinnedIds = []
  await mount(sidebarAndStore(), async () => {
    await openMode()
    await until(async () => Boolean(pinRow()), "the pin's row")
    const arranged = rowIds()
    assert.deepEqual(
      arranged,
      ["meetings", "canvas:p1", "projects", "code", "canvas", "research"],
      "the record's arrangement, the pin after the row it follows",
    )

    // The mode's foot: below every row, under the rule that divides the list from what comes after,
    // and one press about the whole list rather than about a row — the app's own button, as tall and
    // as round as the delete control a canvas's screen carries, with a reset's icon inline-start and
    // its words beside it, in the neutral colour rather than the destructive one.
    const reset = resetControl()
    assert.ok(reset, "the mode's own Reset to default")
    assert.equal(
      reset.getAttribute("data-slot"),
      "button",
      "the app's own button, not a bare press",
    )
    assert.equal(wordsOf(reset), "Reset to default", "worded for what it does")
    assert.equal(
      reset.querySelector("svg")?.classList.contains("lucide-rotate-ccw"),
      true,
      "carrying the reset's icon inline-start",
    )
    assert.equal(
      reset.querySelector("svg")?.getAttribute("data-icon"),
      "inline-start",
      "marked as the icon before the words",
    )
    assert.equal(reset.classList.contains("h-11"), true, "44px tall, the delete control's height")
    assert.equal(reset.classList.contains("rounded-full"), true, "and the delete control's radius")
    assert.equal(
      reset.classList.contains("mx-auto"),
      true,
      "centred in the mode's width, so it stands under the middle of the list",
    )
    assert.equal(
      reset.className.includes("bg-secondary"),
      true,
      "in the neutral colour a secondary action wears",
    )
    assert.equal(
      reset.className.includes("bg-destructive"),
      false,
      "not the destructive plate the delete control wears",
    )
    // Nothing divides the foot from the list: the press stands directly under the last row with a
    // small margin and no rule, since a line there would draw the mode's foot as another section.
    assert.equal(
      group()?.querySelector('[data-slot="separator"]'),
      null,
      "no separator inside the mode, above Reset or anywhere else",
    )
    assert.equal(
      reset.className.includes("mt-2"),
      true,
      "a small top margin is the whole of the separation",
    )
    assert.equal(
      reset.previousElementSibling?.getAttribute("data-slot"),
      null,
      "and the thing above it is no separator, but the mode's own live region",
    )
    assert.equal(
      reset.hasAttribute("disabled"),
      false,
      "pressable, since there is an arrangement to clear",
    )

    await click(reset)
    await until(async () => Boolean(question()), "the question")
    assert.equal(
      wordsOf(find('[role="alertdialog"] [data-slot="alert-dialog-title"]')),
      "Reset the sidebar?",
      "the app's one confirmation, asking",
    )
    const body = wordsOf(find('[role="alertdialog"] [data-slot="alert-dialog-description"]'))
    assert.match(body, /usual order/, "what it does: every feature back in its usual order")
    assert.match(body, /hid/, "hidden rows shown again")
    assert.match(body, /pin/i, "and what it does not: no canvas unpinned")

    // While the question stands nothing is written, and no row moves under it.
    assert.deepEqual(
      (await db.settings.get("settings"))?.sidebarLayout,
      ARRANGED,
      "nothing written while the question is open",
    )
    assert.deepEqual(rowIds(), arranged, "the rows exactly where they stood")

    // The question owns Escape while it stands: that press shuts the question, and the mode it was
    // asked from is still there behind it.
    await pressEscape()
    await until(async () => missing('[role="alertdialog"]'), "the question shut by Escape")
    assert.ok(group(), "the mode standing behind it")
    assert.deepEqual(
      (await db.settings.get("settings"))?.sidebarLayout,
      ARRANGED,
      "and nothing written by a question walked away from",
    )

    // Cancel writes nothing at all: the record, its clock, the rows and the pin are as they were.
    await click(resetControl())
    await until(async () => Boolean(question()), "the question, asked again")
    await click(inQuestion("Cancel"))
    await until(async () => missing('[role="alertdialog"]'), "the question shut")
    let stored = await db.settings.get("settings")
    assert.deepEqual(stored?.sidebarLayout, ARRANGED, "Cancel leaves the record")
    assert.equal(stored?.appearanceAt, 0, "and the clock it rides")
    assert.deepEqual(rowIds(), arranged, "the rows as they stood")
    assert.equal(
      find('[data-sidebar-row="code"]')?.hasAttribute("data-hidden"),
      true,
      "Code still put away",
    )

    // The confirm writes the default — the empty record — through the appearance clock, so the
    // account carries it like any other edit, and the mode stays open on the layout it wrote.
    await click(resetControl())
    await until(async () => Boolean(question()), "the question again")
    await click(inQuestion("Reset"))
    await until(async () => missing('[role="alertdialog"]'), "the question answered")
    await until(async () => rowIds()[0] === "projects", "today's order")
    assert.deepEqual(
      rowIds(),
      ["projects", "code", "canvas", "research", "meetings", "canvas:p1"],
      "every feature back in its usual order, Code shown again",
    )
    assert.equal(
      find('[data-sidebar-row="code"]')?.hasAttribute("data-hidden"),
      false,
      "the row no longer put away",
    )
    assert.ok(group(), "the mode stays open on the default layout")
    stored = await db.settings.get("settings")
    assert.deepEqual(stored?.sidebarLayout, DEFAULT_SIDEBAR_LAYOUT, "the default record, written")
    assert.ok((stored?.appearanceAt ?? 0) > 0, "through the appearance clock, as an edit is")
    assert.equal(
      resetControl()?.hasAttribute("disabled"),
      true,
      "and held, since a layout at the default has nothing left to clear",
    )

    // Reset is the layout's and never a pin's: no request went anywhere about a canvas, the store
    // still holds the pin, and the resting sidebar still draws it.
    assert.equal(posts.length, 0, "no request about any canvas")
    assert.deepEqual(pinnedIds, [PINNED_CANVAS.id], "the store still holds the pin")
    await click(doneButton())
    await until(async () => Boolean(editButton()), "the switch at rest")
    assert.deepEqual(
      addresses(),
      ["/projects", "/code", "/canvas", "/research", "/meetings", "/canvas/p1"],
      "and the resting sidebar draws it, pinned, in today's order",
    )
  })
})

/**
 * The phone's drawer at 390px, mounted as `app-shell.tsx` mounts it: an 85vw sheet over the reader's
 * screen, the sidebar expanded inside it, and the door the app's own header opens it through. The
 * shell's drawer passes no `onToggleCollapsed` — which is what the mode reads to draw its switch —
 * and this probe passes none either. The press that opens it stands in for the header's door, and
 * `shutDrawer` is the `onOpenChange` the shell hands the sheet, which is what Base UI calls on the
 * dismissals it makes itself; the sweep's 390px leg presses the real drawer under the real shell.
 */
let shutDrawer: () => void = () => {}

function Drawer() {
  const [open, setOpen] = useState(false)
  // The one thing a mounted page cannot press: the dismissal Base UI makes for a press outside the
  // sheet, which the shell wires to its own `setOpen` and this probe to its state.
  useEffect(() => {
    shutDrawer = () => setOpen(false)
  }, [])
  return (
    <>
      <button type="button" aria-label="Open conversations" onClick={() => setOpen(true)}>
        Menu
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-[85vw] max-w-80 p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Conversations</SheetTitle>
          <ConversationList onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  )
}

/** The drawer while it stands: Base UI's popup, marked open. */
const DRAWER_OPEN = '[role="dialog"][data-open]'

test(
  "the drawer's mode edits the same record, and Escape leaves the mode before the sheet",
  atWidth(390, async () => {
    await seed()
    await mount(
      <MemoryRouter initialEntries={["/"]}>
        <Path />
        <Drawer />
      </MemoryRouter>,
      async () => {
        await click(find('button[aria-label="Open conversations"]'))
        await until(async () => Boolean(find(DRAWER_OPEN)), "the drawer open")
        await until(async () => Boolean(find('nav[aria-label="Main"]')), "its list")

        // The drawer is the sidebar expanded: the switch is drawn, and no collapse control is, since
        // the shell hands the drawer no toggle (a Decision: the rail keeps no switch to come back
        // through). The switch also stands outside the list that scrolls, so no amount of scrolling
        // carries it away from the thumb that opened the mode.
        assert.equal(
          missing('button[aria-label="Edit sidebar"]'),
          false,
          "the drawer draws the mode's switch",
        )
        assert.ok(
          missing('button[aria-label="Collapse sidebar"]'),
          "and grows no collapse control of its own",
        )
        const scrolling = find('nav[aria-label="Main"]')?.closest(".overflow-y-auto")
        assert.equal(Boolean(scrolling), true, "the rows scroll in the list's own box")
        assert.equal(
          scrolling?.contains(editButton()),
          false,
          "which the switch stands outside, however far the list is scrolled",
        )

        await click(editButton())
        await until(async () => Boolean(group()), "the mode in the drawer")

        // At an 85vw sheet the row is the row it rests at, and every control keeps the 44px box a
        // thumb gets and the name that says what it does — the label is what gives way.
        const row = find('[data-sidebar-row="projects"]')
        assert.equal(row?.classList.contains("min-h-11"), true, "the row keeps its resting height")
        assert.equal(
          find("[data-sidebar-grip]")?.classList.contains("w-3"),
          true,
          "the grip is the narrow column's handle",
        )
        assert.equal(
          findAll("[data-sidebar-gutter]").length,
          6,
          "one column on each row the drawer arranges, and none on the bot below it",
        )
        assert.equal(
          find('button[aria-label="Hide Projects"]')?.classList.contains("size-11"),
          true,
          "and the eye 44px, the only control at the row's other end",
        )
        assert.equal(
          wordsOf(find('button[aria-label="Hide Projects"]')),
          "",
          "with no word in it: the glyph says which way the press goes",
        )
        assert.equal(
          row?.querySelector(".truncate")?.classList.contains("min-w-0"),
          true,
          "the name takes what is left and truncates there",
        )
        // A name cut on screen is still whole to a reader who hears the list.
        assert.equal(
          missing('button[aria-label="Reorder A pinned timetable"]'),
          false,
          "a control is named for its whole row, however the row is cut",
        )
        assert.equal(
          missing('button[aria-label="Unpin A pinned timetable"]'),
          false,
          "the pin's own press too",
        )

        // A row pressed in the mode is no destination: arranging never navigates, and never shuts the
        // drawer the reader is arranging in.
        await click(row)
        assert.equal(path(), "/", "a row pressed in the mode navigates nowhere")
        assert.equal(missing(DRAWER_OPEN), false, "and the drawer holds")

        await click(find('button[aria-label="Hide Code"]'))
        await until(async () => Boolean(find('button[aria-label="Show Code"]')), "Code put away")

        // Escape is the mode's while the mode stands: one press leaves it, its focus back on the
        // switch, and the drawer the reader arranged in stays open behind it. The press after that
        // is the sheet's, and shuts it.
        await pressEscape()
        await until(async () => Boolean(editButton()), "the switch at rest, the mode left")
        assert.equal(missing(DRAWER_OPEN), false, "the drawer still open on the press that left it")
        assert.ok(missing('[role="group"][aria-label="Sidebar layout"]'), "and the mode gone")
        assert.ok(document.activeElement === editButton(), "the switch holding the mode's focus")
        assert.ok(missing('nav[aria-label="Main"] a[href="/code"]'), "and Code left the sidebar")

        await pressEscape()
        await until(async () => missing(DRAWER_OPEN), "the drawer shut by the second press")

        // Opened again, the drawer rests: no mode, no Code, and the account still naming it — the
        // record is the sidebar's, and the sheet took only the state that drew it.
        await click(find('button[aria-label="Open conversations"]'))
        await until(async () => Boolean(find(DRAWER_OPEN)), "the drawer opened again")
        await until(async () => Boolean(find('nav[aria-label="Main"]')), "its list again")
        assert.ok(missing('[role="group"][aria-label="Sidebar layout"]'), "it draws resting")
        assert.equal(editButton()?.getAttribute("aria-pressed"), "false", "its switch at rest")
        assert.ok(missing('nav[aria-label="Main"] a[href="/code"]'), "with Code still away")
        assert.deepEqual(
          addresses(),
          ["/projects", "/canvas", "/research", "/meetings", "/canvas/p1"],
          "every other row in its place",
        )
        assert.deepEqual(
          (await db.settings.get("settings"))?.sidebarLayout?.hidden,
          ["code"],
          "the record the drawer's press wrote still names Code",
        )

        // A drawer shut mid-edit opens resting, since the mode is the sidebar's own state and the
        // sheet takes the list with it: the dismissal Base UI makes for a press outside is one way
        // the shell shuts it.
        await click(editButton())
        await until(async () => Boolean(group()), "the mode again")
        await act(async () => shutDrawer())
        await settle()
        await until(async () => missing(DRAWER_OPEN), "the drawer shut with the mode open")
        assert.ok(
          missing('nav[aria-label="Main"]'),
          "the sheet took the sidebar's list with it, the mode inside it",
        )
        await click(find('button[aria-label="Open conversations"]'))
        await until(async () => Boolean(find(DRAWER_OPEN)), "the drawer opened once more")
        assert.ok(
          missing('[role="group"][aria-label="Sidebar layout"]'),
          "and it draws resting, the mode gone with the sheet that held it",
        )
        assert.equal(editButton()?.getAttribute("aria-pressed"), "false", "its switch untouched")
      },
    )
  }),
)
