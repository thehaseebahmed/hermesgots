/**
 * The style guide at `/docs/style-guide`: every token `DESIGN.md` declares is drawn once, every
 * section it has is on the page, the live components are mounted, and a device whose Developer
 * switch is off lands on Settings instead. The look itself is a screenshot's (ADR 0019).
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { parseDesign } from "@/lib/design-spec"
import { StyleGuidePage } from "@/routes/docs/style-guide"
import {
  Path,
  find,
  findAll,
  missing,
  mountMarkdown,
  path,
  seedSettings,
} from "./component-kit.tsx"

const spec = parseDesign(readFileSync(new URL("../../DESIGN.md", import.meta.url), "utf8"))

const screen = () => (
  <MemoryRouter initialEntries={["/docs/style-guide"]}>
    <Path />
    <Routes>
      <Route path="/settings" element={<p>settings</p>} />
      <Route path="/settings/developer" element={<p>developer</p>} />
      <Route path="docs/style-guide" element={<StyleGuidePage />} />
    </Routes>
  </MemoryRouter>
)

test("the page draws every token and section DESIGN.md declares", async () => {
  await seedSettings({ developer: true })
  await mountMarkdown(screen(), async () => {
    for (const section of spec.sections)
      assert.ok(
        findAll("[data-style-section] h2").some((heading) => heading.textContent === section.title),
        `a section for ${section.title}`,
      )
    for (const [attribute, tokens] of [
      ["data-color-token", spec.colors],
      ["data-type-token", spec.typography],
      ["data-radius-token", spec.rounded],
      ["data-spacing-token", spec.spacing],
    ] as const)
      for (const token of Object.keys(tokens))
        assert.equal(findAll(`[${attribute}="${token}"]`).length, 1, `${attribute} ${token}`)
  })
})

test("the live components are mounted", async () => {
  await seedSettings({ developer: true })
  await mountMarkdown(screen(), async () => {
    for (const name of ["Button", "Banner", "Card", "Pick rows", "Settings group", "Pop-ups"])
      assert.ok(find(`[data-specimen="${name}"]`), name)
  })
})

test("with the Developer switch off the address falls back to Settings", async () => {
  await seedSettings({ developer: false })
  await mountMarkdown(screen(), async () => {
    assert.equal(path(), "/settings")
    assert.ok(missing("[data-style-section]"), "none of the guide is drawn")
  })
})
