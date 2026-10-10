import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const appShell = readFileSync(new URL("../src/components/app-shell.tsx", import.meta.url), "utf8")
const sidebar = appShell.match(/<aside\s+className={cn\(\s*"([^"]+)"/)

assert.ok(sidebar, "AppShell sidebar should keep its width classes on the <aside>")
const sidebarClasses = sidebar[1].split(/\s+/)

test("sidebar width keeps its 300ms transition under normal motion", () => {
  assert.ok(sidebarClasses.includes("transition-[width]"))
  assert.ok(sidebarClasses.includes("duration-300"))
})

test("sidebar width transition duration is zero with reduced motion", () => {
  assert.ok(
    sidebarClasses.includes("motion-reduce:duration-0"),
    "reduced-motion sidebar width changes must explicitly set duration to zero",
  )
})
