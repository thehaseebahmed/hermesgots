/**
 * The Gots Charm's sync protocol, version 1: the messages the phone writes and the answers the
 * charm notifies, as bytes. Pure, so it is tested without a radio. The firmware repo's
 * `docs/PROTOCOL.md` is the spec and `include/protocol.h` the charm's copy; keep all three in step.
 */

export const CHARM_VERSION = 1

export const CHARM_SERVICE = "1fa26b10-0e3e-4c4c-b6ce-062415834e11"
export const CHARM_CONTROL = "1fa26b11-0e3e-4c4c-b6ce-062415834e11"
export const CHARM_DATA = "1fa26b12-0e3e-4c4c-b6ce-062415834e11"
export const CHARM_STATUS = "1fa26b13-0e3e-4c4c-b6ce-062415834e11"

export const CHARM_MAX_BOTS = 32
export const CHARM_MAX_IMAGE_BYTES = 200 * 1024
const MAX_ID_BYTES = 64
const MAX_NAME_BYTES = 32

export const CharmOp = {
  Begin: 0x01,
  Bot: 0x02,
  Image: 0x03,
  ImageEnd: 0x04,
  Commit: 0x05,
  Abort: 0x06,
  // Pet mode. These go over with no Begin: they are not part of the bot list.
  PetSettings: 0x07,
  Pose: 0x08,
  PoseImage: 0x09,
  PoseImageEnd: 0x0a,
  Time: 0x0b,
  // The moments. These go over with no Begin either: they are not a sync at all.
  Alert: 0x20,
  Handoff: 0x22,
} as const

type CharmOp = (typeof CharmOp)[keyof typeof CharmOp]

/**
 * The byte each reason an alert carries is on the wire, as `REASON_QUESTION` and `REASON_APPROVAL`
 * are in `CharmWire.kt`. Only a moment that needs an action from the reader has one.
 */
export const CharmReasonByte = {
  question: 1,
  approval: 2,
} as const

/** What an alert's title and body may measure, as `kMaxTitleLen` and `kMaxBodyLen` do. */
export const CHARM_MAX_TITLE_BYTES = 64
export const CHARM_MAX_BODY_BYTES = 128

/**
 * What an alert's buttons may measure, as `kMaxActions`, `kMaxActionIdLen` and
 * `kMaxActionLabelLen` do: an approval's two at most, an id a press answers by, and the words the
 * charm draws on it.
 */
export const CHARM_MAX_ACTIONS = 2
export const CHARM_MAX_ACTION_ID_BYTES = 16
export const CHARM_MAX_ACTION_LABEL_BYTES = 32

export const CharmCode = {
  Ok: 0,
  BadVersion: 1,
  BadMessage: 2,
  NoSession: 3,
  BadIndex: 4,
  TooBig: 5,
  BadImage: 7,
  MissingImage: 8,
  StorageFailed: 9,
  BadMood: 10,
} as const

/** What the charm says a code means, in words a settings row can show. */
const CODE_WORDS: Record<number, string> = {
  [CharmCode.BadVersion]: "The charm runs a different sync version; update its firmware",
  [CharmCode.BadMessage]: "The charm didn't understand the sync",
  [CharmCode.NoSession]: "The charm lost track of the sync",
  [CharmCode.BadIndex]: "The charm lost track of the sync",
  [CharmCode.TooBig]: "Too much for the charm to hold",
  [CharmCode.BadImage]: "A picture arrived damaged",
  [CharmCode.MissingImage]: "A picture never arrived",
  [CharmCode.StorageFailed]: "The charm's storage is full or failing",
  [CharmCode.BadMood]: "The charm runs older firmware, which has no pet mode",
}

export const codeWords = (code: number) =>
  CODE_WORDS[code] ?? `The charm refused the sync (${code})`

/**
 * A mood by the number the charm knows it by, in the app's own names. The number is the wire
 * format: the firmware's docs/PROTOCOL.md fixes it, so it never moves.
 */
export const CHARM_MOODS = [
  "happy",
  "wave",
  "excited",
  "love",
  "curious",
  "sleepy",
  "hungry",
  "sad",
  "eating",
  "asleep",
  "playing",
] as const

/** A mood the charm knows by number. The app draws six of the eleven; the charm poses the rest. */
export type CharmMood = (typeof CHARM_MOODS)[number]

export const charmMood = (mood: CharmMood) => CHARM_MOODS.indexOf(mood)

