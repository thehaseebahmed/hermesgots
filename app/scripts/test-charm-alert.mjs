/**
 * The charm's alert, phone side: the id a bot is named by on the charm, which has to be the id a
 * push carries, since that is the id the charm matches an alert against — and the frames the phone
 * writes, held to the wire the charm's own spec documents.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import ts from "typescript"

import { charmBotId } from "../src/lib/charm-alert.ts"
import { parseSource, sourceFiles } from "./source-tree.mjs"

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
  /**
   * Only a moment that needs an action from the reader reaches the charm: a question and an
   * approval, a plan waiting being one. A finished run asks for nothing, so it names no reason.
   */
  reasons: { QUESTION: 1, APPROVAL: 2 },
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
  // A finished run no longer taps the reader on the shoulder, so the charm has no byte for it.
  assert.doesNotMatch(WIRE_SOURCE, /REASON_FINISHED/, "a finished run is no charm moment")
  assert.equal(constant("FIELD_BYTES"), WIRE.fieldBytes, "a subject or a bot id is 1 to 64 bytes")
  assert.deepEqual(payloadOf("alert"), WIRE.alertPayload, "an alert's payload, field by field")
  assert.deepEqual(payloadOf("clear"), WIRE.clearPayload, "a clear's payload, field by field")
  assert.match(bodyOf("alert"), /frame\(OP_ALERT\)/, "an alert is the Alert op")
  assert.match(bodyOf("clear"), /frame\(OP_CLEAR\)/, "a clear is the Clear op")
  // `[version u8][op][payload]`: the version leads and the op follows, on every control write.
  assert.match(bodyOf("frame"), /u8\(VERSION\)[\s\S]*u8\(op\)/, "version first, then the op")
})

/** An app source file as the page asks for a clear in it. */
const sourceOf = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")

/** A function's own text in a source file, its braces matched by the parser, not a pattern. */
function functionText(path, name) {
  const source = sourceOf(path)
  const tree = parseSource(source, path)
  let found
  const visit = (node) => {
    if (found) return
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree)
    else ts.forEachChild(node, visit)
  }
  ts.forEachChild(tree, visit)
  assert.ok(found, `${path} declares ${name}`)
  return found
}

/**
 * The one place the app answers a prompt is `answer` in the chat screen: an approval and a
 * question are one call there, whichever of the screen's cards was tapped. The subject is the
 * session the notice was about, since that is the key the alert's record and its clear share.
 */
test("the page asks for a clear where a prompt is answered", () => {
  const asked = [
    ...functionText("src/chat-next/page.tsx", "answer").matchAll(/clearCharm\(([^)]*)\)/g),
  ].map((match) => match[1].trim())
  assert.deepEqual(asked, ["session"], "one clear, naming the session and nothing else")
})

/**
 * The answering device is skipped by the account's own clear fan-out (`plugin/push.py`), so the
 * page is the only thing that settles the charm for the prompt it just answered. A second call
 * site would clear a session some other screen is not answering.
 */
test("the clear is asked from that one place and nowhere else", () => {
  const callers = sourceFiles(new URL("../src/", import.meta.url))
    // The bridge's own definition lives beside the call it makes, not among its askers.
    .filter((path) => path !== "lib/charm.ts")
    .filter((path) => /(?<!\w)clearCharm\s*\(/.test(sourceOf(`src/${path}`)))
  assert.deepEqual(callers, ["chat-next/page.tsx"])
})

const SERVICE_SOURCE = sourceOf(
  "android/app/src/main/java/dev/hermesgots/GotsMessagingService.kt",
)

/** A Kotlin function's body, its braces matched, so a test reads what the code writes. */
function kotlinBody(source, name) {
  const from = source.indexOf(`fun ${name}(`)
  assert.ok(from >= 0, `${name} is declared`)
  const open = source.indexOf("{", from)
  let depth = 0
  for (let at = open; at < source.length; at++) {
    if (source[at] === "{") depth++
    else if (source[at] === "}" && --depth === 0) return source.slice(open + 1, at)
  }
  assert.fail(`${name}'s body closes`)
}

/**
 * The charm is for an action, never for news: a push that names no bot or no reason draws nothing
 * there, so a finished run, a failure or a room's news leaves the face it holds exactly as it is.
 */
test("the phone writes nothing to the charm for news", () => {
  const branch = kotlinBody(SERVICE_SOURCE, "charmAlert")
  assert.match(branch, /notice\.charm \?: return/, "no bot, no write")
  assert.match(branch, /notice\.charmReason \?: return/, "no reason, no write")
  const wrote = branch.indexOf("CharmNotifier.alert")
  assert.ok(wrote >= 0, "both fields in hand is the one write")
  assert.ok(
    wrote > branch.indexOf("notice.charmReason"),
    "nothing is written before both are known",
  )
})

/**
 * The reasons a phone accepts are the wire's own: a finished run's word would reach no record, since
 * `CharmWire` refuses it, and a name the wire gains has to be taken here too.
 */
test("the phone accepts the wire's reasons and no others", () => {
  const notice = sourceOf("android/app/src/main/java/dev/hermesgots/Notice.kt")
  const found = notice.match(/CHARM_REASONS = setOf\(([^)]*)\)/)
  assert.ok(found, "Notice.kt names the reasons it accepts")
  const names = [...found[1].matchAll(/"(\w+)"/g)].map((match) => match[1]).sort()
  const wire = Object.keys(WIRE.reasons)
    .map((name) => name.toLowerCase())
    .sort()
  assert.deepEqual(names, wire)
})

/**
 * A clear that arrives as a push: another device settled the subject, so this phone's tray and its
 * charm both drop it. The charm is asked for after the tray's entry is gone, and where a failure
 * cannot throw into that work — the notifier is the one writer, and a phone with no charm saved
 * does nothing at all.
 */
test("a clear push hands its subject to the charm, after the tray", () => {
  const from = SERVICE_SOURCE.indexOf("val subject = Notice.clearSubject")
  assert.ok(from >= 0, "the clear branch reads its subject before anything else")
  const branch = SERVICE_SOURCE.slice(from, SERVICE_SOURCE.indexOf("return", from))
  assert.match(branch, /NoticeDrawer\.clearSubject\(this, subject\)/, "the tray goes first")
  assert.match(branch, /CharmNotifier\.clear\(this, subject\)/, "then the charm, by that subject")
  assert.ok(
    branch.indexOf("NoticeDrawer.clearSubject") < branch.indexOf("CharmNotifier.clear"),
    "the tray's work is not waiting on a radio",
  )
  assert.match(
    branch,
    /runCatching \{[^}]*CharmNotifier\.clear\(this, subject\)[^}]*\}/,
    "a charm that cannot be written loses no tray entry",
  )
})
