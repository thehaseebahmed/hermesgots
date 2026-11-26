/**
 * The Gots Charm's sync protocol, version 1: the messages the phone writes and the answers the
 * charm notifies, as bytes. Pure, so it is tested without a radio. The firmware repo's
 * `docs/PROTOCOL.md` is the spec and `include/protocol.h` the charm's copy; keep all three in step.
 */
import { schemeOf } from "./host-url.ts"

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
  // The glass's own settings: whether a double tap wakes it, and one of its quiet windows. Kept
  // apart from pet mode, which is a different question about a different thing.
  SleepSettings: 0x0c,
  // "What is your battery?": one ask, answered with a level and a charging flag.
  Battery: 0x0d,
  // The moments. These go over with no Begin either: they are not a sync at all.
  Alert: 0x20,
  Handoff: 0x22,
  // The network. A charm is provisioned, not synced, so these carry no Begin either.
  Wifi: 0x30,
  Forget: 0x31,
  Network: 0x32,
  Tailnet: 0x33,
  Update: 0x34,
  UpdateStatus: 0x35,
  // The build the charm runs, and an image the phone sends itself rather than one it fetches.
  Firmware: 0x36,
  UpdateBegin: 0x37,
  UpdateEnd: 0x38,
  // Voice: the address the charm's turns are posted to and the token it proves itself with, handed
  // over by the app. One write, and the charm keeps both.
  Talk: 0x40,
  // What the charm holds: the address, never the token.
  TalkState: 0x41,
  // The microphone's own account of the last press: which door refused, and the heap at that moment.
  // The band says "No mic" for every door there is, which is one word where there are ten.
  Diagnose: 0x42,
  // Whether the charm keeps a copy of its own log. Off until this arms it; a minute with the phone
  // off the link lets it go on the charm's own account.
  Log: 0x43,
  // A page of the log's rows, already wrapped at the panel's column.
  LogTail: 0x44,
  // The rows from a row's own index on, so a phone that keeps what it has read asks only for what it
  // has not: `LogTail`'s `from` is a place among the rows the ring keeps and moves as it drops them.
  LogSince: 0x45,
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

/**
 * The network block's enumerations, by the number the wire uses. The firmware's `docs/PROTOCOL.md`
 * fixes them, as it does the ops: a Wi-Fi or tunnel link is off, joining, online or failed; a Wi-Fi
 * link that is not online says why; and a firmware download is idle, downloading, ready or failed,
 * with a reason of its own.
 */
export const CharmLinkState = { Off: 0, Joining: 1, Online: 2, Failed: 3 } as const

export const CharmWifiReason = {
  None: 0,
  NoCredentials: 1,
  NotFound: 2,
  BadCredentials: 3,
  Unreachable: 4,
  Lost: 5,
} as const

export const CharmUpdateState = { Idle: 0, Downloading: 1, Ready: 2, Failed: 3 } as const

/**
 * Why a tunnel is not up, as the firmware's `tunnel::Reason` names it. 2 is retired and never reused:
 * it meant "the key may not be kept", and a phone that has not been updated would read a new meaning
 * into the old number. `Setup`, `NoTask`, `Stuck` and `Retrying` are TailTiny's own refusals, which
 * the charm tells apart by the call that refused and the code it answered — the most a library that
 * reports no detail beyond those can be asked.
 */
export const CharmTailnetReason = {
  None: 0,
  NoKey: 1,
  BadKey: 3,
  Offline: 4,
  Refused: 5,
  Setup: 6,
  NoTask: 7,
  Stuck: 8,
  Retrying: 9,
} as const

