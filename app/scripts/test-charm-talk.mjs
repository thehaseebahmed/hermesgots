/**
 * The app's half of the talk hand-over: the one ask the Voice row makes of the host, the frame the
 * charm keeps from it, and the words the charm's answer is drawn in. Pure — no radio, no host — so
 * what goes over the link is read as bytes here, against the firmware's `docs/PROTOCOL.md`.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  CHARM_MAX_TOKEN_BYTES,
  CHARM_MAX_URL_BYTES,
  CharmCode,
  CharmOp,
  codeWords,
  parseTalkState,
  talkFrame,
  updateMessage,
} from "../src/lib/charm-protocol.ts"
import { refusalWords, TALK_SENT } from "../src/lib/charm-words.ts"
import {
  TALK_FEATURE,
  talkMessage,
  talkOffer,
  talkProblem,
  voiceAddress,
  voiceOwed,
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

test("the row says what the charm answered, in the charm's own words", () => {
  assert.equal(talkWords(CharmCode.Ok), TALK_SENT)
  assert.equal(TALK_SENT, "Sent to your charm.")
  // 11 is a plaintext charm: the charm's own words for the code, since the row has no second
  // sentence of its own for it — the chip's warning is the code's, and the token is the hint's.
  assert.equal(
    talkWords(CharmCode.KeptReadable),
    codeWords(CharmCode.KeptReadable),
    "code 11 is drawn in the charm's one sentence for it",
  )
  assert.match(talkWords(CharmCode.KeptReadable), /read it off the chip/)
  assert.notEqual(
    talkWords(CharmCode.KeptReadable),
    TALK_SENT,
    "kept readable is not a plain success",
  )
  // The same table draws every settings row, so no code's words name an op: a refusal of the
  // Voice write is not a refusal of the sync.
  assert.doesNotMatch(codeWords(CharmCode.StorageFailed), /sync/)
  assert.doesNotMatch(codeWords(4242), /sync/, "and an unknown code is the charm's own, not a sync's")
})

test("an answer that did not keep it says the token is still this phone's to send", () => {
  // Busy and StorageFailed both leave the secret where it was: the row has the only copy the
  // reader can still hand over, so it says so rather than drawing a refusal that sounds final.
  for (const code of [CharmCode.Busy, CharmCode.StorageFailed]) {
    assert.match(
      talkWords(code),
      /still on this phone/,
      "a charm that never kept it leaves the token with the phone",
    )
    assert.match(talkWords(code), /send it again/, "and Send is the way it goes")
  }
  // A keep spends the token, so there is nothing left to say about it.
  assert.doesNotMatch(talkWords(CharmCode.Ok), /still on this phone/)
  assert.doesNotMatch(talkWords(CharmCode.KeptReadable), /still on this phone/)
})

test("a charm that refuses the op is named, and told apart from the sync's refusal", () => {
  assert.ok(
    talkWords(CharmCode.BadMessage).startsWith(
      refusalWords(CharmCode.BadMessage, ", then set voice up again"),
    ),
    "the row does not keep a second sentence for the same fact",
  )
  assert.match(talkWords(CharmCode.BadMessage), /older than the app/, "the firmware is what to update")
  assert.match(talkWords(CharmCode.BadMessage), /update it/)
  assert.match(talkWords(CharmCode.BadMessage), /set voice up again/, "and the row is set up after")
  assert.doesNotMatch(
    talkWords(CharmCode.BadMessage),
    /didn't understand the sync/,
    "the sync's words would send them looking at the wrong thing",
  )
  // Anything else the charm says is the charm's own code, in words the settings page already has.
  assert.match(talkWords(CharmCode.StorageFailed), /storage/)
})

test("the charm is given an address it can reach, and a frame within its bounds", () => {
  // Both schemes are the charm's now: the host's own https address, and the tailnet's plain http.
  assert.equal(talkProblem(HOST), null, "the address the app uses is one the charm can call")
  assert.equal(talkProblem("https://h.example:8443/api/plugins/gots"), null)
  assert.match(talkProblem("   ") ?? "", /needs the address/)
  assert.match(talkProblem("bot.example/api") ?? "", /needs the address/)
  assert.match(talkProblem("ftp://h/api") ?? "", /needs the address/, "a scheme it cannot speak")
  const long = `http://100.64.0.2/${"a".repeat(CHARM_MAX_URL_BYTES)}`
  assert.match(talkProblem(long) ?? "", /longer than the charm/)
  // The sentence the row shows is built from the bound the frame enforces, so moving the bound
  // cannot leave a count behind in the words.
  assert.match(talkProblem(long) ?? "", new RegExp(`\\(${CHARM_MAX_URL_BYTES} bytes at most\\)`))

  // What the reader leaves: trimmed, and without the slash the charm would double before its path.
  assert.equal(talkProblem(" http://100.64.0.2:8642/api/plugins/gots/ "), null)
  const frame = talkMessage(" http://100.64.0.2:8642/api/plugins/gots/ ", TOKEN)
  const url = encoder.encode("http://100.64.0.2:8642/api/plugins/gots")
  assert.equal(frame[2], url.length, "the trailing slash is not on the wire")
  assert.deepEqual([...frame.slice(3, 3 + url.length)], [...url])

  // The bounds the firmware holds, read off the constants that enforce them rather than off a count
  // typed into this test: a bound that moves is expected to move here with it.
  assert.throws(() => talkFrame("", TOKEN), /1/)
  assert.throws(
    () => talkFrame(`http://h/${"a".repeat(CHARM_MAX_URL_BYTES)}`, TOKEN),
    new RegExp(`at most ${CHARM_MAX_URL_BYTES} bytes`),
  )
  assert.throws(() => talkFrame("http://h", ""), /token/i)
  assert.throws(
    () => talkFrame("http://h", "a".repeat(CHARM_MAX_TOKEN_BYTES + 1)),
    new RegExp(`at most ${CHARM_MAX_TOKEN_BYTES} bytes`),
    "the token's own bound, in the words the constant builds",
  )
  assert.doesNotThrow(
    () => talkFrame("http://h", "a".repeat(CHARM_MAX_TOKEN_BYTES)),
    `${CHARM_MAX_TOKEN_BYTES} bytes is a token still`,
  )
})

test("the charm's answer about what it holds is the address, and never the token", () => {
  const answer = (extra) =>
    new DataView(new Uint8Array([1, 0, CharmOp.TalkState, 0, extra.length, ...extra]).buffer)

  assert.deepEqual(parseTalkState(answer([0])), { address: null }, "a charm holding none")
  const url = encoder.encode("https://h.example/api/plugins/gots")
  assert.deepEqual(parseTalkState(answer([url.length, ...url])), {
    address: "https://h.example/api/plugins/gots",
  })
  // A length that disagrees with the frame is no answer at all, rather than a cut address.
  assert.equal(parseTalkState(answer([url.length + 1, ...url])), null)
  // And an answer to another op is somebody else's.
  const other = new DataView(new Uint8Array([1, 0, CharmOp.Battery, 0, 1, 0]).buffer)
  assert.equal(parseTalkState(other), null)
})

test("a sync owes voice when the charm holds nothing, or the other scheme's address", () => {
  assert.equal(voiceOwed(undefined, "https"), true, "no record of a hand-over")
  assert.equal(voiceOwed(true, "https"), true, "a bare record from before addresses were kept")
  assert.equal(voiceOwed("https://h.example/api", "https"), false, "this scheme's address is held")
  assert.equal(voiceOwed("http://100.64.0.2:8642/api", "https"), true, "the other scheme's is not")
  assert.equal(voiceOwed("http://100.64.0.2:8642/api", "http"), false)
})

test("the scheme picks the address the host answered with", () => {
  const both = {
    host: "https://bot.example/api/plugins/gots",
    tailnet: "http://100.64.0.2:8642/api/plugins/gots",
    bot: "4f1c2a90",
    token: TOKEN,
  }
  assert.equal(voiceAddress(both, "https"), both.host, "https is the address the phone dials")
  assert.equal(voiceAddress(both, "http"), both.tailnet, "http is the host's own tailnet address")
  assert.equal(
    voiceAddress({ host: both.host, bot: both.bot, token: both.token }, "http"),
    null,
    "a host that named no tailnet address names none, rather than borrowing the https one",
  )
})

test("each address op takes the scheme the charm speaks for it", () => {
  // The charm fetches an image itself, so that address is https; and a turn's is either, because the
  // firmware has a door for each. One rule reads them, and refuses the scheme the op cannot use
  // rather than encoding a URL the charm would fail to open.
  assert.doesNotThrow(() => talkFrame("https://bot.example/api", TOKEN), "a turn may be https")
  assert.doesNotThrow(() => talkFrame("http://100.64.0.2:8642/api/plugins/gots", TOKEN))
  assert.throws(
    () => talkFrame("ftp://bot.example/api", TOKEN),
    /must be http:\/\/ or https:\/\//,
    "and nothing else",
  )
  assert.throws(
    () => updateMessage("http://h/image.bin", new Uint8Array(32)),
    /https address/,
    "and an image is not fetched over plain http",
  )
  assert.doesNotThrow(() => updateMessage("https://h/image.bin", new Uint8Array(32)))
})
