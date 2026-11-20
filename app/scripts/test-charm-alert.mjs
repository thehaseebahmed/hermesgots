/**
 * The charm's alert, phone side: the id a bot is named by on the charm, which has to be the id a
 * push carries, since that is the id the charm matches an alert against — and the frames the phone
 * writes, held to the wire the charm's own spec documents.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import ts from "typescript"

import { charmBotId, minuteOfDay } from "../src/lib/charm-alert.ts"
import {
  CHARM_MAX_ACTION_ID_BYTES,
  CHARM_MAX_ACTION_LABEL_BYTES,
  CHARM_MAX_BODY_BYTES,
  CHARM_MAX_TITLE_BYTES,
  alertMessage,
  handoffMessage,
  parseHandoff,
} from "../src/lib/charm-protocol.ts"
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
 * the three moment ops that document adds after the catalogue's `0x01`–`0x1F`. These literals are
 * the document's, not the app's. `CharmWire.kt` is the Kotlin copy of them, and this is what fails
 * when that copy drifts — a wrong byte reaches the charm as silence, never as an error the phone
 * sees.
 */
const WIRE = {
  version: 1,
  /** `Alert`: a bot needs the reader, with what the notification said. */
  alert: 0x20,
  /** `Clear`: the bot is settled. */
  clear: 0x21,
  /**
   * `Handoff`: the phone asks whether the reader tapped "Show on phone" while it was away. One
   * byte, no version: one ask consumes the answer.
   */
  handoff: 0x22,
  /**
   * Only a moment that needs an action from the reader reaches the charm: a question and an
   * approval, a plan waiting being one. A finished run asks for nothing, so it names no reason.
   */
  reasons: { QUESTION: 1, APPROVAL: 2 },
  /**
   * `[reason u8][minute u16 LE][titleLen u8][title][bodyLen u8][body][actionCount u8][per action:
   * idLen u8, id, labelLen u8, label][subjectLen u8][subject][idLen u8][botId]`, every string
   * UTF-8. A title, a body and the button list may be none at all; a button's id and label, a
   * subject and a bot id are not.
   */
  alertPayload: [
    ["u8", "reason"],
    ["u16", "minute"],
    ["field", "title"],
    ["field", "body"],
    ["actions", "actions"],
    ["field", "subject"],
    ["field", "botId"],
  ],
  /** `[subjectLen u8][subject]`. */
  clearPayload: [["field", "subject"]],
  /**
   * The answer to the ask: which button the charm was pressed on, and the session it was about —
   * `[actionLen u8][action][subjectLen u8][subject]`, after the version and the op.
   */
  handoffAnswer: [
    ["field", "action"],
    ["field", "subject"],
  ],
  /** `kMaxActions`: an approval's two, and no more. */
  actions: 2,
  /** `kMaxActionIdLen`: the id a press answers by. */
  actionIdBytes: 16,
  /** `kMaxActionLabelLen`: the words a charm's button draws. */
  actionLabelBytes: 32,
  /** `kMaxTitleLen`: a longer title is cut, at a word, never mid-character. */
  titleBytes: 64,
  /** `kMaxBodyLen`. */
  bodyBytes: 128,
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
  return [...bodyOf(name).matchAll(/\.(u8|u16|field|words|actions)\((\w+)/g)].map((match) => [
    match[1] === "words" ? "field" : match[1],
    match[2],
  ])
}

test("the frames are the ones PROTOCOL.md documents", () => {
  assert.equal(constant("VERSION"), WIRE.version, "the version byte leads every control write")
  assert.equal(constant("OP_ALERT"), WIRE.alert, "Alert is 0x20")
  assert.equal(constant("OP_CLEAR"), WIRE.clear, "Clear is 0x21")
  assert.equal(constant("OP_HANDOFF"), WIRE.handoff, "Handoff is 0x22")
  for (const [name, value] of Object.entries(WIRE.reasons)) {
    assert.equal(constant(`REASON_${name}`), value, `${name} is ${value}`)
  }
  // A finished run no longer taps the reader on the shoulder, so the charm has no byte for it.
  assert.doesNotMatch(WIRE_SOURCE, /REASON_FINISHED/, "a finished run is no charm moment")
  assert.equal(constant("ACTION_LIMIT"), WIRE.actions, "an alert carries at most two buttons")
  assert.equal(constant("ACTION_ID_BYTES"), WIRE.actionIdBytes, "a button's id is 1 to 16 bytes")
  assert.equal(constant("ACTION_LABEL_BYTES"), WIRE.actionLabelBytes, "a label is 1 to 32 bytes")
  assert.equal(constant("TITLE_BYTES"), WIRE.titleBytes, "a title is 0 to 64 bytes")
  assert.equal(constant("BODY_BYTES"), WIRE.bodyBytes, "a body is 0 to 128 bytes")
  assert.equal(constant("FIELD_BYTES"), WIRE.fieldBytes, "a subject or a bot id is 1 to 64 bytes")
  assert.deepEqual(payloadOf("alert"), WIRE.alertPayload, "an alert's payload, field by field")
  assert.deepEqual(payloadOf("clear"), WIRE.clearPayload, "a clear's payload, field by field")
  assert.match(bodyOf("alert"), /frame\(OP_ALERT\)/, "an alert is the Alert op")
  assert.match(bodyOf("clear"), /frame\(OP_CLEAR\)/, "a clear is the Clear op")
  // The ask is one byte, so it is the op alone: a version in front of it would be a second byte the
  // charm reads as part of the ask, and one ask is the whole of it.
  assert.match(bodyOf("handoff"), /OP_HANDOFF/, "the ask is the Handoff op")
  assert.doesNotMatch(bodyOf("handoff"), /VERSION|frame\(/, "and nothing else rides with it")
  // `[version u8][op][payload]`: the version leads and the op follows, on every control write.
  assert.match(bodyOf("frame"), /u8\(VERSION\)[\s\S]*u8\(op\)/, "version first, then the op")
})

/** A frame the app built, read as the charm's parser reads one. */
const bytesOf = (frame) =>
  new DataView(frame.buffer, frame.byteOffset, frame.byteLength)

/** The clock the alert tests build frames from: 10:15 local, so the frame never reads a real one. */
const MORNING = new Date(2026, 10, 20, 10, 15)

test("a minute of the day is the local one", () => {
  assert.equal(minuteOfDay(MORNING), 10 * 60 + 15)
  assert.equal(minuteOfDay(new Date(2026, 10, 20, 0, 0)), 0)
  assert.equal(minuteOfDay(new Date(2026, 10, 20, 23, 59)), 1439)
})

/** A frame's bytes, one by one, against what the charm reads each of them as. */
function expectBytes(frame, expected) {
  assert.equal(frame.length, expected.length, "nothing else is in it")
  for (const [at, [label, value]] of expected.entries()) {
    assert.equal(frame[at], value, `byte ${at} carries the ${label}`)
  }
}

/** A string's UTF-8 bytes, spread into a table of offsets so a test says what the wire carries. */
const spell = (text, what) =>
  [...new TextEncoder().encode(text)].map((value, at) => [`${what} ${at}`, value])

/** The bytes every alert opens with: its head, and the words the tray shows. */
const ALERT_HEAD = (frameOf) => [
  ["version", WIRE.version],
  ["op", WIRE.alert],
  ["reason", frameOf.reason],
  ["minute, low byte", frameOf.minute & 0xff],
  ["minute, high byte", frameOf.minute >> 8],
  ["title length", new TextEncoder().encode(frameOf.title).length],
  ...spell(frameOf.title, "title"),
  ["body length", new TextEncoder().encode(frameOf.body).length],
  ...spell(frameOf.body, "body"),
]

/** The bytes every alert ends with: the session a clear names, and the bot whose face it draws. */
const ALERT_TAIL = (frameOf) => [
  ["subject length", frameOf.subject.length],
  ...spell(frameOf.subject, "subject"),
  ["bot id length", frameOf.botId.length],
  ...spell(frameOf.botId, "bot id"),
]

/**
 * The alert, byte by byte: the reason, the minute the frame was built (little endian, as the
 * firmware reads its other 16-bit fields), the words the tray shows, the buttons the tray draws,
 * then what a clear and a handoff name.
 */
test("an alert with no buttons says so, at every offset", () => {
  const alert = {
    reason: WIRE.reasons.QUESTION,
    minute: minuteOfDay(MORNING),
    title: "Hi",
    body: "Go",
    actions: [],
    subject: "s-1",
    botId: "ab",
  }
  expectBytes(alertMessage(alert), [
    ...ALERT_HEAD(alert),
    ["no buttons", 0],
    ...ALERT_TAIL(alert),
  ])
})

test("an alert carries one button after its body, at every offset", () => {
  const alert = {
    reason: WIRE.reasons.APPROVAL,
    minute: minuteOfDay(MORNING),
    title: "Hi",
    body: "Go",
    actions: [{ id: "0", label: "Allow once" }],
    subject: "s-1",
    botId: "ab",
  }
  expectBytes(alertMessage(alert), [
    ...ALERT_HEAD(alert),
    ["one button", 1],
    ["id length", 1],
    ...spell("0", "id"),
    ["label length", 10],
    ...spell("Allow once", "label"),
    ...ALERT_TAIL(alert),
  ])
})

test("an alert carries an approval's two buttons, at every offset", () => {
  const alert = {
    reason: WIRE.reasons.APPROVAL,
    minute: minuteOfDay(MORNING),
    title: "Hi",
    body: "Go",
    actions: [
      { id: "0", label: "Allow once" },
      { id: "1", label: "Deny" },
    ],
    subject: "s-1",
    botId: "ab",
  }
  expectBytes(alertMessage(alert), [
    ...ALERT_HEAD(alert),
    ["two buttons", 2],
    ["first id length", 1],
    ...spell("0", "first id"),
    ["first label length", 10],
    ...spell("Allow once", "first label"),
    ["second id length", 1],
    ...spell("1", "second id"),
    ["second label length", 4],
    ...spell("Deny", "second label"),
    ...ALERT_TAIL(alert),
  ])
})

/** A charm holds one alert of two buttons, so a third is dropped rather than written. */
test("a third button is dropped, and the two that stay keep their order", () => {
  const alert = {
    reason: WIRE.reasons.APPROVAL,
    minute: 0,
    title: "",
    body: "",
    subject: "s",
    botId: "b",
  }
  const pair = [
    { id: "0", label: "Allow once" },
    { id: "1", label: "Deny" },
  ]
  const frame = alertMessage({ ...alert, actions: [...pair, { id: "2", label: "Never" }] })
  assert.deepEqual([...frame], [...alertMessage({ ...alert, actions: pair })])
  assert.equal(frame[7], WIRE.actions, "two buttons, and no third")
})

test("a button's own fields are cut to the wire's bounds", () => {
  const label = "a label that runs on past what a round screen can draw"
  const frame = alertMessage({
    reason: 2,
    minute: 0,
    title: "",
    body: "",
    actions: [
      { id: "x".repeat(30), label: "Allow once" },
      { id: "1", label },
    ],
    subject: "s",
    botId: "b",
  })
  assert.equal(frame[7], 2, "two buttons")
  assert.equal(frame[8], WIRE.actionIdBytes, "an id is cut to its sixteen bytes")
  assert.equal(frame[9 + WIRE.actionIdBytes], 10, "the first label follows its own id")
  const second = 9 + WIRE.actionIdBytes + 1 + 10
  assert.equal(frame[second], 1, "the second id is one byte")
  const length = frame[second + 2]
  const cut = new TextDecoder().decode(frame.subarray(second + 3, second + 3 + length))
  assert.ok(length <= WIRE.actionLabelBytes, "a label is cut to its thirty-two bytes")
  assert.ok(label.startsWith(cut) && label[cut.length] === " ", "at a word, not inside one")
  assert.equal(frame[second + 3 + length], 1, "and the session follows it")
  assert.equal(frame[second + 4 + length], 0x73, "the session the clear names")
})

test("a label longer than the wire allows is cut at a word", () => {
  const label = "Allow once for this whole release and everything after it"
  const frame = alertMessage({
    reason: 2,
    minute: 0,
    title: "",
    body: "",
    actions: [{ id: "0", label }],
    subject: "s",
    botId: "b",
  })
  // The count, the id's length and its one byte: the label's own length comes next.
  const at = 10
  const text = new TextDecoder().decode(frame.subarray(at + 1, at + 1 + frame[at]))
  assert.ok(frame[at] <= CHARM_MAX_ACTION_LABEL_BYTES, "within the wire's own bound")
  assert.ok(text.length > 0 && text.length < label.length, "cut, not dropped")
  assert.ok(label.startsWith(text), "the start of what was said")
  assert.equal(label[text.length], " ", "and the cut lands on the space after a whole word")
  assert.ok(!text.endsWith(" "), "carrying no trailing space")
})

test("a label cut never lands inside a character", () => {
  // 1 + 2 × 20 = 41 bytes: the 32nd byte falls halfway through one of the `é`s.
  const label = "a" + "é".repeat(20)
  const frame = alertMessage({
    reason: 2,
    minute: 0,
    title: "",
    body: "",
    actions: [{ id: "0", label }],
    subject: "s",
    botId: "b",
  })
  const cut = frame.subarray(11, 11 + frame[10])
  assert.ok(cut.length <= CHARM_MAX_ACTION_LABEL_BYTES)
  // A fatal decoder throws on a split character, which is the promise this keeps.
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(cut).length, 16)
  assert.equal(cut.length, 31, "one `a` and 15 whole `é`s")
})

test("a button with no id or no label is no button the charm could answer", () => {
  const alert = (actions) => () =>
    alertMessage({ reason: 2, minute: 0, title: "", body: "", actions, subject: "s", botId: "b" })
  assert.throws(alert([{ id: "", label: "Allow once" }]), /id and a label/)
  assert.throws(alert([{ id: "0", label: "" }]), /id and a label/)
})

/**
 * The longest alert a phone can build is still one write at the MTU its notifier asks for, which is
 * why the write asks for a larger link at all: 430 bytes against the 514 a 517-byte MTU leaves
 * after ATT's three header bytes.
 */
test("the longest alert fits one write", () => {
  const frame = alertMessage({
    reason: WIRE.reasons.APPROVAL,
    minute: 1439,
    title: "t".repeat(CHARM_MAX_TITLE_BYTES),
    body: "b".repeat(CHARM_MAX_BODY_BYTES),
    actions: [
      {
        id: "0".repeat(CHARM_MAX_ACTION_ID_BYTES),
        label: "y".repeat(CHARM_MAX_ACTION_LABEL_BYTES),
      },
      {
        id: "1".repeat(CHARM_MAX_ACTION_ID_BYTES),
        label: "z".repeat(CHARM_MAX_ACTION_LABEL_BYTES),
      },
    ],
    subject: "s".repeat(WIRE.fieldBytes),
    botId: "a".repeat(WIRE.fieldBytes),
  })
  assert.equal(frame.length, 430, "the sum of every field at its bound")
  assert.ok(frame.length <= 517 - 3, "one write carries it")
})

test("a title and a body may be none at all, and a subject and a bot id may not", () => {
  const bare = alertMessage({
    reason: WIRE.reasons.QUESTION,
    minute: 0,
    title: "",
    body: "",
    subject: "s-1",
    botId: "ab",
  })
  // The two zero lengths sit where the words would: at 5, and at 5 + 1.
  assert.equal(bare[5], 0, "an empty title announces none")
  assert.equal(bare[6], 0, "an empty body announces none")
  assert.throws(
    () =>
      alertMessage({ reason: 1, minute: 0, title: "", body: "", subject: "", botId: "ab" }),
    /session it is about/,
  )
  assert.throws(
    () => alertMessage({ reason: 1, minute: 0, title: "", body: "", subject: "s", botId: "" }),
    /bot it is about/,
  )
})

/** The title or the body a frame carries, read back as text. */
const wordsAt = (frame, at) => {
  const length = frame[at]
  return { length, text: new TextDecoder().decode(frame.subarray(at + 1, at + 1 + length)) }
}

test("a title longer than the wire allows is cut at a word", () => {
  const title = "Waiting on your approval before the release goes out to everyone now"
  const frame = alertMessage({ reason: 2, minute: 0, title, body: "", subject: "s", botId: "b" })
  const cut = wordsAt(frame, 5)
  assert.ok(cut.length <= CHARM_MAX_TITLE_BYTES, "within the wire's own bound")
  assert.ok(cut.text.length > 0 && cut.text.length < title.length, "cut, not dropped")
  assert.ok(title.startsWith(cut.text), "the start of what was said")
  assert.equal(title[cut.text.length], " ", "and the cut lands on the space after a whole word")
  assert.ok(!cut.text.endsWith(" "), "carrying no trailing space")
})

test("a cut never lands inside a character", () => {
  // 1 + 2 × 40 = 81 bytes: the 64th byte falls halfway through an `é`.
  const title = "a" + "é".repeat(40)
  const frame = alertMessage({ reason: 2, minute: 0, title, body: "", subject: "s", botId: "b" })
  const cut = frame.subarray(6, 6 + frame[5])
  assert.ok(cut.length <= CHARM_MAX_TITLE_BYTES)
  // A fatal decoder throws on a split character, which is the promise this keeps.
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(cut).length, 32)
  assert.equal(cut.length, 63, "one `a` and 31 whole `é`s")
})

