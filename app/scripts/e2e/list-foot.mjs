// A bot's list's foot (ADR 0141): the button at its right opens New chat and New room as two
// one-line pills standing entirely above it, its face turning from a plus to a cross; and the circle
// at its left becomes a field as tall as that button, with the muted X in the button's own slot
// closing it. Everything asserted here is geometry — a pill clear of the button, a field the button's
// height, a bar that does not grow when the field takes the circle's place — which a DOM without
// layout cannot measure (ADR 0019), so both widths are walked.
import { app, assert, flow, pass } from "./lib.mjs"

const FOOT = '[data-slot="list-foot"]'
const NEW = "[data-new-menu]"
const PICKS = "[data-picks]"

/** The picks' own state, since a closed cluster stays mounted and invisible. */
const picksOpen = async (page) => (await page.locator(PICKS).getAttribute("class"))?.includes("is-shown")

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
  // The rise is the skill's 500ms with a 40ms beat between the two, so the boxes are measured once it
  // has landed: a pill mid-rise is a pill still partly over the button.
  await until(
    async () => {
      const box = await page.getByRole("button", { name: "New chat", exact: true }).boundingBox()
      return Boolean(box) && box.y + box.height <= fab.y + 0.5
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
      box.y + box.height <= fab.y + 0.5,
      `${name} stands entirely above the button, not over it`,
    )
    assert.ok(
      Math.abs(box.x + box.width - (fab.x + fab.width)) <= 1,
      `${name} is right-aligned to the button`,
    )
    assert.ok(box.x >= foot.x && box.x + box.width <= foot.x + foot.width, `${name} is inside the foot`)
    const line = await pill.evaluate((el) => el.getBoundingClientRect().height)
    assert.ok(line <= 48, `${name} is one line tall`)
  }
  await shot("picks")

  await page.keyboard.press("Escape")
  await until(async () => !(await picksOpen(page)), 5_000, "the picks put away")
  assert.equal(await page.locator(`${NEW} .t-icon-swap`).getAttribute("data-state"), "a", "and the cross a plus")

  // The search: the circle is gone, the field is in its place in the same row, the bar keeps its
  // height, and the button wears the muted X that closes it.
  await page.locator("[data-search-toggle]").click()
  await until(async () => (await page.locator("#chats-search").count()) === 1, 5_000, "the field")
  // The field's own frame, not the input inside it: a one-pixel border either side is what makes the
  // input two pixels shorter than the bar it sits in.
  const field = await page.locator('[data-slot="input-group"]').boundingBox()
  const after = await page.locator(FOOT).boundingBox()
  assert.ok(field, "the field is drawn")
  assert.ok(
    Math.abs(field.height - fab.height) <= 1,
    `the field is the button's own height (${field.height} against ${fab.height})`,
  )
  assert.ok(Math.abs(after.height - foot.height) <= 1, "and the foot does not grow for it")
  assert.equal(await page.locator("[data-search-toggle]").count(), 0, "the circle is gone: the field is what it became")
  const close = page.locator("[data-search-close]")
  assert.equal(await close.getAttribute("aria-label"), "Close search", "the button names what it closes")
  assert.match(await close.getAttribute("class"), /bg-muted/, "and is muted, not the screen's accent")
  const closeBox = await close.boundingBox()
  assert.ok(
    Math.abs(closeBox.x - fab.x) <= 1 && Math.abs(closeBox.y - fab.y) <= 1,
    "in the button's own slot, where the thumb already is",
  )
  await page.locator("#chats-search").fill("nothing matches this")
  await shot("search")

  await close.click()
  await until(async () => (await page.locator("#chats-search").count()) === 0, 5_000, "the field put away")
  assert.equal(await page.locator("[data-search-toggle]").count(), 1, "the circle is back in its place")
  assert.equal(await page.locator("#chats-search").count(), 0, "and the query went with the field")
}

for (const width of [390, 1024]) {
  await flow(`list-foot-${width}`, drive, { viewport: { width, height: width === 390 ? 844 : 768 } })
}

pass("the foot's New opens two pills above its button, and its search becomes a bar as tall as it")
