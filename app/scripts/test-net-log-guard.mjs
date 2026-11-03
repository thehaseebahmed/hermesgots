/**
 * The one thing both chat screens' clients must not grow: a request of their own. Every call to a
 * bot's host goes through the network log's wrapper (ADR 0086), so the recorder sees it and the
 * transports cannot drift apart. A bare `fetch(` here is the failure this test exists for.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const TRANSPORTS = ["src/lib/hermes.ts", "src/chat-next/api.ts"]

/** A fetch that is not the recorder's: `netFetch(` and `globalThis.fetch(` are both fine. */
const BARE = /(?<![\w.])fetch\(/g

for (const file of TRANSPORTS)
  test(`${file} asks for a request through the network log's wrapper`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
    const bare = [...source.matchAll(BARE)].map((match) => match.index)
    assert.deepEqual(bare, [], `${file} makes a request the network log cannot see`)
  })
