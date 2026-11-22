/**
 * The app's half of the talk hand-over: the one ask the Voice row makes of the host, the frame the
 * charm keeps from it, and the words the charm's answer is drawn in. Pure — no radio, no host — so
 * what goes over the link is read as bytes here, against the firmware's `docs/PROTOCOL.md`.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  CHARM_MAX_URL_BYTES,
  CharmCode,
  CharmOp,
  talkFrame,
} from "../src/lib/charm-protocol.ts"
import {
  TALK_FEATURE,
  TALK_OLDER,
  TALK_READABLE,
  TALK_SENT,
  talkMessage,
  talkOffer,
  talkProblem,
  talkRoute,
  talkWords,
} from "../src/lib/talk.ts"

/** A bot as the host knows it, and the token it minted for the charm. */
const BOT = "4f1c2a90"
const TOKEN = "9c".repeat(32)
/** The address the host answers with: where the app dialled it. */
const HOST = "https://bot.example/api/plugins/gots"

const encoder = new TextEncoder()

test("the voice row fetches the host, keeps the token it minted, and writes both", () => {
  assert.equal(TALK_FEATURE, "talk", "the feature the row is offered by")
  // The ask: the plugin's own route, on the address the app already talks to this host on.
  assert.equal(talkRoute("https://bot.example/v1"), `${HOST}/talk`)
  assert.equal(
    talkRoute("https://gateway.example/p/work"),
    "https://gateway.example/api/plugins/gots/p/work/talk",
    "a multiplexed profile's route, as every plugin route is reached",
  )

  // The answer, as the host sends it: `GET talk` in `plugin/__init__.py`.
  const offer = talkOffer({ object: "gots.talk", host: HOST, bot: BOT, token: TOKEN })
  assert.deepEqual(offer, { host: HOST, bot: BOT, token: TOKEN })
  assert.throws(
    () => talkOffer({ object: "gots.talk", host: HOST }),
    /unreadable/,
    "half an answer is no answer, and is said rather than written",
  )

  // The write: `[urlLen u8][url][tokenLen u8][token]`, version and op in front, as the charm reads it.
  const address = "http://100.64.0.2:8642/api/plugins/gots"
  const frame = talkMessage(address, offer.token)
  const url = encoder.encode(address)
  assert.equal(frame[0], 1, "the protocol version, as every control write carries it")
  assert.equal(frame[1], CharmOp.Talk)
  assert.equal(frame[2], url.length)
  assert.deepEqual([...frame.slice(3, 3 + url.length)], [...url])
  const at = 3 + url.length
  assert.equal(frame[at], 64, "the token's own length, in front of it")
  assert.deepEqual([...frame.slice(at + 1)], [...encoder.encode(TOKEN)])
  assert.equal(frame.length, 3 + url.length + 1 + 64)
})

test("the row says what the charm answered", () => {
  assert.equal(talkWords(CharmCode.Ok), TALK_SENT)
  assert.equal(TALK_SENT, "Sent to your charm.")
  // 11 is a plaintext charm keeping the token where anyone holding it can read the chip.
  assert.equal(talkWords(CharmCode.KeptReadable), TALK_READABLE)
  assert.match(TALK_READABLE, /read the token off the chip/, "a readable secret is said, not glossed")
  assert.notEqual(TALK_READABLE, TALK_SENT, "kept readable is not a plain success")
})

test("a charm that refuses the op is named, and told apart from the sync's refusal", () => {
  assert.equal(talkWords(CharmCode.BadMessage), TALK_OLDER)
  assert.match(TALK_OLDER, /older than the app/, "the reader is sent to the firmware, not the host")
  assert.match(TALK_OLDER, /update it/)
  assert.doesNotMatch(
    TALK_OLDER,
    /didn't understand the sync/,
    "the sync's words would send them looking at the wrong thing",
  )
  // Anything else the charm says is the charm's own code, in words the settings page already has.
  assert.match(talkWords(CharmCode.StorageFailed), /storage/)
})

test("the charm is given an address it can reach, and a frame within its bounds", () => {
  // The host answers with the address the phone dialled — https, public, and not the charm's.
  assert.ok(talkProblem(HOST), "the https address the app uses is not one the charm can call")
  assert.match(talkProblem(HOST) ?? "", /plain http/)
  assert.equal(talkProblem("   "), "Your charm needs the address it can reach.")
  assert.equal(talkProblem("bot.example/api"), "Your charm needs the address it can reach.")
  const long = `http://100.64.0.2/${"a".repeat(CHARM_MAX_URL_BYTES)}`
  assert.match(talkProblem(long) ?? "", /longer than the charm/)

  // What the reader leaves: trimmed, and without the slash the charm would double before its path.
  assert.equal(talkProblem(" http://100.64.0.2:8642/api/plugins/gots/ "), null)
  const frame = talkMessage(" http://100.64.0.2:8642/api/plugins/gots/ ", TOKEN)
  const url = encoder.encode("http://100.64.0.2:8642/api/plugins/gots")
  assert.equal(frame[2], url.length, "the trailing slash is not on the wire")
  assert.deepEqual([...frame.slice(3, 3 + url.length)], [...url])

  // The bounds the firmware holds: a URL of 1..180 bytes and a token of 1..128.
  assert.throws(() => talkFrame("", TOKEN), /1/)
  assert.throws(() => talkFrame(`http://h/${"a".repeat(CHARM_MAX_URL_BYTES)}`, TOKEN), /180/)
  assert.throws(() => talkFrame("http://h", ""), /token/i)
  assert.throws(() => talkFrame("http://h", "a".repeat(129)), /token/i)
  assert.doesNotThrow(() => talkFrame("http://h", "a".repeat(128)), "128 bytes is a token still")
})
