import assert from "node:assert/strict"
import test from "node:test"

import {
  NO_PEER,
  SANDBOX_CSP,
  SUBMIT_IN_PLACE,
  findHead,
  folderPolicy,
  previewerPage,
  sandboxedDocument,
} from "../src/lib/sandboxed-document.ts"

const PREFIX = (policy) =>
  `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
  `<script>${NO_PEER}</script><script>${SUBMIT_IN_PLACE}</script>`

test("the policy and safety scripts go first in the page's head, in order", () => {
  const html = sandboxedDocument(`<html><head><title>a</title></head><body></body></html>`, { policy: SANDBOX_CSP })
  assert.equal(html, `<html><head>${PREFIX(SANDBOX_CSP)}<title>a</title></head><body></body></html>`)
})

test("the policy is the caller's", () => {
  const html = sandboxedDocument(`<head></head>`, { policy: "default-src 'none'" })
  assert.ok(html.startsWith(`<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'">`))
})

test("a caller's styles go after the policy and its scripts after the safety ones", () => {
  const html = sandboxedDocument(`<head></head>`, { policy: "p", afterPolicy: "<style>s</style>", afterSafety: "<script>x</script>" })
  assert.equal(
    html,
    `<head><meta http-equiv="Content-Security-Policy" content="p"><style>s</style>` +
      `<script>${NO_PEER}</script><script>${SUBMIT_IN_PLACE}</script><script>x</script></head>`,
  )
})

test("a head mentioned in a comment is not the head", () => {
  const page = `<!-- <head> --><head data-x="1"></head>`
  assert.deepEqual(findHead(page), { index: page.indexOf(`<head data`), length: `<head data-x="1">`.length })
  assert.equal(findHead(`<!-- <head>`), null)
})

test("markup with no head gets one prepended, so the policy still comes first", () => {
  assert.equal(sandboxedDocument(`<p>hi</p>`, { policy: "p" }), `<head>${PREFIX("p")}</head><p>hi</p>`)
})

test("a sandboxed page allows https images and blocks everything else remote", () => {
  const rules = Object.fromEntries(
    SANDBOX_CSP.split(";").map((rule) => {
      const [name, ...sources] = rule.trim().split(/\s+/)
      return [name, sources]
    }),
  )
  assert.deepEqual(rules["img-src"], ["data:", "blob:", "https:"])
  assert.deepEqual(rules["default-src"], ["'none'"])
  assert.deepEqual(rules["script-src"], ["'unsafe-inline'"])
  assert.deepEqual(rules["style-src"], ["'unsafe-inline'"])
  assert.deepEqual(rules["font-src"], ["data:"])
  assert.deepEqual(rules["connect-src"], ["'none'"])
  assert.deepEqual(rules["frame-src"], ["'none'"])
  assert.deepEqual(rules["form-action"], ["'none'"])
  assert.ok(!/\bhttp:/.test(SANDBOX_CSP))
})

const rulesOf = (policy) =>
  Object.fromEntries(
    policy.split(";").map((rule) => {
      const [name, ...sources] = rule.trim().split(/\s+/)
      return [name, sources]
    }),
  )

test("a previewer page has its base and host origin, and a canvas has neither", async () => {
  const folder = "https://host.test/api/plugins/gots/media/page/Zm9v.1.abc/"
  const html = previewerPage(`<html><head><link rel="stylesheet" href="style.css"></head></html>`, folder)
  const policy = folderPolicy(folder)
  assert.equal(
    html,
    `<html><head><meta http-equiv="Content-Security-Policy" content="${policy}">` +
      `<base href="${folder}"><script>${NO_PEER}</script><script>${SUBMIT_IN_PLACE}</script>` +
      `<link rel="stylesheet" href="style.css"></head></html>`,
  )
  const rules = rulesOf(policy)
  for (const name of ["script-src", "style-src", "img-src", "font-src"])
    assert.ok(rules[name].includes("https://host.test"), name)
  assert.deepEqual(rules["connect-src"], ["'none'"])
  assert.deepEqual(rules["frame-src"], ["'none'"])
  assert.deepEqual(rules["form-action"], ["'none'"])
  assert.deepEqual(rules["default-src"], ["'none'"])

  // A staged page has no folder: the plain sandbox, no base.
  const staged = previewerPage(`<head></head>`)
  assert.ok(!staged.includes("<base"))
  assert.ok(staged.includes(`content="${SANDBOX_CSP}"`))

  // A canvas has neither.
  const { canvasDocument, TOKENS } = await import("../src/lib/canvas-document.ts")
  const tokens = Object.fromEntries(TOKENS.map((name) => [name, "#000"]))
  const canvas = canvasDocument(`<html><head></head><body></body></html>`, { mode: "light", tokens })
  assert.ok(!canvas.includes("<base"))
  assert.ok(canvas.includes(`content="${SANDBOX_CSP}"`))
})

test("a folder that would break out of its attribute is escaped", () => {
  const html = previewerPage(`<head></head>`, `https://host.test/a"><script>x</script>/`)
  assert.ok(!html.includes(`"><script>x`))
})
