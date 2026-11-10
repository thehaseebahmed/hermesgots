import assert from "node:assert/strict"
import test from "node:test"

import { NO_PEER, SANDBOX_CSP, SUBMIT_IN_PLACE, findHead, sandboxedDocument } from "../src/lib/sandboxed-document.ts"

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
