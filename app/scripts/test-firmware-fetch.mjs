/**
 * The charm's fetch door, as the phone builds it: the URL the update hands the charm — the host
 * address the voice hand-over already keeps, https over the charm's Wi-Fi or plain http over its
 * tailnet, with the short-lived fetch token in it (`src/lib/firmware-fetch.ts`; the mint itself is
 * `getCharmFirmwareFetch`'s own business in hermes.ts, the way the streamed read is
 * `getCharmFirmwareImage`'s).
 *
 * The image route's path is the host's answer, never this app's constant: the mint names it beside
 * the token, so the tests below hand the builder a path a host could answer and then hold the dev
 * mock to the plugin's own spelling of it — a renamed or re-prefixed route on the host crosses to
 * the charm through that one answer, with nothing here to chase by hand.
 *
 * The host's own two routes are pinned twice: the real rules in `plugin/tests` (`test_fetch_tokens`
 * for the mint kind and its short life, `test_firmware` for the routes, including the plan's own
 * decision that a firmware mint never revokes a live voice token), and here against the dev mock
 * (`scripts/mock-hermes.mjs`), which serves them for the Android app a browser flow can't reach —
 * mint → token and path, the charm's fetch → the image's bytes, an unknown or expired token refused.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import net from "node:net"
import test from "node:test"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { CharmLinkState } from "../src/lib/charm-protocol.ts"
import { firmwareDoor, firmwareFetchAnswer, firmwareFetchUrl } from "../src/lib/firmware-fetch.ts"

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, "..")

const TOKEN = "1f".repeat(32)
// A route as a host answers one, chosen here rather than taken from the plugin: the builder reads
// whatever the host names, and the mock round trip below holds the plugin's own spelling.
const HOST_PATH = "/charm/firmware/v2/image/fetch"
// A mint's answer as the app holds it after reading the host's body: the token and the route it
// walks, in one value, so the builder cannot be handed them in the other order.
const ANSWER = { token: TOKEN, path: HOST_PATH }

/** A string constant the plugin writes once, read from its own source: one spelling to hold to. */
function pluginConstant(name) {
  const found = new RegExp(`^${name}\\s*=\\s*"([^"]+)"$`, "m").exec(
    readFileSync(resolve(appDir, "../plugin/__init__.py"), "utf8"),
  )
  assert.ok(found, `the plugin still writes ${name}`)
  return found[1]
}

test("the charm's fetch URL is the host the voice hand-over kept, with the token in it", () => {
  assert.equal(
    firmwareFetchUrl("https://bot.example/api/plugins/gots", ANSWER),
    `https://bot.example/api/plugins/gots${HOST_PATH}?token=${TOKEN}`,
    "the Wi-Fi door: the recorded address, the route the host answered, the token",
  )
  assert.equal(
    firmwareFetchUrl("http://100.64.0.9:8642/api/plugins/gots/", ANSWER),
    `http://100.64.0.9:8642/api/plugins/gots${HOST_PATH}?token=${TOKEN}`,
    "the tailnet door is plain http, and the trailing slash is one the charm would double",
  )
  assert.equal(
    firmwareFetchUrl("HTTPS://bot.example/api/plugins/gots", ANSWER),
    `https://bot.example/api/plugins/gots${HOST_PATH}?token=${TOKEN}`,
    "the scheme lowercased: the voice row keeps the case the reader typed and the charm's own talk door folds it, but its update door reads the scheme case-exactly",
  )
})

test("a base that is neither door's scheme is refused before any connection is opened", () => {
  for (const base of ["", "  ", "bot.example/api/plugins/gots", "ftp://files.example/gots"]) {
    assert.throws(
      () => firmwareFetchUrl(base, ANSWER),
      /https/,
      `${JSON.stringify(base)} is not an address the charm can dial`,
    )
  }
})

