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
