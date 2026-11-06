/**
 * What the network log names and counts (ADR 0086): a request named by its route and never by its
 * URL, the numbers under a bot's name, and the block a copy hands over — which can carry nothing a
 * row does not already hold.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  clockText,
  endingLabel,
  figuresOf,
  formatNetLog,
  routeOf,
  waitText,
} from "../src/lib/net-log.ts"

const row = (patch) => ({
  id: "r1",
  at: 1_000,
  bots: ["bot-1"],
  route: "GET models",
  ms: 100,
  ending: "answered",
  ...patch,
})

test("a request is named by its route, never by its URL", () => {
  assert.equal(routeOf("http://hermes.test/v1/chat/completions", "POST"), "POST chat/completions")
  assert.equal(
    routeOf(
      "http://hermes.test/api/sessions/1f0c6f2e-0a41-4b8e-9a4a-2a4a2a4a2a4a/messages?limit=50",
    ),
    "GET sessions/:id/messages",
  )
  assert.equal(routeOf("http://hermes.test/api/plugins/gots/events?since=3"), "GET events")
  assert.equal(
    routeOf("http://hermes.test/api/plugins/gots/p/work/sessions/12/queue/7/stop", "POST"),
    "POST sessions/:id/queue/:id/stop",
  )
})

test("nothing a request carried survives into its route", () => {
  const route = routeOf("http://secret-host.test/v1/models?api_key=sk-live-secret")
  assert.equal(route, "GET models")
  assert.doesNotMatch(route, /secret-host|sk-live|api_key|\?/, "no address, key or query")
})

test("a host's minted session id is an id, and a route's own name is not", () => {
  assert.equal(
    routeOf("http://hermes.test/api/sessions/e2e-netlog-dmk73b/agents"),
    "GET sessions/:id/agents",
  )
  assert.equal(
    routeOf("http://hermes.test/api/plugins/gots/sessions/gots-1a2b/triage", "POST"),
    "POST sessions/:id/triage",
  )
})

test("the numbers are read off the requests the log still holds", () => {
  const figures = figuresOf([
    row({ id: "a", at: 1, ms: 100 }),
    row({ id: "b", at: 2, ms: 200 }),
    row({ id: "c", at: 3, ms: 300 }),
    row({ id: "d", at: 4, ms: 400 }),
    row({ id: "e", at: 5, ms: 1000 }),
    row({ id: "f", at: 6, ms: 60_000, ending: "timeout" }),
  ])
  assert.equal(figures.count, 6)
  assert.equal(figures.failed, 1, "a timeout is a failure")
  assert.equal(figures.average, 400, "a minute of waiting for nothing is not an answer's speed")
  assert.equal(figures.slowest, 1000, "the slowest 5% of five answers is the slowest of them")
})

test("the newest stream open and the newest first words are the ones shown", () => {
  const figures = figuresOf([
    row({ id: "a", at: 1, stream: true, frame: 400 }),
    row({ id: "b", at: 2, stream: true, frame: 180 }),
    row({ id: "c", at: 3, words: 2_400, stream: true, frame: 90 }),
  ])
  assert.equal(figures.open, 90, "the newest frame")
  assert.equal(figures.words, 2_400, "the newest send's wait")
})

test("a stream still opening quotes no older one's figure", () => {
  const figures = figuresOf([
    row({ id: "a", at: 1, stream: true, frame: 400 }),
    row({ id: "b", at: 2, stream: true }),
  ])
  assert.equal(figures.open, null, "no number rather than a stale one")
})

test("nothing recorded reads as no number at all", () => {
  const figures = figuresOf([])
  assert.deepEqual(figures, {
    count: 0,
    failed: 0,
    average: null,
    slowest: null,
    open: null,
    words: null,
  })
})

test("a status reads as the code it answered with, or how it ended", () => {
  assert.equal(endingLabel(row({ status: 200 })), "200")
  assert.equal(endingLabel(row({ ending: "refused", status: 502 })), "502")
  assert.equal(endingLabel(row({ ending: "network", status: undefined })), "never landed")
  assert.equal(endingLabel(row({ ending: "timeout" })), "timed out")
  assert.equal(endingLabel(row({ ending: "stopped" })), "stopped")
})

test("a wait reads in milliseconds under a second and in seconds above it", () => {
  assert.equal(waitText(312), "312 ms")
  assert.equal(waitText(1_240), "1.2 s")
  assert.equal(waitText(null), "—")
  assert.match(clockText(Date.UTC(2026, 0, 1, 14, 22, 8)), /14:22:08|22:08/)
})

test("a copied log carries the rows and nothing they did not hold", () => {
  const text = formatNetLog([
    row({ id: "a", at: 1_000, status: 200, stream: true, frame: 120 }),
    row({ id: "b", at: 2_000, ending: "network", status: undefined }),
  ])
  const parsed = JSON.parse(text)
  assert.equal(parsed.kept, 2)
  assert.equal(parsed.requests[0].at, new Date(2_000).toISOString(), "newest first")
  assert.equal(parsed.requests[0].ending, "network")
  assert.equal(parsed.requests[1].frame, 120)
  assert.doesNotMatch(text, /http:|apiKey|api_key|sk-/, "no address, key or URL rides along")
})