test("the route the host answers is read as a route under its own root, or refused", () => {
  for (const path of [
    "",
    "/",
    "/..",
    "/./fetch",
    "charm/firmware/image/fetch",
    "/charm/firmware/image/fetch/",
    "/charm/firmware//image/fetch",
    "//evil.example/fetch",
    "https://evil.example/fetch",
    "/charm/firmware/image/fetch?token=x",
    "/charm/firmware/image/fetch#frag",
    "/charm firmware/image/fetch",
    "/api/plugins/gots/charm/firmware/image/fetch",
  ]) {
    assert.throws(
      () => firmwareFetchAnswer({ token: TOKEN, path }),
      /fetch route was unreadable/,
      `${JSON.stringify(path)} is not a route the phone can hang off the host's root`,
    )
  }
  assert.equal(
    firmwareFetchUrl("https://bot.example/api/plugins/gots", {
      token: TOKEN,
      path: "/charm/firmware/fetch",
    }),
    `https://bot.example/api/plugins/gots/charm/firmware/fetch?token=${TOKEN}`,
    "any route the host names is walked as it is, not one this app knows by name",
  )
})

test("a URL past the charm's own bound is refused", () => {
  const long = `https://${"a".repeat(170)}.example/api/plugins/gots`
  assert.throws(() => firmwareFetchUrl(long, ANSWER), /180 bytes/)
})

test("a token that is nothing is refused rather than hung on the door", () => {
  assert.throws(
    () => firmwareFetchAnswer({ token: "", path: HOST_PATH }),
    /fetch token was unreadable/,
  )
})

test("the token and the route the host answers are read once, or the answer is refused", () => {
  assert.deepEqual(
    firmwareFetchAnswer({
      object: "gots.charm_firmware_fetch",
      token: TOKEN,
      path: HOST_PATH,
    }),
    { token: TOKEN, path: HOST_PATH },
    "both halves of the door, as the mint answers them",
  )
  for (const body of [
    {},
    { token: TOKEN },
    { path: HOST_PATH },
    { token: "", path: HOST_PATH },
    { token: 7, path: HOST_PATH },
    { token: TOKEN, path: "" },
    { token: TOKEN, path: 7 },
    { token: TOKEN, path: "//evil.example/fetch" },
    null,
  ]) {
    assert.throws(() => firmwareFetchAnswer(body), /unreadable/, JSON.stringify(body))
  }
})

/** The charm's two links as its report answers them: the one online, and the one down. */
const ONLINE_WIFI = { state: CharmLinkState.Online, reason: 0, ip: "192.168.1.20", ssid: "Home" }
const ONLINE_TUNNEL = { state: CharmLinkState.Online, ip: "100.64.0.9" }
const WIFI_DOWN = { state: CharmLinkState.Off, reason: 0, ip: "", ssid: "" }
const TUNNEL_DOWN = { state: CharmLinkState.Off, ip: "" }

test("a charm online on Wi-Fi with an https host, or on its tailnet with an http one, fetches", () => {
  assert.equal(
    firmwareDoor(
      { wifi: ONLINE_WIFI, tailnet: TUNNEL_DOWN },
      "https",
      "https://bot.example/api/plugins/gots",
      "0.1.0",
    ),
    "fetch",
    "the Wi-Fi door: the host's own address, over the network the charm joined — a build old enough not to speak the http door still takes this one",
  )
  assert.equal(
    firmwareDoor(
      { wifi: WIFI_DOWN, tailnet: ONLINE_TUNNEL },
      "http",
      "http://100.64.0.9:8642/api/plugins/gots",
      "0.2.1-beta",
    ),
    "fetch",
    "the tailnet door: the host's tailnet address, over the tunnel the charm holds",
  )
})

