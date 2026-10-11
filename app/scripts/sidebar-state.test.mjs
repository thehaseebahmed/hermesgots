// Sidebar fold state is a per-device convenience, so a fake storage stands in for
// window.localStorage and proves it never leaks into account settings or sync.
import assert from "node:assert/strict"
import test from "node:test"

const SIDEBAR_COLLAPSED_KEY = "memento:sidebar:collapsed"

// Minimal Map-backed Storage double: only the surface loadSidebarCollapsed/saveSidebarCollapsed use.
class FakeStorage {
  constructor() {
    this.data = new Map()
  }
  getItem(key) {
    return this.data.get(key) ?? null
  }
  setItem(key, value) {
    this.data.set(key, String(value))
  }
}

// Storage whose reads and writes throw, like Safari private mode or fully blocked storage.
class ThrowingStorage {
  getItem() {
    throw new Error("storage blocked")
  }
  setItem() {
    throw new Error("storage blocked")
  }
}

test("with no saved preference, loading returns expanded", async () => {
  const { loadSidebarCollapsed } = await import("../src/lib/sidebar.ts")
  assert.equal(loadSidebarCollapsed(new FakeStorage()), false)
})

test("loading returns a saved expanded or collapsed value", async () => {
  const { loadSidebarCollapsed } = await import("../src/lib/sidebar.ts")
  for (const stored of ["true", "false"]) {
    const storage = new FakeStorage()
    storage.setItem(SIDEBAR_COLLAPSED_KEY, stored)
    assert.equal(loadSidebarCollapsed(storage), stored === "true")
  }
})

test("saving then loading round-trips the choice", async () => {
  const { loadSidebarCollapsed, saveSidebarCollapsed } = await import("../src/lib/sidebar.ts")
  for (const value of [true, false]) {
    const storage = new FakeStorage()
    saveSidebarCollapsed(value, storage)
    assert.equal(storage.getItem(SIDEBAR_COLLAPSED_KEY), value ? "true" : "false")
    assert.equal(loadSidebarCollapsed(storage), value)
  }
})

test("the choice is stored in device-local storage under the sidebar key only", async () => {
  const { loadSidebarCollapsed, saveSidebarCollapsed } = await import("../src/lib/sidebar.ts")
  const storage = new FakeStorage()
  saveSidebarCollapsed(true, storage)
  assert.deepEqual([...storage.data.keys()], [SIDEBAR_COLLAPSED_KEY])
  assert.equal(loadSidebarCollapsed(storage), true)
})

test("malformed or out-of-domain saved values fall back to expanded", async () => {
  const { loadSidebarCollapsed } = await import("../src/lib/sidebar.ts")
  for (const stored of [null, "", "yes", "TRUE", "0", "undefined", "{}"]) {
    const storage = new FakeStorage()
    if (stored === null) storage.data.set(SIDEBAR_COLLAPSED_KEY, null)
    else storage.data.set(SIDEBAR_COLLAPSED_KEY, stored)
    assert.equal(loadSidebarCollapsed(storage), false, `stored=${String(stored)}`)
  }
})

test("storage read and write exceptions do not throw", async () => {
  const { loadSidebarCollapsed, saveSidebarCollapsed } = await import("../src/lib/sidebar.ts")
  assert.equal(loadSidebarCollapsed(new ThrowingStorage()), false)
  assert.doesNotThrow(() => saveSidebarCollapsed(true, new ThrowingStorage()))
  assert.doesNotThrow(() => saveSidebarCollapsed(false, new ThrowingStorage()))
})

test("storage accessors are evaluated inside the defensive try block", async () => {
  const { loadSidebarCollapsed, saveSidebarCollapsed } = await import("../src/lib/sidebar.ts")
  let loads = 0
  let saves = 0
  const throwingAccessor = () => {
    loads += 1
    throw new Error("storage unavailable")
  }
  const throwingSaveAccessor = () => {
    saves += 1
    throw new Error("storage unavailable")
  }

  assert.equal(loadSidebarCollapsed(throwingAccessor), false)
  assert.doesNotThrow(() => saveSidebarCollapsed(true, throwingSaveAccessor))
  assert.equal(loads, 1)
  assert.equal(saves, 1)
})

// The expanded widths are the sidebar's existing ones; only collapsed adds a new size.
const SIDEBAR_WIDTH_MD = "18rem"
const SIDEBAR_WIDTH_LG = "20rem"
const SIDEBAR_WIDTH_RAIL = "68px"

test("collapsed sidebar width is the 68px rail", async () => {
  const { sidebarWidth } = await import("../src/lib/sidebar.ts")
  for (const large of [false, true]) {
    assert.equal(sidebarWidth(true, large), SIDEBAR_WIDTH_RAIL, `large=${large}`)
  }
})

test("expanded sidebar widths stay 18rem at md and 20rem at lg", async () => {
  const { sidebarWidth } = await import("../src/lib/sidebar.ts")
  assert.equal(sidebarWidth(false, false), SIDEBAR_WIDTH_MD)
  assert.equal(sidebarWidth(false, true), SIDEBAR_WIDTH_LG)
})

test("toast margins track the sidebar width and vanish when collapsed", async () => {
  const { toastMargin } = await import("../src/lib/sidebar.ts")
  assert.equal(toastMargin(false, false), `calc(${SIDEBAR_WIDTH_MD} / 2)`)
  assert.equal(toastMargin(false, true), `calc(${SIDEBAR_WIDTH_LG} / 2)`)
  assert.equal(toastMargin(true, false), `calc(${SIDEBAR_WIDTH_RAIL} / 2)`)
  assert.equal(toastMargin(true, true), `calc(${SIDEBAR_WIDTH_RAIL} / 2)`)
})
