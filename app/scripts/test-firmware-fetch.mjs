/**
 * The charm's fetch door, as the phone builds it: the URL the update hands the charm — the host
 * address the voice hand-over already keeps, https over the charm's Wi-Fi or plain http over its
 * tailnet, with the short-lived fetch token in it (`src/lib/firmware-fetch.ts`; the mint itself is
 * `getCharmFirmwareFetchToken`'s own business in hermes.ts, the way the streamed read is
 * `getCharmFirmwareImage`'s).
 *
 * The host's own two routes are pinned twice: the real rules in `plugin/tests` (`test_fetch_tokens`
 * for the mint kind and its short life, `test_firmware` for the routes, including the plan's own
 * decision that a firmware mint never revokes a live voice token), and here against the dev mock
 * (`scripts/mock-hermes.mjs`), which serves them for the Android app a browser flow can't reach —
 * mint → token, the charm's fetch → the image's bytes, an unknown or expired token refused.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import net from "node:net"
import test from "node:test"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { firmwareFetchToken, firmwareFetchUrl } from "../src/lib/firmware-fetch.ts"

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, "..")

const TOKEN = "1f".repeat(32)
const IMAGE_ROUTE = "/charm/firmware/image/fetch"

test("the charm's fetch URL is the host the voice hand-over kept, with the token in it", () => {
  assert.equal(
    firmwareFetchUrl("https://bot.example/api/plugins/gots", TOKEN),
    `https://bot.example/api/plugins/gots${IMAGE_ROUTE}?token=${TOKEN}`,
    "the Wi-Fi door: the recorded address, the image route's tokened variant, the token",
  )
  assert.equal(
    firmwareFetchUrl("http://100.64.0.9:8642/api/plugins/gots/", TOKEN),
    `http://100.64.0.9:8642/api/plugins/gots${IMAGE_ROUTE}?token=${TOKEN}`,
    "the tailnet door is plain http, and the trailing slash is one the charm would double",
  )
})

test("a base that is neither door's scheme is refused before any connection is opened", () => {
  for (const base of ["", "  ", "bot.example/api/plugins/gots", "ftp://files.example/gots"]) {
    assert.throws(
      () => firmwareFetchUrl(base, TOKEN),
      /https/,
      `${JSON.stringify(base)} is not an address the charm can dial`,
    )
  }
})

test("a URL past the charm's own bound is refused", () => {
  const long = `https://${"a".repeat(170)}.example/api/plugins/gots`
  assert.throws(() => firmwareFetchUrl(long, TOKEN), /180 bytes/)
})

test("a token that is nothing is refused rather than hung on the door", () => {
  assert.throws(() => firmwareFetchUrl("https://bot.example/api/plugins/gots", ""), /token/)
})

test("the token the host answers is read once, or the answer is refused as unreadable", () => {
  assert.equal(firmwareFetchToken({ object: "gots.charm_firmware_fetch", token: TOKEN }), TOKEN)
  for (const body of [{}, { token: "" }, { token: 7 }, null]) {
    assert.throws(() => firmwareFetchToken(body), /unreadable/)
  }
})

/** A port the mock can listen on, borrowed for the moment the spawn needs it. */
function freePort() {
  return new Promise((done, fail) => {
    const server = net.createServer()
    server.on("error", fail)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => done(port))
    })
  })
}

/** Waits for the mock's own health answer, so a boot that never comes fails the test, not the fetch. */
async function untilUp(origin, ms = 10_000) {
  for (const end = Date.now() + ms; ; ) {
    try {
      const asked = await fetch(`${origin}/health`)
      if (asked.ok) return
    } catch {
      /* still booting */
    }
    if (Date.now() > end) assert.fail(`the mock never came up on ${origin}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

test("the dev mock's fetch door: a mint answers a token, the charm's fetch serves the image", async () => {
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  // A short life for the token, so an expired door can be watched without waiting out ten minutes.
  const mock = spawn(process.execPath, ["scripts/mock-hermes.mjs"], {
    cwd: appDir,
    env: { ...process.env, PORT: String(port), MOCK_CHARM_FETCH_MS: "250" },
    stdio: "ignore",
  })
  try {
    await untilUp(origin)
    const minted = await fetch(`${origin}/api/plugins/gots/charm/firmware/fetch`, {
      method: "POST",
    })
    assert.equal(minted.status, 200)
    const answer = await minted.json()
    assert.equal(answer.object, "gots.charm_firmware_fetch")
    assert.match(answer.token, /^[0-9a-f]{64}$/, "a token the phone can put in the URL")

    const url = firmwareFetchUrl(`${origin}/api/plugins/gots`, answer.token)
    assert.equal(url, `${origin}/api/plugins/gots${IMAGE_ROUTE}?token=${answer.token}`)
    const served = await fetch(url)
    assert.equal(served.status, 200)
    const image = Buffer.from(await served.arrayBuffer())
    assert.ok(image.length > 0, "the mock's image is bytes, not a promise")
    assert.equal(served.headers.get("content-length"), String(image.length))
    assert.equal(served.headers.get("content-type"), "application/octet-stream")

    const again = await fetch(url)
    assert.deepEqual(
      Buffer.from(await again.arrayBuffer()),
      image,
      "the same image behind the door every walk",
    )

    for (const wrong of ["", "0".repeat(64), answer.token.slice(0, 63)]) {
      const refused = await fetch(`${origin}/api/plugins/gots${IMAGE_ROUTE}?token=${wrong}`)
      assert.equal(refused.status, 401, `a token nobody minted (${JSON.stringify(wrong)})`)
      assert.equal((await refused.json()).error.code, "bad_token")
    }

    await new Promise((done) => setTimeout(done, 400))
    const expired = await fetch(url)
    assert.equal(expired.status, 401, "a token past its short life is shut again")
    assert.equal((await expired.json()).error.code, "bad_token")
  } finally {
    mock.kill()
  }
})

test("the dev mock refuses a token with the plugin's own words", () => {
  // The Android app is the only caller of these routes, so no browser flow reaches the mock's —
  // the words are held to the plugin's, since a reader shown a different sentence than the host
  // says would be reading a screen this app never shows (the pattern `test-push-message.mjs` set).
  const mock = readFileSync(resolve(here, "mock-hermes.mjs"), "utf8")
  const plugin = readFileSync(resolve(appDir, "../plugin/__init__.py"), "utf8")
  const said = "This fetch token isn't one this host minted, or its short life is past."
  assert.ok(plugin.includes(said), "the plugin refuses a token with these words")
  assert.ok(mock.includes(said), "and the mock answers the refusal the same way")
})