export interface CharmPetSettings {
  /** Off by default: the charm shows the bots' carousel, as it did before pet mode. */
  enabled: boolean
  /** The pet as a Profile id: the id the charm's bot list carries. Required when `enabled` is on. */
  petBotId: string
  /** The user's night, in local hours: it sleeps at `bedStart` and wakes at `bedEnd`. */
  bedStart: number
  bedEnd: number
  /** Minutes east of UTC where the phone is, so the charm knows the local hour. */
  utcOffsetMin: number
}

/** The pet's night, in local hours: it sleeps at 22:00 and wakes at 07:00. */
export const CHARM_BED_START = 22
export const CHARM_BED_END = 7

/** What the settings page keeps about pet mode. */
export interface CharmPetChoice {
  enabled: boolean
  /** The bot the pet is, by the id the charm knows it by. */
  botId?: string
}

/**
 * The settings to send, from what the sheet holds. A bot that has gone, or none chosen, means pet
 * mode off: the charm is never told to run a pet the phone cannot show.
 */
export function petSettingsFrom(
  choice: CharmPetChoice | undefined,
  botIds: string[],
  offsetMin = -new Date().getTimezoneOffset(),
): CharmPetSettings {
  const chosen = choice?.botId && botIds.includes(choice.botId) ? choice.botId : ""
  return {
    enabled: Boolean(choice?.enabled && chosen),
    petBotId: chosen,
    bedStart: CHARM_BED_START,
    bedEnd: CHARM_BED_END,
    utcOffsetMin: offsetMin,
  }
}

export interface CharmPose {
  mood: CharmMood
  /** A baseline JPEG, as a bot's picture is. */
  image: Uint8Array
}

export interface CharmBot {
  id: string
  name: string
  /** RGB565, shown on the charm when there is no picture. */
  accent: number
  /** A baseline JPEG, or empty for none: the bot at rest, which the carousel draws. */
  image: Uint8Array
  /** A baseline JPEG, or empty for none: the face an alert draws, since a bot waiting is curious. */
  waiting: Uint8Array
}

export interface CharmStatus {
  version: number
  code: number
  op: number
  needImage: boolean
}

const encoder = new TextEncoder()

/** UTF-8 bytes cut to `max` without splitting a character. */
export function utf8Clip(text: string, max: number): Uint8Array {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return bytes
  let end = max
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character's start.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return bytes.slice(0, end)
}

/**
 * Text as the charm shows it: at most `max` bytes, cut where a word ends rather than inside one, and
 * never inside a character. A cut mid-word reads as a typo on a round screen, and a cut mid-character
 * is a broken tail the charm would draw as a box.
 */
export function clampText(text: string, max: number): Uint8Array {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return bytes
  let end = max
  // A character's continuation bytes are 10xxxxxx: step back to the start of the one the cut split.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  // Then back to the space that ended the last whole word, since a space is one byte and so is never
  // inside a character. Text with no space in it keeps the character cut: half a word beats nothing.
  let space = end
  while (space > 0 && bytes[space - 1] !== 0x20) space--
  if (space > 1) end = space - 1
  return bytes.slice(0, end)
}

let table: Uint32Array | undefined

/** IEEE CRC-32, the same as zlib's and the charm's. */
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of data) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** `#rrggbb` as RGB565. */
export function rgb565(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return 0
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 0xff
  const g = (v >> 8) & 0xff
  const b = v & 0xff
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
}

class Writer {
  private bytes: number[] = []
  u8(v: number) {
    this.bytes.push(v & 0xff)
    return this
  }
  u16(v: number) {
    return this.u8(v).u8(v >>> 8)
  }
  u32(v: number) {
    return this.u16(v & 0xffff).u16(v >>> 16)
  }
  str(b: Uint8Array) {
    this.u8(b.length)
    for (const x of b) this.bytes.push(x)
    return this
  }
  done() {
    return new Uint8Array(this.bytes)
  }
}

const control = (op: CharmOp) => new Writer().u8(CHARM_VERSION).u8(op)

export const beginMessage = (count: number) => control(CharmOp.Begin).u8(count).done()
export const imageMessage = (index: number) => control(CharmOp.Image).u8(index).done()
export const imageEndMessage = (index: number) => control(CharmOp.ImageEnd).u8(index).done()
export const commitMessage = () => control(CharmOp.Commit).done()
export const abortMessage = () => control(CharmOp.Abort).done()

/** UTC seconds, which the charm keeps in its RTC so the pet's meters know the time that passed. */
export const timeMessage = (epochSeconds: number) => control(CharmOp.Time).u32(epochSeconds).done()

