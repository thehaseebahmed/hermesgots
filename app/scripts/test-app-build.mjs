/**
 * The build's refusal: a host whose plugin predates the `apps` feature answers no app feature, and
 * the screen refuses a build with that reason rather than starting a run (ADR 0101). An answer
 * that hasn't come yet is not an absence, and the Interfaces switch refuses in its own words.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { buildBlocked } from "../src/lib/app-build.ts"

test("a host whose plugin predates the feature refuses a build with its reason", () => {
  assert.equal(buildBlocked("no", true), "This bot can't make apps")
  assert.equal(buildBlocked("no", undefined), "This bot can't make apps")
})

test("a host that answers for apps blocks nothing", () => {
  assert.equal(buildBlocked("yes", true), undefined)
  assert.equal(buildBlocked("yes", undefined), undefined)
})

test("a host that has not answered yet is not read as a no", () => {
  assert.equal(buildBlocked("unknown", true), undefined)
})

test("the Interfaces switch off refuses a build in its own words", () => {
  assert.equal(buildBlocked("yes", false), "Interfaces are turned off")
  assert.equal(buildBlocked("unknown", false), "Interfaces are turned off")
})

test("a switch not read yet is not an off", () => {
  assert.equal(buildBlocked("yes", undefined), undefined)
})

const block = (id) => `\`\`\`openui-lang\n# id: ${id}\nroot = Stack([])\n\`\`\``

test("a build answering three blocks makes three pages, the first the root", async () => {
  const { pagesOf } = await import("../src/lib/app-build.ts")
  const built = pagesOf(`Here:\n\n${block("home")}\n\n${block("room")}\n\n${block("trend")}\n`)
  assert.equal(built.error, undefined)
  assert.equal(built.pages.length, 3)
  assert.match(built.pages[0], /^# id: home/)
  assert.match(built.pages[2], /^# id: trend/)
})

test("an answer that broke off mid-block, or carries none, keeps nothing", async () => {
  const { pagesOf } = await import("../src/lib/app-build.ts")
  const broken = pagesOf(`${block("home")}\n\n\`\`\`openui-lang\n# id: room\nroot = Sta`)
  assert.ok(broken.error && !broken.pages)
  assert.ok(pagesOf("I could not.").error)
})

test("the consent is read off the pages' own queries and mutations", async () => {
  const { consentOf } = await import("../src/lib/app-build.ts")
  const consent = consentOf([
    'a = Query("light.list", {}, {})\nb = Mutation("light.set", {})',
    'c = Query("light.list", {}, {})\nd = Query("temp.read", {}, {})',
  ])
  assert.deepEqual(consent, { reads: ["light.list", "temp.read"], acts: ["light.set"] })
  assert.deepEqual(consentOf(["root = Stack([])"]), { reads: [], acts: [] })
  const cases = JSON.parse(
    readFileSync(new URL("../../plugin/tests/consent-cases.json", import.meta.url), "utf8"),
  )
  for (const one of cases)
    assert.deepEqual(consentOf(one.sources), one.consent, `${one.name}: the host reads the same`)
})

test("a title is the prompt's first line, cut at a word when long", async () => {
  const { titleOf } = await import("../src/lib/app-build.ts")
  assert.equal(titleOf("  A home dashboard\nwith rooms"), "A home dashboard")
  const long = titleOf("a ".repeat(60))
  assert.ok(long.length <= 61 && long.endsWith("…"))
})

test("a change answering one block is its source; two blocks, none, or a broken-off one is refused", async () => {
  const { changeOf, changePrompt } = await import("../src/lib/app-build.ts")
  assert.deepEqual(changeOf(`Done:\n\n${block("home")}\n`), {
    source: "# id: home\nroot = Stack([])",
  })
  assert.match(changeOf(`${block("home")}\n\n${block("room")}`).error, /more than one/)
  assert.ok(changeOf("No.").error)
  assert.match(changeOf("```openui-lang\n# id: home\nroot = Sta").error, /broke off/)
  assert.match(changePrompt(" bigger ", "root = Stack([])"), /bigger[\s\S]*root = Stack\(\[\]\)/)
})