export const CharmUpdateReason = {
  None: 0,
  Offline: 1,
  BadUrl: 2,
  BadHash: 3,
  TooBig: 4,
  WriteFailed: 5,
  Cancelled: 6,
  // The image was built for the other kind of charm, or states no kind at all: 7 is the firmware's
  // `WrongScheme`, and an app that did not know it would read a refusal it cannot name.
  WrongScheme: 7,
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

/**
 * What the network block's fields may measure, as the firmware's own bounds do: a network name, the
 * passphrase that joins it (none for an open network), an image's address, a tailnet auth key, and
 * the SHA-256 that names the image.
 */
export const CHARM_MAX_SSID_BYTES = 32
export const CHARM_MAX_PASS_BYTES = 63
export const CHARM_MAX_URL_BYTES = 180
export const CHARM_MAX_KEY_BYTES = 96
export const CHARM_SHA256_BYTES = 32
/**
 * The token a charm presents on every turn, as the firmware's own bound has it: the host mints 64
 * hex characters today, and this is the room a longer one still fits in.
 */
export const CHARM_MAX_TOKEN_BYTES = 128

/**
 * One firmware slot, as the partition table sizes it: an image larger than this cannot be received
 * at all, so the phone refuses it rather than spending minutes streaming bytes to a `TooBig`.
 */
export const CHARM_SLOT_BYTES = 0x640000

/** The quiet windows the charm runs, in seconds. It refuses anything else, so the app offers these. */
export const CHARM_QUIET_PRESETS = [15, 30, 60] as const
export type CharmQuiet = (typeof CHARM_QUIET_PRESETS)[number]

/** The glass's own settings, as the sheet keeps them and the charm knows them. */
export interface CharmWake {
  /** Whether two taps on the glass wake it. Off leaves the two buttons as the one way back. */
  doubleTap: boolean
  /** How long the glass stays lit after the last deliberate act. */
  quietSeconds: CharmQuiet
}

export const CHARM_WAKE_DEFAULT: CharmWake = { doubleTap: true, quietSeconds: 15 }

/**
 * One reading of the charm's battery, as op 0x0d answers with it. A percent of -1 is a charm that
 * could not read its own charge: unknown, which is not the same as empty and must never be drawn as
 * 0%.
 */
export interface CharmBattery {
  percent: number
  charging: boolean
  /**
   * When the charm gave the reading, where the phone keeps it as a record: the settings page's own
   * reading carries it, while the update offer's ask — taken for that visit's gate — does not.
   */
  at?: number
}

/** The last reading the phone keeps: the reading, and when the charm gave it. */
export interface CharmBatterySeen extends CharmBattery {
  at: number
}

/** The glass's settings as the sheet holds them, with anything it does not understand put back. */
export function charmWakeOf(choice?: Partial<CharmWake> | null): CharmWake {
  const quietSeconds = CHARM_QUIET_PRESETS.find((seconds) => seconds === choice?.quietSeconds)
  return {
    doubleTap: choice?.doubleTap ?? CHARM_WAKE_DEFAULT.doubleTap,
    quietSeconds: quietSeconds ?? CHARM_WAKE_DEFAULT.quietSeconds,
  }
}

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
  /**
   * The charm kept it, but anyone holding the charm can read it off the chip: its flash is not
   * sealed. A success with a warning rather than a refusal — the secret survives a reboot either
   * way, and only a sealed charm keeps it to itself.
   */
  KeptReadable: 11,
  /** The charm is not on Wi-Fi, which a firmware download needs. */
  Offline: 12,
  /** The charm is already updating, or a bot sync is in flight. */
  Busy: 13,
} as const

/** What the charm says a code means, in words a settings row can show. No code's words name an op:
 * the table draws a sync's refusal, a provisioning write's and the Voice row's alike, so a reader is
 * never told the charm "refused the sync" of a switch. */
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
  [CharmCode.KeptReadable]:
    "The charm kept it, but anyone holding the charm can read it off the chip",
  [CharmCode.Offline]: "The charm isn't on Wi-Fi",
  [CharmCode.Busy]: "The charm is busy; try again when it's done",
}

export const codeWords = (code: number) => CODE_WORDS[code] ?? `The charm refused it (${code})`

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

/** The one UTF-8 encoder every frame is written with, shared with the callers that measure what a
 * frame will hold (`talk.ts` bounds the address before a link is opened). */