test("a body is cut to its own, longer bound", () => {
  const body = ("a sentence of a body, said twice over, ".repeat(10)).trim()
  const frame = alertMessage({ reason: 2, minute: 0, title: "", body, subject: "s", botId: "b" })
  const cut = wordsAt(frame, 6)
  assert.ok(cut.length <= CHARM_MAX_BODY_BYTES)
  assert.ok(cut.text.length > CHARM_MAX_TITLE_BYTES, "more room than a title has")
  assert.ok(body.startsWith(cut.text))
  assert.equal(body[cut.text.length], " ")
})

test("the handoff ask is one byte, and one ask is the whole of it", () => {
  assert.deepEqual([...handoffMessage()], [WIRE.handoff])
})

/** The answer the charm sends when a button is pressed: the button, then the session to open. */
test("the charm's answer names the button and the session", () => {
  const action = new TextEncoder().encode("0")
  const subject = new TextEncoder().encode("s-1ab")
  const answer = new Uint8Array([
    WIRE.version,
    0,
    WIRE.handoff,
    action.length,
    ...action,
    subject.length,
    ...subject,
  ])
  assert.deepEqual(parseHandoff(bytesOf(answer)), { action: "0", subject: "s-1ab" })
})

test("an answer with nothing pending is none", () => {
  assert.equal(parseHandoff(bytesOf(new Uint8Array([1, 0, WIRE.handoff, 0, 0]))), null)
})

