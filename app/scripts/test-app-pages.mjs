/**
 * Link resolution: a target that is one of the app's pages resolves, one that is not draws
 * disabled (`scripts/test-app-link.tsx` draws both). The rule is import-free and lives apart from
 * the component so it runs here as a pure rule.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { linkResolves } from "../src/lib/app-pages.ts"

test("a link to one of the app's pages resolves", () => {
  assert.equal(linkResolves(["home", "room"], "room"), true)
  assert.equal(linkResolves(["home", "room"], "home"), true)
})

test("a link to anything else does not resolve", () => {
  assert.equal(linkResolves(["home", "room"], "gone"), false)
  assert.equal(linkResolves(["home", "room"], ""), false)
  assert.equal(linkResolves([], "home"), false)
})
