import assert from "node:assert/strict"
import test from "node:test"

import { stateLine } from "../src/lib/bot-chrome.ts"

const MINUTE = 60_000
const NOW = 1_000_000_000
/** A bot on a linked host this device heard from a minute ago. */
const bot = (patch = {}) => ({ hostId: "host-1", seenAt: NOW - MINUTE, ...patch })

test("a bot's row says its state, and never nothing at all", () => {
  assert.equal(stateLine({ unread: 0, bot: bot(), now: NOW }), "Online", "a host checking in")
  assert.equal(
    stateLine({ unread: 0, bot: bot({ seenAt: NOW - 26 * MINUTE }), now: NOW }),
    "Offline",
    "a host that has gone stale",
  )
  assert.equal(
    stateLine({ unread: 0, bot: bot(), now: NOW, answer: "unreachable" }),
    "Offline",
    "a pass that got no answer from a host this device has heard before",
  )
  assert.equal(
    stateLine({ unread: 0, bot: bot({ seenAt: undefined }), now: NOW }),
    "Not seen yet",
    "a linked host nothing has answered from",
  )
  assert.equal(
    stateLine({ unread: 0, bot: bot({ seenAt: undefined }), now: NOW, answer: "unreachable" }),
    "Not seen yet",
    "a failed pass says nothing about a host this device has never heard",
  )
  assert.equal(
    stateLine({ unread: 0, bot: bot({ hostId: undefined }), now: NOW }),
    "Not linked",
    "a bot no host registered",
  )
  assert.equal(stateLine({ unread: 1, bot: bot(), now: NOW }), "1 unread", "one conversation past the mark")
  assert.equal(
    stateLine({ unread: 12, bot: bot({ seenAt: NOW - 26 * MINUTE }), now: NOW }),
    "12 unread",
    "and every one of them",
  )
  assert.equal(
    stateLine({ unread: 2, bot: bot({ hostId: undefined }), now: NOW }),
    "2 unread",
    "unread outranks what this device knows about the host",
  )
})