/** The two answers share a characteristic, so the shorter one can never be read as the longer. */
test("no status is ever read as a handoff answer", () => {
  // A four-byte status whose op happens to be 0x22 is still a status: a status is exactly four.
  assert.equal(parseHandoff(bytesOf(new Uint8Array([1, 0, WIRE.handoff, 1]))), null)
  assert.equal(parseHandoff(bytesOf(new Uint8Array([1, 0, WIRE.clear, 2, 0x68, 0x69, 1, 0x73]))), null)
  // An answer whose session never arrived is no answer, not half of one.
  assert.equal(
    parseHandoff(bytesOf(new Uint8Array([1, 0, WIRE.handoff, 1, 0x30, 4, 0x68, 0x69]))),
    null,
  )
  // And one whose button is longer than an id could be is not a button this phone drew.
  const long = new Uint8Array(WIRE.actionIdBytes + 1).fill(0x30)
  assert.equal(
    parseHandoff(bytesOf(new Uint8Array([1, 0, WIRE.handoff, long.length, ...long, 1, 0x73]))),
    null,
  )
})

/**
 * The answer is read as the button and then the session, the order the wire documents: the button's
 * length is the byte after the op, and the session's follows the button itself.
 */
test("the answer's two fields are read in the order the wire writes them", () => {
  const body = bodyOf("handoffAnswer")
  const button = body.indexOf("val actionBytes")
  const session = body.indexOf("val subjectBytes")
  assert.ok(button >= 0 && session > button, "the button first, then the session")
  assert.match(body, /bytes\[3\]/, "the button's length is the byte after the op")
  assert.match(body, /bytes\[4 \+ actionBytes\]/, "the session's length follows the button")
  assert.match(body, /String\(bytes, 4, actionBytes/, "the button's bytes start where its length ends")
  assert.match(body, /String\(bytes, 5 \+ actionBytes, subjectBytes/, "and the session's after it")
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

/**
 * What the charm reads is the notification's own words: the title and the body the tray entry
 * shows, in that order, after the subject a clear names. The charm reads like the notification,
 * never like a second retelling of it.
 */
test("the charm reads like the notification", () => {
  const branch = kotlinBody(SERVICE_SOURCE, "charmAlert")
  assert.match(
    branch,
    /CharmNotifier\.alert\(this, bot, reason, notice\.id, notice\.title, notice\.body, notice\.charmActions\)/,
    "the session, the words the tray shows, and the buttons it draws",
  )
})

/**
 * The buttons the charm draws are the tray's own: the same labels, in the same order, at most two,
 * and each answering by its place in that list — the id the tray's own press carries (`answerIntent`'s
 * index), since a button the plugin sends has no id of its own (`actions_wire` in `plugin/notice.py`).
 */
test("the charm's buttons are the tray's own", () => {
  const notice = sourceOf("android/app/src/main/java/dev/hermesgots/Notice.kt")
  const branch = kotlinBody(notice, "charmActionsOf")
  assert.match(branch, /actions\.take\(CharmWire\.ACTION_LIMIT\)/, "at most two")
  assert.match(
    branch,
    /mapIndexed \{ at, one -> CharmWire\.Action\(at\.toString\(\), one\.label\) \}/,
    "each keeping its place and the words the tray draws",
  )
  assert.match(
    notice,
    /val charmActions: List<CharmWire\.Action> get\(\) = charmActionsOf\(actions\)/,
    "read from the notice's own buttons",
  )
})

/** The page's share of the same rule: a test alert draws the pair a real approval's notice draws. */
test("a test alert carries an approval's two buttons", () => {
  const frozen = functionText("src/lib/charm.ts", "sendTestAlert")
  assert.match(frozen, /actions: charmButtons\(\[\{ label: "Allow once" \}, \{ label: "Deny" \}\]\)/)
  const page = functionText("src/lib/charm-alert.ts", "charmButtons")
  assert.match(page, /slice\(0, CHARM_MAX_ACTIONS\)/, "two at most")
  assert.match(page, /id: String\(at\)/, "each answering by its place in the notice's list")
})

/**
 * A tap the reader makes on the charm while the phone is out of reach cannot be answered then, so
 * the phone asks on the next connection it makes anyway: every link it opens writes the ask, and a
 * link that carried an alert stays open long enough for a tap made while the reader is looking.
 */
test("the phone asks for a pending handoff, and waits for a tap", () => {
  const notifier = sourceOf("android/app/src/main/java/dev/hermesgots/CharmNotifier.kt")
  assert.match(notifier, /HOLD_MS = 20_000L/, "about twenty seconds after an alert")
  assert.match(notifier, /CharmWire\.handoff\(\)/, "the ask, on the link it already has")
  assert.match(notifier, /setCharacteristicNotification/, "with the answers subscribed to")
  assert.match(notifier, /CharmWire\.handoffAnswer/, "and the answer read as what it is")
  assert.match(notifier, /NoticeOpen\.link/, "opening the session by the link a tap opens")
})

/**
 * A returned button is applied in one function, and only one: for now every press opens the phone at
 * the approval or the chat, the same route the charm's own "Show on phone" takes. The alternative —
 * answering from the wrist — is named there in full, so turning it on is that function alone.
 */
test("the charm's answer is applied in one place", () => {
  const notifier = sourceOf("android/app/src/main/java/dev/hermesgots/CharmNotifier.kt")
  const applied = [...notifier.matchAll(/fun applyCharmAction\(/g)]
  assert.equal(applied.length, 1, "one function, however many buttons exist")
  const body = kotlinBody(notifier, "applyCharmAction")
  assert.match(body, /NoticeOpen\.link\(null, subject\)/, "the route a tap on the notice opens")
  assert.match(notifier, /applyCharmAction\(tap\.action, tap\.subject\)/, "asked with both the button and the session")
  // The alternative the comment must name, so flipping it is a single change.
  assert.match(notifier, /answers\.py/, "the plugin's signed link, named where it would be posted")
  assert.match(notifier, /answers\.mint/, "and the mint that makes it")
})