export interface CharmAlertAction {
  /**
   * What the charm answers with when the button is pressed: the button's place in the notice's own
   * list, which is the id the tray's press carries too.
   */
  id: string
  /** The words on the button, the notice's own: `Allow once`, `Deny`. */
  label: string
}

export interface CharmAlert {
  /** `CharmReasonByte`: only the two moments a bot needs the reader for reach the charm. */
  reason: number
  /** Minutes since local midnight at the moment this frame was built, as the reader's clock reads. */
  minute: number
  /** The notice's title: the first line the tray entry shows. May be none. */
  title: string
  /** The notice's body: what the bot said. May be none, and one cut for the link drops it whole. */
  body: string
  /** The notice's own buttons, at most two: an approval's Allow once and Deny, a question's none. */
  actions?: CharmAlertAction[]
  /** The session the alert is about: what a clear and a handoff answer name. */
  subject: string
  /** The bot's id on the charm, the one a push carries. */
  botId: string
}

/**
 * A bot needs the reader, with what the notification said and the buttons it drew. The charm draws
 * it with the phone away, so it carries the words the tray shows and the same two buttons, rather
 * than an id the reader would have to look up and a choice they would have to remember.
 *
 * The longest one is 335 bytes plus the buttons (16 and 32 bytes each, of two), which is why the
 * writer asks for a larger MTU before it writes one.
 */
export function alertMessage(alert: CharmAlert): Uint8Array {
  if (alert.reason !== CharmReasonByte.question && alert.reason !== CharmReasonByte.approval)
    throw new Error("A charm alert is a question or an approval")
  const subject = utf8Clip(alert.subject, MAX_ID_BYTES)
  if (subject.length === 0) throw new Error("An alert names the session it is about")
  const botId = utf8Clip(alert.botId, MAX_ID_BYTES)
  if (botId.length === 0) throw new Error("An alert names the bot it is about")
  const actions = (alert.actions ?? []).slice(0, CHARM_MAX_ACTIONS).map((action) => ({
    id: clampText(action.id, CHARM_MAX_ACTION_ID_BYTES),
    label: clampText(action.label, CHARM_MAX_ACTION_LABEL_BYTES),
  }))
  // A button with no id answers nothing and one with no label says nothing: neither is drawn.
  for (const action of actions) {
    if (action.id.length === 0 || action.label.length === 0)
      throw new Error("A charm button carries an id and a label")
  }
  const frame = control(CharmOp.Alert)
    .u8(alert.reason)
    .u16(alert.minute)
    .str(clampText(alert.title, CHARM_MAX_TITLE_BYTES))
    .str(clampText(alert.body, CHARM_MAX_BODY_BYTES))
    .u8(actions.length)
  for (const action of actions) frame.str(action.id).str(action.label)
  return frame.str(subject).str(botId).done()
}

/**
 * The ask: whether the reader tapped "Show on phone" while the phone was away. One byte, with no
 * version in front of it — the charm reads a one-byte control write as this ask alone, and answers
 * in its status characteristic. One ask consumes the answer, so a pending tap is answered once and
 * then gone.
 */
export const handoffMessage = () => new Uint8Array([CharmOp.Handoff])

/**
 * The answer to the ask: which button was pressed on the charm, and the session it was pressed on.
 * The button is the alert's own action id, so a phone that still holds the notice knows which link
 * the press stands for.
 */
export interface HandoffTap {
  /** The button pressed: the alert's own action id, which is its place in the notice's list. */
  action: string
  /** The session the button was pressed on: the subject the alert named. */
  subject: string
}

/**
 * The button a handoff ask was answered with, or null for an answer with nothing pending — and for
 * anything that is not this answer at all. A status is exactly four bytes and this answer is seven
 * or more, so the two can never be read for each other; a status whose third byte happened to be
 * `0x22` still reads as no answer here.
 */
export function parseHandoff(view: DataView): HandoffTap | null {
  if (view.byteLength < 7) return null
  if (view.getUint8(2) !== CharmOp.Handoff) return null
  const actionLength = view.getUint8(3)
  // Nothing was pending, or a button longer than the id this phone drew: either way, none.
  if (actionLength === 0 || actionLength > CHARM_MAX_ACTION_ID_BYTES) return null
  if (view.byteLength < 5 + actionLength) return null
  const subjectLength = view.getUint8(4 + actionLength)
  // The session the button was pressed on never arrived: no answer, not half of one.
  if (subjectLength === 0 || subjectLength > MAX_ID_BYTES) return null
  if (view.byteLength < 5 + actionLength + subjectLength) return null
  const decoder = new TextDecoder()
  return {
    action: decoder.decode(new Uint8Array(view.buffer, view.byteOffset + 4, actionLength)),
    subject: decoder.decode(
      new Uint8Array(view.buffer, view.byteOffset + 5 + actionLength, subjectLength),
    ),
  }
}