test("a door that is shut answers the transfer this phone drives", () => {
  assert.equal(
    firmwareDoor({ wifi: WIFI_DOWN, tailnet: TUNNEL_DOWN }, "https", "https://bot.example/gots", null),
    "transfer",
    "neither link online, whatever the address",
  )
  assert.equal(
    firmwareDoor(
      { wifi: ONLINE_WIFI, tailnet: TUNNEL_DOWN },
      "http",
      "http://100.64.0.9:8642/gots",
      "0.2.1-beta",
    ),
    "transfer",
    "the http door needs the tunnel: without it the charm would refuse the address",
  )
  assert.equal(
    firmwareDoor(
      { wifi: WIFI_DOWN, tailnet: ONLINE_TUNNEL },
      "https",
      "https://bot.example/gots",
      "0.2.1-beta",
    ),
    "transfer",
    "the https door needs the charm on a network that reaches the host",
  )
  // No address kept, no door: a hand-over this phone never saw the address of is not one to send
  // the charm walking down blind.
  assert.equal(
    firmwareDoor({ wifi: ONLINE_WIFI, tailnet: TUNNEL_DOWN }, "https", undefined, null),
    "transfer",
  )
  // A scheme switched since the last sync is a preference the charm has not been handed: the
  // address it holds is the other door's, and this phone does not send what it would refuse.
  assert.equal(
    firmwareDoor(
      { wifi: ONLINE_WIFI, tailnet: ONLINE_TUNNEL },
      "http",
      "https://bot.example/api/plugins/gots",
      "0.2.1-beta",
    ),
    "transfer",
  )
})

test("the http door opens only for a build that takes it; the https door opens for any", () => {
  // The http update door is new on the charm side — first in 0.2.1-beta — while a charm from
  // before it can hold an http voice address over its tailnet, a state this app's own Voice
  // switch writes. Handing that charm an http update URL is a refusal on the wire (BadMessage),
  // so the door rule reads the build the charm answered before it picks the door.
  const tailnet = { wifi: WIFI_DOWN, tailnet: ONLINE_TUNNEL }
  assert.equal(
    firmwareDoor(tailnet, "http", "http://100.64.0.9:8642/api/plugins/gots", "0.2.1-beta"),
    "fetch",
    "the first build that takes the http door",
  )
  assert.equal(
    firmwareDoor(tailnet, "http", "http://100.64.0.9:8642/api/plugins/gots", "0.2.3"),
    "fetch",
    "and every build after it",
  )
  assert.equal(
    firmwareDoor(tailnet, "http", "http://100.64.0.9:8642/api/plugins/gots", "0.2.0-beta"),
    "transfer",
    "the build in the field takes https only, so the transfer is the one door it always takes",
  )
  assert.equal(
    firmwareDoor(tailnet, "http", "http://100.64.0.9:8642/api/plugins/gots", "0.1.0"),
    "transfer",
  )
  assert.equal(
    firmwareDoor(tailnet, "http", "http://100.64.0.9:8642/api/plugins/gots", null),
    "transfer",
    "a build this phone cannot name is not a build that takes the door",
  )
  assert.equal(
    firmwareDoor(
      { wifi: ONLINE_WIFI, tailnet: TUNNEL_DOWN },
      "https",
      "https://bot.example/api/plugins/gots",
      null,
    ),
    "fetch",
    "unknown or older still takes the https door when the links allow",
  )
})

test("a door whose URL cannot fit the charm's frame is refused by the builder, after the mint", () => {
  // The voice row keeps an address up to the frame's own 180 bytes; the fetch URL adds the host's
  // route and its 64-hex token on top of it, so an address can be one the voice hand-over keeps and
  // still leave no room for the door. The route is the host's and arrives with the token, so the
  // door rule has no length to measure: it picks the base the links allow, and the builder's own
  // bound is the one rule — a walk it refuses falls to the transfer, which is the door that cannot
  // be refused on the wire.
  const over = `https://${"h".repeat(60)}.example/api/plugins/gots`
  assert.equal(over.length, 93, "inside the voice row's own 180-byte rule")
  assert.equal(
    firmwareDoor({ wifi: ONLINE_WIFI, tailnet: TUNNEL_DOWN }, "https", over, "0.2.1-beta"),
    "fetch",
    "the door rule reads the links and the build, not a URL the host has yet to name",
  )
  assert.throws(
    () => firmwareFetchUrl(over, ANSWER),
    /180 bytes/,
    "the builder refuses the walk, and the update falls to the transfer",
  )
  assert.equal(
    firmwareFetchUrl(
      "https://bot.example/api/plugins/gots",
      ANSWER,
    ).length < 180,
    true,
    "an address with room for the route and the token still walks",
  )
})

