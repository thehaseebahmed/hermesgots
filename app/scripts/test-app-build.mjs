/**
 * The build's refusal: a host whose plugin predates the `apps` feature answers no app feature, and
 * the screen refuses a build with that reason rather than starting a run (ADR 0101). An answer
 * that hasn't come yet is not an absence, and the Interfaces switch refuses in its own words.
 */
import assert from "node:assert/strict"
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
