// A bot's list's foot (ADR 0141): the button at its right opens New chat and New room as two
// one-line pills standing entirely above it, its face turning from a plus to a cross; and the circle
// at its left becomes a field as tall as that button, filling the row it sits in, with the muted X in
// the button's own slot closing it. Everything asserted here is geometry — a pill clear of the
// button, a field the button's height and the row's width, a bar that does not grow or move when
// either opens — which a DOM without layout cannot measure (ADR 0019), so both widths are walked.
import { app, assert, flow, pass } from "./lib.mjs"

const FOOT = '[data-slot="list-foot"]'
const NEW = "[data-new-menu]"
const PICKS = "[data-picks]"

/**
 * The picks' own state, read off the attributes the component test reads too: a closed cluster stays
 * mounted, so its presence in the tree says nothing.
 */
const picksOpen = async (page) =>
  (await page.locator(PICKS).getAttribute("aria-hidden")) === "false" &&
  !(await page.locator(PICKS).evaluate((el) => el.hasAttribute("inert")))

/** Where the focus is, named by the attribute that says what the control is. */
const focused = (page, attribute) =>
  page.evaluate((a) => document.activeElement?.hasAttribute(a) ?? false, attribute)

async function drive({ page, profileId, until, shot }) {
  await page.goto(`${app}/b/${profileId}`)
  await until(async () => (await page.locator(NEW).count()) === 1, 30_000, "the foot's button")

  const fab = await page.locator(NEW).boundingBox()
  const foot = await page.locator(FOOT).boundingBox()
  assert.ok(fab && foot, "the button stands on the foot's bar")
  assert.equal(await page.locator("#chats-search").count(), 0, "no field until it is asked for")
  await shot("closed")

  // The picks: New chat nearest the thumb, New room above it, both entirely above the button and
  // right-aligned to it, one line each and inside the foot's width.
  await page.locator(NEW).click()
  await until(() => picksOpen(page), 5_000, "the picks")
  assert.equal(await page.locator(`${NEW} .t-icon-swap`).getAttribute("data-state"), "b", "the plus is a cross")
  // The cluster hangs above the button rather than in the foot's own box, so the bar neither grows nor
  // moves its button when it opens.
  const openedFoot = await page.locator(FOOT).boundingBox()
  const openedFab = await page.locator(NEW).boundingBox()
  assert.ok(
    Math.abs(openedFoot.height - foot.height) <= 1 && Math.abs(openedFab.y - fab.y) <= 1,
    "the foot and its button hold still while the picks are up",
  )
  // The rise is the skill's 500ms with a 40ms beat between the two, so the boxes are measured once it
  // has landed: a pill mid-rise is a pill still partly over the button.
  await until(
    async () => {
      const box = await page.getByRole("button", { name: "New chat", exact: true }).boundingBox()
      return Boolean(box) && box.y + box.height <= openedFab.y + 0.5
    },
    5_000,
    "the picks to finish rising",
  )
  const names = await page.locator(`${PICKS} button`).evaluateAll((els) =>
    els.map((el) => el.getAttribute("aria-label")),
  )
  assert.deepEqual(names, ["New room", "New chat"], "the two starters, New chat nearest the button")
  for (const name of names) {
    const pill = page.getByRole("button", { name, exact: true })
    const box = await pill.boundingBox()
    assert.ok(box, `${name} is drawn`)
    assert.ok(
      box.y + box.height <= openedFab.y + 0.5,
      `${name} stands entirely above the button, not over it`,
    )
    assert.ok(
      Math.abs(box.x + box.width - (openedFab.x + openedFab.width)) <= 1,
      `${name} is right-aligned to the button`,
    )
    assert.ok(
      box.x >= foot.x && box.x + box.width <= foot.x + foot.width,
      `${name} is inside the foot`,
    )
    // One line: the label neither wraps nor runs out of its pill, which a fixed height would hide.
    const overflow = await pill.evaluate((el) => el.scrollWidth - el.clientWidth)
    assert.ok(overflow <= 0, `${name}'s label stays on one line inside its pill (${overflow}px over)`)
  }
  await shot("picks")

  await page.keyboard.press("Escape")
  await until(async () => !(await picksOpen(page)), 5_000, "the picks put away")
  assert.equal(await page.locator(`${NEW} .t-icon-swap`).getAttribute("data-state"), "a", "and the cross a plus")
  await until(() => focused(page, "data-new-menu"), 3_000, "the focus back on the button")

  // A keyboard reaches the search circle while the picks are up, where a tap cannot: the foot then
  // holds one surface, not both.
  await page.locator(NEW).click()
  await until(() => picksOpen(page), 5_000, "the picks again")
  await page.locator("[data-search-toggle]").focus()
  await page.keyboard.press("Enter")
  await until(async () => (await page.locator("#chats-search").count()) === 1, 5_000, "the field")
  await until(async () => !(await picksOpen(page)), 3_000, "the picks put away for the field")

  // The search: the circle is gone, the field fills its place in the same row, the bar keeps its
  // height, and the button wears the muted X that closes it.
  const field = await page.locator('[data-slot="input-group"]').boundingBox()
  const searchingFoot = await page.locator(FOOT).boundingBox()
  assert.ok(field, "the field is drawn")
  assert.ok(
    Math.abs(field.height - fab.height) <= 1,
    `the field is the button's own height (${field.height} against ${fab.height})`,
  )
  assert.ok(
    Math.abs(searchingFoot.height - foot.height) <= 1,
    "and the foot does not grow for it",
  )
  assert.ok(
    Math.abs(field.x - (foot.x + 16)) <= 1,
    `the field starts at the foot's own edge (${field.x} against ${foot.x + 16})`,
  )
  assert.ok(field.width > foot.width / 2, "and takes the row, rather than sitting in the circle's box")
  assert.equal(await page.locator("[data-search-toggle]").count(), 0, "the circle is gone: the field is what it became")
  const close = page.locator("[data-search-close]")
  assert.equal(await close.getAttribute("aria-label"), "Close search", "the button names what it closes")
  assert.match(await close.getAttribute("class"), /bg-muted/, "and is muted, not the screen's accent")
  const closeBox = await close.boundingBox()
  assert.ok(
    Math.abs(closeBox.x - fab.x) <= 1 && Math.abs(closeBox.y - fab.y) <= 1,
    "in the button's own slot, where the thumb already is",
  )
  assert.ok(
    Math.abs(field.y + field.height / 2 - (closeBox.y + closeBox.height / 2)) <= 1,
    "and the field and the button share one centre line, so the bar reads as one row",
  )
  await page.locator("#chats-search").fill("nothing matches this")
  await shot("search")

  await close.click()
  await until(async () => (await page.locator("#chats-search").count()) === 0, 5_000, "the field put away")
  assert.equal(await page.locator("[data-search-toggle]").count(), 1, "the circle is back in its place")
  await until(() => focused(page, "data-search-toggle"), 3_000, "with the focus on it")

  // The query goes with the field: a reopened search starts empty rather than filtering the list by
  // words the reader can no longer see.
  await page.locator("[data-search-toggle]").click()
  await until(async () => (await page.locator("#chats-search").count()) === 1, 5_000, "the field again")
  assert.equal(await page.locator("#chats-search").inputValue(), "", "and it is empty")
}

// Both widths, and the phone in the dark as well: the foot's surfaces are theme tokens, and a muted X
// that reads as disabled on one theme is the risk the plan names.
for (const { width, dark } of [
  { width: 390, dark: false },
  { width: 390, dark: true },
  { width: 1024, dark: false },
  { width: 1024, dark: true },
]) {
  await flow(`list-foot-${width}${dark ? "-dark" : ""}`, drive, {
    viewport: { width, height: width === 390 ? 844 : 768 },
    dark,
  })
}

pass("the foot's New opens two pills above its button, and its search becomes a bar as tall as it")