test("the fetch token's ten-minute life is the same number in every half that writes it", () => {
  // Three spellings of one fact: the plugin that mints the token (`TTL_MS`), the dev mock that
  // judges it (`CHARM_FETCH_MS`), and the walk that bounds its watch (`FETCH_WALK_MS`). A drift
  // in any one of them and the door shuts at a different time than the walk stops waiting —
  // held to each other the way `test-chat-next-version.mjs` holds MIN_HERMES to the manifest.
  const written = (file, at) => {
    const found = at.exec(readFileSync(file, "utf8"))
    assert.ok(found, `${file} still writes the constant`)
    return Number(found[1].replace(/_/g, ""))
  }
  const ttl = written(resolve(appDir, "../plugin/fetch_tokens.py"), /TTL_MS\s*=\s*([\d_]+)/)
  const mock = written(resolve(appDir, "scripts/mock-hermes.mjs"), /MOCK_CHARM_FETCH_MS\s*\?\?\s*([\d_]+)/)
  const walk = written(
    resolve(appDir, "src/components/charm-update.tsx"),
    /FETCH_WALK_MS\s*=\s*([\d_]+)/,
  )
  assert.equal(walk, ttl, "the walk waits no longer than the door it watches stays open")
  assert.equal(mock, ttl, "the mock shuts the door when the plugin's own clock would")
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

test("the dev mock's fetch door: a mint answers a token and a path, the fetch serves the image", async () => {
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
    const answer = firmwareFetchAnswer(await minted.json())
    assert.match(answer.token, /^[0-9a-f]{64}$/, "a token the phone can put in the URL")
    assert.equal(
      answer.path,
      pluginConstant("CHARM_FIRMWARE_FETCH_PATH"),
      "the route the plugin serves, as the mock answers it",
    )

    const url = firmwareFetchUrl(`${origin}/api/plugins/gots`, answer)
    assert.equal(url, `${origin}/api/plugins/gots${answer.path}?token=${answer.token}`)
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
      const refused = await fetch(`${origin}/api/plugins/gots${answer.path}?token=${wrong}`)
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

test("every host half spells the image route the plugin's way", () => {
  // The plugin writes the route once and registers and answers it from that constant; the dev mock
  // and the component kit each stand in for a host the app is driven against, since a browser flow
  // can't reach the real one — so the three spellings are held to each other here, as the token's
  // ten-minute life is, and a rename that misses one of them fails this test rather than a charm on
  // hardware. The phone carries none of them: it reads the path from the mint's answer.
  const named = pluginConstant("CHARM_FIRMWARE_FETCH_PATH")
  const mock = readFileSync(resolve(here, "mock-hermes.mjs"), "utf8")
  const answered = /^const CHARM_FETCH_PATH = "([^"]+)"$/m.exec(mock)
  assert.ok(answered, "the mock still answers a path of its own")
  assert.equal(answered[1], named, "the mock answers the route the plugin serves")
  const kit = readFileSync(resolve(here, "component-kit.tsx"), "utf8")
  const faked = /^export const FIRMWARE_FETCH_PATH = "([^"]+)"$/m.exec(kit)
  assert.ok(faked, "the component kit still answers a path of its own")
  assert.equal(faked[1], named, "the kit answers the route the plugin serves")
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
