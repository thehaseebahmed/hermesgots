import assert from "node:assert/strict"
import test from "node:test"

test("collapsed rail actions expose an accessible name and hover title", async () => {
  const { sidebarItemAccessibility } = await import("../src/lib/sidebar.ts")

  assert.deepEqual(sidebarItemAccessibility("Code", true), {
    title: "Code",
    "aria-label": "Code",
  })
  assert.deepEqual(sidebarItemAccessibility("New chat", true), {
    title: "New chat",
    "aria-label": "New chat",
  })
})

test("expanded sidebar keeps accessible names without redundant tooltips", async () => {
  const { sidebarItemAccessibility } = await import("../src/lib/sidebar.ts")
  const newChat = sidebarItemAccessibility("New chat", false)

  assert.deepEqual(newChat, { "aria-label": "New chat" })
  assert.equal("title" in newChat, false)
})