export function petSettingsMessage(settings: CharmPetSettings): Uint8Array {
  const id = utf8Clip(settings.petBotId, MAX_ID_BYTES)
  // The charm refuses these too; catching them here keeps the failure in words the sheet can show.
  if (settings.enabled && id.length === 0) throw new Error("Choose a bot to be the pet")
  if (settings.bedStart > 23 || settings.bedEnd > 23)
    throw new Error("The pet's night is two hours of the day")
  return control(CharmOp.PetSettings)
    .u8(settings.enabled ? 1 : 0)
    .u8(settings.bedStart)
    .u8(settings.bedEnd)
    .u16(settings.utcOffsetMin & 0xffff)
    .str(id)
    .done()
}

export const poseMessage = (mood: CharmMood, image: Uint8Array) =>
  control(CharmOp.Pose)
    .u8(charmMood(mood))
    .u32(image.length)
    .u32(image.length ? crc32(image) : 0)
    .done()

export const poseImageMessage = (mood: CharmMood) =>
  control(CharmOp.PoseImage).u8(charmMood(mood)).done()

export const poseImageEndMessage = (mood: CharmMood) =>
  control(CharmOp.PoseImageEnd).u8(charmMood(mood)).done()

export function botMessage(index: number, bot: CharmBot): Uint8Array {
  const id = utf8Clip(bot.id, MAX_ID_BYTES)
  if (id.length === 0) throw new Error("A bot needs an id")
  // Two pictures, the carousel's and the one an alert draws, each announced by its own length and
  // CRC. A zero length is no picture.
  return control(CharmOp.Bot)
    .u8(index)
    .u16(bot.accent)
    .u32(bot.image.length)
    .u32(bot.image.length ? crc32(bot.image) : 0)
    .u32(bot.waiting.length)
    .u32(bot.waiting.length ? crc32(bot.waiting) : 0)
    .str(id)
    .str(utf8Clip(bot.name, MAX_NAME_BYTES))
    .done()
}

/** A picture as `data` writes: `[offset u32][bytes]`, each at most `size` bytes long. */
export function imageChunks(image: Uint8Array, size: number): Uint8Array[] {
  const room = size - 4
  if (room < 1) throw new Error("Chunks too small")
  const out: Uint8Array[] = []
  for (let at = 0; at < image.length; at += room) {
    const part = image.subarray(at, Math.min(image.length, at + room))
    const chunk = new Uint8Array(4 + part.length)
    new DataView(chunk.buffer).setUint32(0, at, true)
    chunk.set(part, 4)
    out.push(chunk)
  }
  return out
}

/** The largest `data` write a link carries: the MTU less ATT's 3 bytes, capped at 512. */
export const chunkSize = (mtu: number) => Math.max(23, Math.min(512, mtu - 3))

export function parseStatus(view: DataView): CharmStatus {
  if (view.byteLength < 4) throw new Error("The charm sent a short answer")
  return {
    version: view.getUint8(0),
    code: view.getUint8(1),
    op: view.getUint8(2),
    needImage: view.getUint8(3) === 1,
  }
}

/** Checks the pet's pictures before any of them goes over the air. */
export function checkPoses(poses: CharmPose[]) {
  for (const pose of poses) {
    if (pose.image.length > CHARM_MAX_IMAGE_BYTES)
      throw new Error(`The pet's ${pose.mood} picture is too big for the charm`)
  }
}

/** Checks a list before any of it goes over the air. */
export function checkBots(bots: CharmBot[]) {
  if (bots.length > CHARM_MAX_BOTS)
    throw new Error(`The charm holds at most ${CHARM_MAX_BOTS} bots`)
  for (const bot of bots) {
    if (bot.image.length > CHARM_MAX_IMAGE_BYTES)
      throw new Error(`${bot.name}'s picture is too big for the charm`)
    if (bot.waiting.length > CHARM_MAX_IMAGE_BYTES)
      throw new Error(`${bot.name}'s waiting picture is too big for the charm`)
  }
}