export const encoder = new TextEncoder()

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
  /** Bytes as they are, with no length in front: a SHA-256 is its own 32 bytes. */
  raw(b: Uint8Array) {
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
 * The longest one is 430 bytes — 64 of title, 128 of body, two buttons of 16 and 32 bytes each, and
 * 64 of subject and of bot id — which is why the writer asks for a larger MTU before it writes one.
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
 * anything that is not this answer at all. A handoff answer is seven bytes or more and names its own
 * op, so a status whose third byte happened to be `0x22` still reads as no answer here.
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

/**
 * One `data` write, cut wherever the send position stands: the image's bytes from `at` — the
 * fill a Busy notice names is an offset of the image, not a boundary of the phone's own
 * chunking — prefixed with the offset they start at, at most `size` bytes long like every
 * other.
 */
export function chunkAt(image: Uint8Array, at: number, size: number): Uint8Array {
  const room = size - 4
  if (room < 1) throw new Error("Chunks too small")
  const part = image.subarray(at, Math.min(image.length, at + room))
  const chunk = new Uint8Array(4 + part.length)
  new DataView(chunk.buffer).setUint32(0, at, true)
  chunk.set(part, 4)
  return chunk
}

/** A picture as `data` writes: `[offset u32][bytes]`, each at most `size` bytes long. */
export function* imageChunks(image: Uint8Array, size: number): Generator<Uint8Array> {
  // One chunk at a time: a firmware image is over a megabyte, and a second copy of it held in
  // chunks is what a phone with the image already in memory cannot afford.
  for (let at = 0; at < image.length; at += size - 4) yield chunkAt(image, at, size)
}

/**
 * The largest `data` write a link carries: the MTU less ATT's 3 bytes, capped at 512. The floor is
 * the smallest payload an ATT link can carry (MTU 23), so a chunk never outgrows the link and the
 * four-byte offset always leaves a byte of image behind it.
 */
export const chunkSize = (mtu: number) => Math.max(20, Math.min(512, mtu - 3))

export function parseStatus(view: DataView): CharmStatus {
  if (view.byteLength < 4) throw new Error("The charm sent a short answer")
  const status: CharmStatus = {
    version: view.getUint8(0),
    code: view.getUint8(1),
    op: view.getUint8(2),
    needImage: view.getUint8(3) === 1,
  }
  return status
}

/**
 * The `Battery` answer, read off `[extraLen][extra]` as the network's is: the level, then the charger.
 * A level of -1 is a charm that could not read its own charge — unknown, which is not a battery at 0%
 * — and anything shorter, longer-prefixed or from another op is no answer at all.
 */
export function parseBattery(view: DataView): CharmBattery | null {
  if (view.byteLength < 7) return null
  if (view.getUint8(2) !== CharmOp.Battery) return null
  if (view.getUint8(4) !== 2) return null
  return { percent: view.getInt8(5), charging: view.getUint8(6) === 1 }
}

/**
 * The network block: provisioning the charm's Wi-Fi, its tailnet key, and a firmware image it fetches
 * itself. Every one is a control write answered by one status notification — four bytes, or the same
 * four and then `[extraLen u8][extra]` for the two asks. The firmware's `docs/PROTOCOL.md` fixes
 * every number here, as it does the rest of this file.
 */

const decoder = new TextDecoder()

export const forgetMessage = () => control(CharmOp.Forget).done()
export const networkMessage = () => control(CharmOp.Network).done()
export const updateStatusMessage = () => control(CharmOp.UpdateStatus).done()

/** Which build the charm runs: the ask is the message, as the battery's and the handoff's are. */
export const firmwareMessage = () => control(CharmOp.Firmware).done()

/**
 * An image the phone sends itself: its length and the SHA-256 it must hash to. The writes that
 * follow are the image's, `[offset u32][bytes]` in order from the first, as a picture's are.
 */
export function updateBeginMessage(size: number, sha256: Uint8Array): Uint8Array {
  if (sha256.length !== CHARM_SHA256_BYTES)
    throw new Error("An upload carries the image's 32-byte SHA-256")
  return control(CharmOp.UpdateBegin).u32(size).raw(sha256).done()
}

/** The image is whole: the charm checks the length and the hash, then makes the slot bootable. */
export const updateEndMessage = () => control(CharmOp.UpdateEnd).done()

/**
 * The network to join. A passphrase of none is an open network, which the charm reads as such rather
 * than as a blank password.
 */
export function wifiMessage(ssid: string, pass = ""): Uint8Array {
  const name = encoder.encode(ssid)
  if (name.length === 0) throw new Error("A Wi-Fi name is at least 1 byte")
  if (name.length > CHARM_MAX_SSID_BYTES) throw new Error("A Wi-Fi name is at most 32 bytes")
  const secret = encoder.encode(pass)
  if (secret.length > CHARM_MAX_PASS_BYTES)
    throw new Error("A Wi-Fi passphrase is at most 63 bytes")
  return control(CharmOp.Wifi).str(name).str(secret).done()
}

/** A Tailscale auth key, which the charm uses once to join the tailnet. */
export function tailnetMessage(key: string): Uint8Array {
  const bytes = encoder.encode(key)
  if (bytes.length === 0) throw new Error("A tailnet key is at least 1 byte")
  if (bytes.length > CHARM_MAX_KEY_BYTES) throw new Error("A tailnet key is at most 96 bytes")
  return control(CharmOp.Tailnet).str(bytes).done()
}

/**
 * A URL as an address op carries it: the bytes of it, refused here for a scheme the charm cannot use
 * or a length past what it holds, and never encoded twice by two ops that disagree. The ops want
 * different schemes — the charm fetches an image over https only, and a turn's address is either,
 * because it has a door for each — so the schemes are the caller's, the bound is this module's, and
 * `needs` is an op's own wording for the refusal where it has been said one way already. The update
 * screen's fetch URL is built on it too, so the one address the phone hands the charm is bounded
 * the one way every address it carries is.
 */
export function addressBytes(
  url: string,
  scheme: "http" | "https" | readonly ("http" | "https")[],
  what: string,
  needs = `${what} must be ${(Array.isArray(scheme) ? scheme : [scheme])
    .map((one) => `${one}://`)
    .join(" or ")}`,
) {
  const bytes = encoder.encode(url)
  if (bytes.length === 0) throw new Error(`${what} is at least 1 byte`)
  const allowed = Array.isArray(scheme) ? scheme : [scheme]
  if (!allowed.includes(schemeOf(url) as "http" | "https")) throw new Error(needs)
  if (bytes.length > CHARM_MAX_URL_BYTES)
    throw new Error(`${what} is at most ${CHARM_MAX_URL_BYTES} bytes`)
  return bytes
}

/**
 * The address the charm's turns are posted to and the token it presents with them, as
 * `[urlLen u8][url][tokenLen u8][token]`. The charm appends `/talk/v1/turn` to the address, keeps
 * both, and answers the address back only (`talkStateMessage`) — the token is never answered —
 * `Forget` sweeps them with its other secrets.
 *
 * The bounds are the firmware's own: `CHARM_MAX_URL_BYTES` for the address and
 * `CHARM_MAX_TOKEN_BYTES` for the token. Which addresses the charm can actually call is `talk.ts`'s
 * rule, since only it knows what the reader was told; here one is only refused.
 */
export function talkFrame(address: string, token: string): Uint8Array {
  const url = addressBytes(address, ["http", "https"], "A talk address")
  const secret = encoder.encode(token)
  if (secret.length === 0) throw new Error("A talk token is at least 1 byte")
  if (secret.length > CHARM_MAX_TOKEN_BYTES)
    throw new Error(`A talk token is at most ${CHARM_MAX_TOKEN_BYTES} bytes`)
  return control(CharmOp.Talk).str(url).str(secret).done()
}

/**
 * The ask whose answer is what the charm holds: `[extraLen u8][urlLen u8][url]`, the address never
 * the token. `null` is a charm that holds none — and a charm older than the op refuses it outright,
 * which the page draws as a firmware without the answer rather than as an empty one.
 */
export const talkStateMessage = () => control(CharmOp.TalkState).done()
export const diagnoseMessage = () => control(CharmOp.Diagnose).done()
export const logMessage = (on: boolean) =>
  control(CharmOp.Log)
    .u8(on ? 1 : 0)
    .done()
export const logTailMessage = (from: number) => control(CharmOp.LogTail).u16(from).done()

/**
 * The ask for the rows after a row the phone already holds: the index is four bytes and little-endian
 * like every other `u32` on this wire. Sixteen bits would have wrapped after about an hour and a half
 * of the charm's own logging, and a wrapped index reads new rows as ones the phone already has.
 */
export const logSinceMessage = (from: number) => control(CharmOp.LogSince).u32(from).done()

/**
 * The door a press's microphone refused at, and the memory the charm had at that moment. `asked` is
 * whether any press has opened a microphone at all: `exit` 0 is both "the last open succeeded" and
 * "nothing has opened yet", and a page that took the two as one would show three zeros as a reading.
 */
export interface CharmDiagnose {
  asked: boolean
  /** `CharmMicExit`: 0 nothing, 1 busy, 2 island, 3 codec memory, 4 encoder, 5 decoder, 6 frames,
   * 7 queue, 8 play buffer, 9 microphone, 10 capture task. */
  exit: number
  freeInternal: number
  largestInternal: number
  freePsram: number
}

export function parseDiagnose(view: DataView): CharmDiagnose | null {
  if (view.byteLength < 5) return null
  if (view.getUint8(2) !== CharmOp.Diagnose) return null
  const extra = view.getUint8(4)
  if (extra < 14 || view.byteLength < 5 + 14) return null
  return {
    asked: view.getUint8(5) === 1,
    exit: view.getUint8(6),
    freeInternal: view.getUint32(7, true),
    largestInternal: view.getUint32(11, true),
    freePsram: view.getUint32(15, true),
  }
}

/** One row of the charm's log, as the ring wrapped it: never longer than the panel's column. */
export interface CharmLogRow {
  text: string
  /** The row carries a line on from the row above it — a wrapped line's remainder. */
  carried: boolean
}

export interface CharmLogPage {
  /** Every row the charm keeps, so a reader knows when it has the lot. */
  total: number
  /** The index of the first row here; a page asked past the end answers none. */
  from: number
  rows: CharmLogRow[]
}

/**
 * `count` rows from `at`, each `[flags u8][len u8][text]`, and none of them past `end` — the extra's
 * own length, because a row that overruns it is a page the link cut in half rather than a short page.
 * Both log ops answer these same bytes, so both are read here: a second reader would be a second
 * rule about where a row ends, and the two pages must draw alike.
 */
function logRows(view: DataView, at: number, count: number, end: number): CharmLogRow[] | null {
  const rows: CharmLogRow[] = []
  for (let i = 0; i < count; i++) {
    if (at + 2 > end) return null
    const flags = view.getUint8(at)
    const len = view.getUint8(at + 1)
    at += 2
    if (at + len > end) return null
    const bytes = new Uint8Array(view.buffer, view.byteOffset + at, len)
    rows.push({ text: decoder.decode(bytes), carried: (flags & 1) !== 0 })
    at += len
  }
  return rows
}

export function parseLogPage(view: DataView): CharmLogPage | null {
  if (view.byteLength < 10) return null
  if (view.getUint8(2) !== CharmOp.LogTail) return null
  const extra = view.getUint8(4)
  if (extra < 5 || view.byteLength < 5 + extra) return null
  const total = view.getUint16(5, false)
  const from = view.getUint16(7, false)
  const rows = logRows(view, 10, view.getUint8(9), 5 + extra)
  if (!rows) return null
  return { total, from, rows }
}

export interface CharmLogSincePage {
  /**
   * The index the page's first row really carries: the one asked for when the ring still holds it, the
   * ring's oldest when the ask fell behind the head, or one past the newest with no rows at all — which
   * is how a reader is told it has the lot, and how it learns the charm's count began again.
   */
  base: number
  rows: CharmLogRow[]
}

/**
 * The `LogSince` answer: `[base u32][count u8]` and then `count` rows in `LogTail`'s own bytes. The
 * base is little-endian, as the ask is, and it is the charm's answer rather than the phone's ask,
 * since only the ring knows where its rows begin. Null is a frame short of its own header, another
 * op's answer, or a page whose rows run past the extra — never half a page, because a base read from
 * a cut frame would place rows where the charm never had them.
 */
export function parseLogSince(view: DataView): CharmLogSincePage | null {
  if (view.byteLength < 10) return null
  if (view.getUint8(2) !== CharmOp.LogSince) return null
  const extra = view.getUint8(4)
  if (extra < 5 || view.byteLength < 5 + extra) return null
  const rows = logRows(view, 10, view.getUint8(9), 5 + extra)
  if (!rows) return null
  return { base: view.getUint32(5, true), rows }
}

export function parseTalkState(view: DataView): { address: string | null } | null {
  if (view.byteLength < 6) return null
  if (view.getUint8(2) !== CharmOp.TalkState) return null
  const extra = view.getUint8(4)
  if (extra < 1 || view.byteLength < 5 + extra) return null
  const urlLen = view.getUint8(5)
  if (extra !== 1 + urlLen) return null
  if (urlLen === 0) return { address: null }
  const bytes = new Uint8Array(view.buffer, view.byteOffset + 6, urlLen)
  return { address: decoder.decode(bytes) }
}

/**
 * The image to fetch, and the SHA-256 that has to match it. The charm makes the request itself, so
 * the address must be one it can fetch: https over the Wi-Fi it joins — a certificate checked
 * against its own roots — or plain http over its tailnet, which the charm takes only while its
 * tunnel is up. The rule is the firmware's own (`Updater::update`); the phone's door-picking
 * (`firmwareDoor`) is what hands an http address only to a charm whose tunnel is up.
 */
export function updateMessage(url: string, sha256: Uint8Array): Uint8Array {
  const address = addressBytes(url, ["https", "http"], "An update address")
  if (sha256.length !== CHARM_SHA256_BYTES)
    throw new Error("An update carries the image's 32-byte SHA-256")
  return control(CharmOp.Update).str(address).raw(sha256).done()
}

/** A hash as a person pastes it — hex, in either case, with spaces or colons — as its bytes. */
export function hexBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[\s:]/g, "").toLowerCase()
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0)
    throw new Error("A SHA-256 is 64 hexadecimal characters")
  const bytes = new Uint8Array(clean.length / 2)
  for (let at = 0; at < bytes.length; at++)
    bytes[at] = parseInt(clean.slice(at * 2, at * 2 + 2), 16)
  return bytes
}

/** Bytes as the hash a person reads and pastes: lowercase hex. */
export const hexOf = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * The codes a network write takes as a yes: a sealed charm's `Ok`, and `KeptReadable` — a plaintext
 * charm keeps the secret too, and says in words that anyone holding it can read the secret off the
 * chip. One rule, so the record, the store's write and the settings write cannot disagree about
 * whether the charm kept it.
 */
export const charmKept = (code: number) => code === CharmCode.Ok || code === CharmCode.KeptReadable

/** What this phone keeps about the charm's Wi-Fi: the network, and whether the charm keeps it. */
export interface CharmWifiRecord {
  ssid: string
  /**
   * The charm kept it, so it outlives a reboot. Only a yes writes a record, and 11 is one of them:
   * a secret kept readable is still kept, and its warning is the code's words rather than this row's.
   */
  saved: boolean
}

/**
 * The record a Wi-Fi write leaves. It is the name and the charm's own word about keeping it — never
 * the passphrase, which is the charm's from the write on.
 */
export const wifiRecord = (ssid: string, code: number): CharmWifiRecord => ({
  ssid,
  saved: charmKept(code),
})

/** The charm's link, as it answers the `Network` ask. */
export interface CharmNetworkReport {
  wifi: { state: number; reason: number; ip: string; ssid: string }
  tailnet: {
    state: number
    ip: string
    /**
     * Why the tunnel is not up, as `CharmTailnetReason` numbers it. Absent from a charm whose
     * firmware predates the byte — which is why it is optional rather than 0: "nothing sent" and
     * "no reason" are two facts, and a row that took the second for the first would say a charm is
     * fine when it never spoke.
     */
    reason?: number
  }
}

/**
 * The `Network` answer, read off `[extraLen][extra]`: the Wi-Fi link, its address and the network it
 * joined, then the tunnel's. A short answer, one whose extra never arrived, or one that answers
 * another op is no report at all — never half of one, since half a report would draw a state the
 * charm never had.
 */
export function parseNetworkReport(view: DataView): CharmNetworkReport | null {
  if (view.byteLength < 5) return null
  if (view.getUint8(2) !== CharmOp.Network) return null
  const end = 5 + view.getUint8(4)
  if (view.byteLength < end) return null
  let at = 5
  const byte = () => {
    if (at >= end) throw new Error("short")
    return view.getUint8(at++)
  }
  const field = () => {
    const length = byte()
    if (at + length > end) throw new Error("short")
    const text = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + at, length))
    at += length
    return text
  }
  try {
    return {
      wifi: { state: byte(), reason: byte(), ip: field(), ssid: field() },
      tailnet: {
        state: byte(),
        ip: field(),
        // The reason is the report's last byte. A charm older than it ends here, and an answer that
        // stops at the address is complete rather than short: the key is absent, never a zero that
        // would read as "no reason".
        ...(at < end ? { reason: byte() } : {}),
      },
    }
  } catch {
    return null
  }
}

/** Where a firmware download has got to, as it answers the `UpdateStatus` ask. */
export interface CharmUpdateStatus {
  state: number
  percent: number
  reason: number
}

/** The `UpdateStatus` answer: three bytes of extra, and null for anything shorter or for another op. */
export function parseUpdateStatus(view: DataView): CharmUpdateStatus | null {
  if (view.byteLength < 5) return null
  if (view.getUint8(2) !== CharmOp.UpdateStatus) return null
  const extra = view.getUint8(4)
  if (extra < 3 || view.byteLength < 5 + extra) return null
  return { state: view.getUint8(5), percent: view.getUint8(6), reason: view.getUint8(7) }
}

/**
 * The fill a Busy notice carries as its extra — `[extraLen u8][fill u32 LE]`, the offset the
 * charm's updater is waiting for the image to resume at, which the fixed charm sends (the
 * plan's step 2, `docs/PROTOCOL.md` in hermesgots-charm). Null for the four-byte notice every
 * charm before the fix sends, which names no position to resume from.
 */
export function busyFill(view: DataView): number | null {
  if (view.byteLength < 9) return null
  if (view.getUint8(4) !== 4) return null
  return view.getUint32(5, true)
}

/**
 * The `Firmware` answer: `[extraLen][version]`, text like `0.1.0`. Null for anything else — a charm
 * whose firmware predates the op answers `BadMessage` with no extra at all, and that is a charm to
 * offer an update to rather than a failure to draw.
 */
export function parseFirmware(view: DataView): string | null {
  if (view.byteLength < 5) return null
  if (view.getUint8(1) !== CharmCode.Ok) return null
  if (view.getUint8(2) !== CharmOp.Firmware) return null
  const length = view.getUint8(4)
  if (length === 0 || view.byteLength < 5 + length) return null
  return decoder.decode(new Uint8Array(view.buffer, view.byteOffset + 5, length))
}

/** The glass's settings: [doubleTap u8][quietSeconds u8], one of the three windows or nothing. */
export function wakeMessage(wake: CharmWake): Uint8Array {
  if (!CHARM_QUIET_PRESETS.includes(wake.quietSeconds))
    throw new Error("The charm runs 15, 30 or 60 seconds")
  return control(CharmOp.SleepSettings)
    .u8(wake.doubleTap ? 1 : 0)
    .u8(wake.quietSeconds)
    .done()
}

/** The battery ask: no payload, because the ask is the message, as the handoff's is. */
export const batteryMessage = () => control(CharmOp.Battery).done()

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
