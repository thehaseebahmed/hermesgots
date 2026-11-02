import assert from "node:assert/strict"
import test from "node:test"

import { sentryOptions } from "../src/lib/sentry.ts"

const options = sentryOptions("https://key@host/1", "production", "0.97.1 · 8fcdfb7")

test("a report names the build it came from", () => {
  assert.equal(options.dsn, "https://key@host/1")
  assert.equal(options.environment, "production")
  assert.equal(options.release, "0.97.1 · 8fcdfb7")
  assert.equal(options.tracesSampleRate, 0)
})

test("nothing the user typed, or their bot's key, rides along", () => {
  assert.deepEqual(options.dataCollection, {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
  })
})

test("a crash drops the chat's address from the request it keeps", () => {
  const event = {
    request: {
      url: "https://app.example/c/6f1e?key=secret",
      cookies: { session: "abc" },
      headers: { authorization: "Bearer secret" },
      method: "GET",
    },
  }
  const sent = options.beforeSend(event, {})
  assert.deepEqual(sent.request, { method: "GET" })
})

test("a breadcrumb keeps its words and loses the host it was read from", () => {
  const breadcrumb = {
    category: "fetch",
    data: { url: "https://bot.example/v1/sessions/abc/messages", method: "GET", status_code: 200 },
  }
  const kept = options.beforeBreadcrumb(breadcrumb, {})
  assert.deepEqual(kept.data, { method: "GET", status_code: 200 })
})
