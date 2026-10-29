/**
 * The new chat screen works with Hermes 0.22.5 and newer. On an older one it says so, and asks the
 * host for nothing else: no transcript, no run, no stream.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { fakeHost } from "./chat-next-host.ts"
import { eventually, openDevice, showsEverything, turn, withDevice } from "./chat-next-devices.tsx"

test("a host older than 0.22.5 is told this screen needs a newer one, and asked for nothing else", async () => {
  const host = fakeHost("memento-gate-old", { plugin: true, version: "0.21.5" })
  host.seed([{ user: "earlier", reply: "Earlier.", tools: 1 }])
  await withDevice(openDevice(host), async (phone) => {
    assert.match(phone.notice() ?? "", /Hermes 0\.21\.5/)
    assert.match(phone.notice() ?? "", /0\.22\.5 or newer/)
    assert.equal(phone.turns().length, 0, "nothing of the chat is drawn")
    assert.equal(phone.composer(), false, "and nothing can be sent")
    assert.equal(host.asked.health, 1, "the version was asked once")
    assert.equal(host.asked.transcript, 0, "the transcript was not read")
    assert.equal(host.asked.runs, 0)
    assert.equal(host.asked.subscriptions, 0)
  })
})

test("a host that cannot say its version is not trusted with the screen either", async () => {
  const host = fakeHost("memento-gate-silent", { plugin: true })
  const answer = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    new URL(String(input)).pathname === "/health"
      ? new Response("not json", { status: 500 })
      : answer(input, init)) as typeof fetch
  await withDevice(openDevice(host), async (phone) => {
    assert.match(phone.notice() ?? "", /Couldn't tell which Hermes/)
    assert.equal(host.asked.transcript, 0)
  })
})

test("0.22.5 itself, and a newer host, draw the chat", async () => {
  for (const version of ["0.22.5", "0.23.1"]) {
    const host = fakeHost(`memento-gate-${version}`, { plugin: true, version })
    host.seed([{ user: "earlier", reply: "Earlier.", tools: 1 }])
    await withDevice(openDevice(host), async (phone) => {
      assert.equal(phone.notice(), undefined, version)
      await showsEverything(phone, host, `the chat on ${version}`)
    })
  }
})

test("a host that can't be reached is away, not unsupported: the device draws what it holds", async () => {
  const host = fakeHost("memento-gate-away", { plugin: true })
  const first = await openDevice(host)
  await turn(first, host, "one", "First.")
  await first.close()

  const answer = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch")
  }) as typeof fetch
  try {
    await withDevice(openDevice(host, { database: first.database }), async (again) => {
      assert.equal(again.notice(), undefined, "it is not told the host is too old")
      assert.equal(again.away(), true)
      await showsEverything(again, host, "the chat as this device last saw it")
      assert.equal(again.composer(), false, "nothing can be sent to a host that isn't there")

      globalThis.fetch = answer
      await eventually(() => assert.equal(again.away(), false), "the host is asked again")
      assert.equal(again.composer(), true)
      await showsEverything(again, host, "and the chat goes on from the host")
    })
  } finally {
    globalThis.fetch = answer
  }
})
