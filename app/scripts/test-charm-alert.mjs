/**
 * The charm's alert, phone side: the id a bot is named by on the charm, which has to be the id a
 * push carries, since that is the id the charm matches an alert against — and the frames the phone
 * writes, held to the wire the charm's own spec documents.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { charmBotId } from "../src/lib/charm-alert.ts"

test("a bot's charm id is its registry id", () => {
  assert.equal(charmBotId("bot-1", "9f2c4a1b7d3e5f60"), "9f2c4a1b7d3e5f60")
})

test("a bot the registry does not hold keeps its own id", () => {
  assert.equal(charmBotId("bot-1"), "bot-1")
})

test("an empty id is treated as absent", () => {
  assert.equal(charmBotId("bot-1", ""), "bot-1")
})

/**
 * The wire, as `docs/PROTOCOL.md` in the `hermesgots-charm` repo writes it: protocol version 1, and
 * the two moment ops that document adds after the catalogue's `0x01`–`0x1F`. These literals are the
 * document's, not the app's. `CharmWire.kt` is the Kotlin copy of them, and this is what fails when
 * that copy drifts — a wrong byte reaches the charm as silence, never as an error the phone sees.
 */
const WIRE = {
  version: 1,
  /** `Alert`: a bot needs the reader. */
  alert: 0x20,
  /** `Clear`: the bot is settled. */
  clear: 0x21,
  reasons: { QUESTION: 1, APPROVAL: 2, FINISHED: 3 },
  /** `[reason u8][subjectLen u8][subject][idLen u8][botId]`, both strings UTF-8, 1 to 64 bytes. */
  alertPayload: [
    ["u8", "reason"],
    ["field", "subject"],
    ["field", "botId"],
  ],
  /** `[subjectLen u8][subject]`. */
  clearPayload: [["field", "subject"]],
  /** `kMaxSubjectLen` in the charm's `include/protocol.h`: a longer subject is `BadMessage`. */
  fieldBytes: 64,
}

const WIRE_SOURCE = readFileSync(
  new URL("../android/app/src/main/java/dev/hermesgots/CharmWire.kt", import.meta.url),
  "utf8",
)

/** A `const val` in `CharmWire.kt`, as the number the wire is compared against. */
function constant(name) {
  const found = WIRE_SOURCE.match(new RegExp(`const val ${name}\\s*=\\s*(0x[0-9a-fA-F]+|[0-9]+)`))
  assert.ok(found, `CharmWire.kt declares ${name}`)
  return Number(found[1])
}

/** A function's body in `CharmWire.kt`, its braces matched so the test reads what the code writes. */
function bodyOf(name) {
  const from = WIRE_SOURCE.indexOf(`fun ${name}(`)
  assert.ok(from >= 0, `CharmWire.kt declares ${name}`)
  const open = WIRE_SOURCE.indexOf("{", from)
  assert.ok(open >= 0, `${name} has a body`)
  let depth = 0
  for (let at = open; at < WIRE_SOURCE.length; at++) {
    if (WIRE_SOURCE[at] === "{") depth++
    else if (WIRE_SOURCE[at] === "}" && --depth === 0) return WIRE_SOURCE.slice(open + 1, at)
  }
  assert.fail(`${name}'s body closes`)
}

/** The writes a builder makes, in the order it makes them: a byte, or a length and its bytes. */
function payloadOf(name) {
  return [...bodyOf(name).matchAll(/\.(u8|field)\((\w+)\)/g)].map((match) => [match[1], match[2]])
}

test("the frames are the ones PROTOCOL.md documents", () => {
  assert.equal(constant("VERSION"), WIRE.version, "the version byte leads every control write")
  assert.equal(constant("OP_ALERT"), WIRE.alert, "Alert is 0x20")
  assert.equal(constant("OP_CLEAR"), WIRE.clear, "Clear is 0x21")
  for (const [name, value] of Object.entries(WIRE.reasons)) {
    assert.equal(constant(`REASON_${name}`), value, `${name} is ${value}`)
  }
  assert.equal(constant("FIELD_BYTES"), WIRE.fieldBytes, "a subject or a bot id is 1 to 64 bytes")
  assert.deepEqual(payloadOf("alert"), WIRE.alertPayload, "an alert's payload, field by field")
  assert.deepEqual(payloadOf("clear"), WIRE.clearPayload, "a clear's payload, field by field")
  assert.match(bodyOf("alert"), /frame\(OP_ALERT\)/, "an alert is the Alert op")
  assert.match(bodyOf("clear"), /frame\(OP_CLEAR\)/, "a clear is the Clear op")
  // `[version u8][op][payload]`: the version leads and the op follows, on every control write.
  assert.match(bodyOf("frame"), /u8\(VERSION\)[\s\S]*u8\(op\)/, "version first, then the op")
})
