/**
 * The Gots Charm sync, phone side, against a charm faked in memory: the bytes match the firmware's
 * spec (docs/PROTOCOL.md in hermesgots-charm), only missing pictures go over the air, a damaged one
 * is sent again, and a refusal leaves the charm's list as it was.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  CHARM_MAX_IMAGE_BYTES,
  CHARM_MAX_KEY_BYTES,
  CHARM_MAX_PASS_BYTES,
  CHARM_MAX_SSID_BYTES,
  CHARM_MAX_URL_BYTES,
  CHARM_SHA256_BYTES,
  CharmCode,
  CharmLinkState,
  CharmOp,
  CharmUpdateState,
  beginMessage,
  botMessage,
  charmMood,
  charmWakeOf,
  batteryMessage,
  checkBots,
  chunkSize,
  codeWords,
  crc32,
  forgetMessage,
  hexBytes,
  hexOf,
  imageChunks,
  networkMessage,
  parseBattery,
  parseNetworkReport,
  parseStatus,
  parseUpdateStatus,
  petSettingsFrom,
  petSettingsMessage,
  poseImageEndMessage,
  poseImageMessage,
  poseMessage,
  rgb565,
  tailnetMessage,
  timeMessage,
  updateMessage,
  updateStatusMessage,
  utf8Clip,
  wifiMessage,
  wifiRecord,
  wakeMessage,
} from "../src/lib/charm-protocol.ts"
import { CharmRefused, syncCharm } from "../src/lib/charm-sync.ts"
import { batteryWords, refusalWords } from "../src/lib/charm-words.ts"

test("crc32 is zlib's", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926)
  assert.equal(crc32(new Uint8Array()), 0)
})

test("rgb565 packs colours", () => {
  assert.equal(rgb565("#ffffff"), 0xffff)
  assert.equal(rgb565("#ff0000"), 0xf800)
  assert.equal(rgb565("#00ff00"), 0x07e0)
  assert.equal(rgb565("nonsense"), 0)
})

test("utf8Clip never splits a character", () => {
  const clipped = utf8Clip("aé€", 4) // a(1) é(2) €(3)
  assert.deepEqual([...clipped], [0x61, 0xc3, 0xa9])
})

const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]

test("messages are laid out as the firmware reads them", () => {
  assert.deepEqual([...beginMessage(3)], [1, 1, 3])
  const image = new Uint8Array([1, 2, 3])
  const waiting = new Uint8Array([4, 5])
  const m = botMessage(2, { id: "ab", name: "N", accent: 0x1234, image, waiting })
  assert.deepEqual(
    [...m],
    [
      1,
      2,
      2,
      0x34,
      0x12,
      ...u32(3),
      ...u32(crc32(image)),
      ...u32(2),
      ...u32(crc32(waiting)),
      2,
      0x61,
      0x62,
      1,
      0x4e,
    ],
  )
  // A bot with no waiting picture announces none: a zero length and no CRC, which is what says so.
  const none = botMessage(0, { id: "a", name: "N", accent: 0, image, waiting: new Uint8Array() })
  assert.deepEqual(
    [...none.subarray(5, 21)],
    [...u32(3), ...u32(crc32(image)), ...u32(0), ...u32(0)],
  )
})

test("the pet's messages are laid out as the firmware reads them", () => {
  assert.deepEqual([...timeMessage(1795176000)], [1, 11, ...u32(1795176000)])

  const on = petSettingsMessage({
    enabled: true,
    petBotId: "nova",
    bedStart: 22,
    bedEnd: 7,
    utcOffsetMin: -300,
  })
  // -300 as a little-endian i16 is 0xfed4.
  assert.deepEqual([...on], [1, 7, 1, 22, 7, 0xd4, 0xfe, 4, 0x6e, 0x6f, 0x76, 0x61])
  assert.deepEqual(
    [
      ...petSettingsMessage({
        enabled: false,
        petBotId: "",
        bedStart: 22,
        bedEnd: 7,
        utcOffsetMin: 0,
      }),
    ],
    [1, 7, 0, 22, 7, 0, 0, 0],
  )
  // A pet with no bot, or a night that is not hours, never reaches the radio.
  assert.throws(
    () =>
      petSettingsMessage({ enabled: true, petBotId: "", bedStart: 22, bedEnd: 7, utcOffsetMin: 0 }),
    /Choose a bot to be the pet/,
  )
  assert.throws(
    () =>
      petSettingsMessage({
        enabled: true,
        petBotId: "nova",
        bedStart: 24,
        bedEnd: 7,
        utcOffsetMin: 0,
      }),
    /two hours of the day/,
  )

  assert.equal(charmMood("hungry"), 6)
  assert.equal(charmMood("asleep"), 9)
  const image = new Uint8Array([1, 2, 3])
  assert.deepEqual([...poseMessage("hungry", image)], [1, 8, 6, 3, 0, 0, 0, ...u32(crc32(image))])
  assert.deepEqual([...poseImageMessage("hungry")], [1, 9, 6])
  assert.deepEqual([...poseImageEndMessage("hungry")], [1, 10, 6])
})

test("pet mode is off until the sheet says otherwise, and off again when its bot goes", () => {
  const off = petSettingsFrom(undefined, ["nova"], 60)
  assert.deepEqual(off, {
    enabled: false,
    petBotId: "",
    bedStart: 22,
    bedEnd: 7,
    utcOffsetMin: 60,
  })
  assert.equal(petSettingsFrom({ enabled: true, botId: "nova" }, ["nova"], 0).enabled, true)
  // A pet whose bot has been deleted, or disabled out of the sync, cannot be sent.
  assert.equal(petSettingsFrom({ enabled: true, botId: "gone" }, ["nova"], 0).enabled, false)
  assert.equal(petSettingsFrom({ enabled: true, botId: "nova" }, [], 0).petBotId, "")
})

test("chunks carry their offset and fit the link", () => {
  const image = new Uint8Array(1000).map((_, i) => i & 0xff)
  const size = chunkSize(247)
  const chunks = imageChunks(image, size)
  assert.ok(chunks.every((c) => c.length <= size))
  const joined = []
  for (const c of chunks) {
    const view = new DataView(c.buffer, c.byteOffset)
    assert.equal(view.getUint32(0, true), joined.length)
    joined.push(...c.subarray(4))
  }
  assert.deepEqual(joined, [...image])
  assert.equal(chunkSize(23), 23)
  assert.equal(chunkSize(1000), 512)
})

/** A charm in memory, following the firmware's sync session. */
function fakeCharm({
  corruptOnce = false,
  refuseCommit = false,
  corruptPoseOnce = false,
  refusePet = false,
  refuseWake = false,
  battery = { percent: 85, charging: false },
} = {}) {
  const held = new Map() // crc -> len
  let shown = []
  let pending = []
  let image = []
  let corrupted = !corruptOnce
  const imagesSent = []
  const pet = { enabled: false, petBotId: "", bedStart: 0, bedEnd: 0, utcOffsetMin: 0, clock: 0 }
  const wake = { doubleTap: true, quietSeconds: 15 }
  const poses = new Map() // mood -> crc
  let posePending = null
  let poseDamaged = !corruptPoseOnce
  const ops = []
  const answer = (code, op, needImage = false) =>
    parseStatus(new DataView(new Uint8Array([1, code, op, needImage ? 1 : 0]).buffer))
  return {
    held,
    imagesSent,
    ops,
    pet,
    wake,
    poses,
    get shown() {
      return shown
    },
    link: {
      mtu: 185,
      async control(m) {
        const v = new DataView(m.buffer, m.byteOffset, m.byteLength)
        const op = m[1]
        ops.push(op)
        if (op === 0x0c) {
          if (refuseWake) return answer(2, op)
          wake.doubleTap = m[2] === 1
          wake.quietSeconds = m[3]
          return answer(0, op)
        }
        if (op === 0x0d) {
          // Six bytes, as the firmware answers: the op byte is what makes the shape unmistakable.
          return parseStatus(
            new DataView(
              new Uint8Array([1, 0, op, 0, battery.percent & 0xff, battery.charging ? 1 : 0]).buffer,
            ),
          )
        }
        if (op === 1) {
          pending = new Array(m[2])
          return answer(0, op)
        }
        if (op === 2) {
          const index = m[2]
          const len = v.getUint32(5, true)
          const crc = v.getUint32(9, true)
          const waitLen = v.getUint32(13, true)
          const waitCrc = v.getUint32(17, true)
          const idLen = m[21]
          const id = new TextDecoder().decode(m.subarray(22, 22 + idLen))
          const name = new TextDecoder().decode(m.subarray(23 + idLen, 23 + idLen + m[22 + idLen]))
          // The two pictures a bot announces, the carousel's and the one an alert draws. A zero
          // length announces none.
          const pictures = [
            { len, crc },
            { len: waitLen, crc: waitCrc },
          ].filter((picture) => picture.len > 0)
          pending[index] = { id, name, pictures }
          const missing = pictures.some((picture) => held.get(picture.crc) !== picture.len)
          return answer(0, op, missing)
        }
        if (op === 3) {
          image = []
          return answer(0, op)
        }
        if (op === 4) {
          const bot = pending[m[2]]
          const bytes = new Uint8Array(image)
          if (!corrupted) {
            corrupted = true
            bytes[0] ^= 0xff
          }
          // A picture is one of the two the bot announced: the charm knows it by length and CRC,
          // which is also what tells the two apart when they are the same size.
          const asked = bot.pictures.find(
            (picture) => picture.len === bytes.length && crc32(bytes) === picture.crc,
          )
          if (!asked) return answer(7, op, true)
          held.set(asked.crc, asked.len)
          imagesSent.push(bot.id)
          return answer(0, op)
        }
        if (op === 5) {
          if (refuseCommit) return answer(CharmCode.StorageFailed, op)
          shown = pending.map(({ id, name }) => ({ id, name }))
          return answer(0, op)
        }
        if (op === 6) return answer(0, op)
        if (op === 7) {
          const idLen = m[7]
          pet.enabled = m[2] === 1
          pet.bedStart = m[3]
          pet.bedEnd = m[4]
          pet.utcOffsetMin = v.getInt16(5, true)
          pet.petBotId = new TextDecoder().decode(m.subarray(8, 8 + idLen))
          return answer(0, op)
        }
        if (op === 8) {
          const mood = m[2]
          const len = v.getUint32(3, true)
          const crc = v.getUint32(7, true)
          posePending = { mood, len, crc }
          return answer(0, op, len > 0 && poses.get(mood) !== crc)
        }
        if (op === 9) {
          image = []
          return answer(0, op)
        }
        if (op === 10) {
          const mood = m[2]
          const bytes = new Uint8Array(image)
          if (!poseDamaged) {
            poseDamaged = true
            bytes[0] ^= 0xff
          }
          if (!posePending || posePending.mood !== mood) return answer(CharmCode.BadIndex, op)
          if (bytes.length !== posePending.len || crc32(bytes) !== posePending.crc)
            return answer(CharmCode.BadImage, op, true)
          poses.set(mood, posePending.crc)
          return answer(0, op)
        }
        if (op === 11) {
          // A charm on firmware from before pet mode answers the first pet op this way.
          if (refusePet) return answer(CharmCode.BadMessage, op)
          pet.clock = v.getUint32(2, true)
          return answer(0, op)
        }
        return answer(CharmCode.BadMessage, op)
      },
      async data(chunk) {
        image.push(...chunk.subarray(4))
      },
    },
  }
}

const picture = (seed, n = 3000) => new Uint8Array(n).map((_, i) => (i * 7 + seed) & 0xff)

test("a sync sends every bot, then only what changed", async () => {
  const charm = fakeCharm()
  const bots = [
    { id: "nova", name: "Nova", accent: 1, image: picture(1), waiting: picture(5) },
    { id: "pixel", name: "Pixel", accent: 2, image: picture(2), waiting: picture(6) },
    { id: "plain", name: "Plain", accent: 3, image: new Uint8Array(), waiting: new Uint8Array() },
  ]
  const seen = []
  const first = await syncCharm(charm.link, bots, (p) => seen.push(p.done))
  // Two pictures a bot: the carousel's face and the one an alert draws. Plain has neither.
  assert.deepEqual(first, { done: 3, total: 3, sent: 4 })
  assert.deepEqual(seen, [0, 1, 2, 3])
  assert.deepEqual(
    charm.shown.map((b) => b.name),
    ["Nova", "Pixel", "Plain"],
  )

  const renamed = [
    { ...bots[1], name: "Pix" },
    bots[0],
    { ...bots[2], image: picture(9), waiting: picture(10) },
  ]
  const second = await syncCharm(charm.link, renamed)
  assert.equal(second.sent, 2, "the two pictures the plain bot just gained")
  assert.equal(charm.imagesSent.length, 6, "the rest the charm already held")
  assert.deepEqual(
    charm.shown.map((b) => b.name),
    ["Pix", "Nova", "Plain"],
  )
})

test("a bot's two pictures go over, and one the charm holds does not", async () => {
  const charm = fakeCharm()
  const nova = { id: "nova", name: "Nova", accent: 1, image: picture(1), waiting: picture(5) }
  const first = await syncCharm(charm.link, [nova])
  assert.equal(first.sent, 2, "the carousel's face and the one an alert draws")
  assert.equal(charm.held.size, 2)

  // The charm lost the carousel's face: its one bit sends both, and the one it holds is cheap.
  charm.held.delete(crc32(nova.image))
  const second = await syncCharm(charm.link, [nova])
  assert.equal(second.sent, 2, "an answer about either picture sends the pair")
  assert.ok(charm.held.has(crc32(nova.image)))
  assert.ok(charm.held.has(crc32(nova.waiting)))
})

test("a bot with no waiting picture announces one picture", async () => {
  const charm = fakeCharm()
  const result = await syncCharm(charm.link, [
    { id: "nova", name: "Nova", accent: 1, image: picture(1), waiting: new Uint8Array() },
  ])
  assert.equal(result.sent, 1)
  assert.equal(charm.held.size, 1)
})

const nova = { id: "nova", name: "Nova", accent: 1, image: picture(1), waiting: picture(5) }
const petOn = { enabled: true, petBotId: "nova", bedStart: 22, bedEnd: 7, utcOffsetMin: 120 }

test("pet mode lands after the bots' commit, its pictures before the toggle", async () => {
  const charm = fakeCharm()
  const poses = [
    { mood: "happy", image: picture(11, 900) },
    { mood: "hungry", image: picture(12, 900) },
  ]
  await syncCharm(charm.link, [nova], undefined, {
    pet: { settings: petOn, poses },
    now: 1795176000 * 1000,
  })
  assert.equal(charm.pet.enabled, true)
  assert.equal(charm.pet.petBotId, "nova")
  assert.equal(charm.pet.bedStart, 22)
  assert.equal(charm.pet.utcOffsetMin, 120)
  assert.equal(charm.pet.clock, 1795176000)
  assert.deepEqual([...charm.poses.keys()], [0, 6])
  assert.equal(charm.shown.length, 1)
  // The bots' commit lands before the pet's toggle, so an older charm still takes its bots.
  assert.ok(charm.ops.indexOf(5) < charm.ops.indexOf(7))
  assert.equal(charm.ops.at(-1), 7)

  // Nothing the charm already holds goes over again, the pet's pictures included.
  const before = charm.imagesSent.length
  await syncCharm(charm.link, [nova], undefined, {
    pet: { settings: petOn, poses },
    now: 1795176000 * 1000,
  })
  assert.equal(charm.imagesSent.length, before)
  assert.equal(charm.poses.size, 2)
})

test("a charm with no pet mode still keeps the bots, and says so", async () => {
  const charm = fakeCharm({ refusePet: true })
  const result = await syncCharm(charm.link, [nova], undefined, {
    pet: { settings: petOn, poses: [{ mood: "hungry", image: picture(12, 900) }] },
    now: 1795176000 * 1000,
  })
  assert.equal(result.petRefused, true)
  assert.deepEqual(
    charm.shown.map((b) => b.name),
    ["Nova"],
  )
  assert.equal(charm.pet.enabled, false)
})

test("pet mode off sends the toggle and no pictures", async () => {
  const charm = fakeCharm()
  await syncCharm(charm.link, [nova], undefined, {
    pet: {
      settings: { ...petOn, enabled: false },
      poses: [{ mood: "hungry", image: picture(12, 900) }],
    },
    now: 1795176000 * 1000,
  })
  assert.equal(charm.pet.enabled, false)
  assert.equal(charm.poses.size, 0)
  // The clock still goes over: the phone is the charm's only source of time.
  assert.equal(charm.pet.clock, 1795176000)
})

test("a damaged pet picture is sent again", async () => {
  const charm = fakeCharm({ corruptPoseOnce: true })
  await syncCharm(charm.link, [nova], undefined, {
    pet: { settings: petOn, poses: [{ mood: "hungry", image: picture(12, 900) }] },
    now: 1795176000 * 1000,
  })
  assert.equal(charm.poses.size, 1)
  assert.equal(charm.shown.length, 1)
})

test("a damaged picture is sent again", async () => {
  const charm = fakeCharm({ corruptOnce: true })
  const result = await syncCharm(charm.link, [
    { id: "nova", name: "Nova", accent: 1, image: picture(1), waiting: picture(5) },
  ])
  assert.equal(result.sent, 2)
  assert.equal(charm.shown.length, 1)
})

test("a refusal throws in words and leaves the charm's list alone", async () => {
  const charm = fakeCharm({ refuseCommit: true })
  await assert.rejects(
    syncCharm(charm.link, [
      { id: "nova", name: "Nova", accent: 1, image: picture(1), waiting: picture(5) },
    ]),
    (error) => error instanceof CharmRefused && /storage/.test(error.message),
  )
  assert.deepEqual(charm.shown, [])
})

test("too many bots never reach the radio", async () => {
  const charm = fakeCharm()
  const many = Array.from({ length: 33 }, (_, i) => ({
    id: `b${i}`,
    name: `B${i}`,
    accent: 0,
    image: new Uint8Array(),
    waiting: new Uint8Array(),
  }))
  await assert.rejects(syncCharm(charm.link, many), /at most 32/)
})

test("a picture too big for the charm never reaches the radio", () => {
  const big = new Uint8Array(CHARM_MAX_IMAGE_BYTES + 1)
  const bot = { id: "nova", name: "Nova", accent: 1 }
  assert.throws(
    () => checkBots([{ ...bot, image: big, waiting: new Uint8Array() }]),
    /Nova's picture is too big for the charm/,
  )
  assert.throws(
    () => checkBots([{ ...bot, image: new Uint8Array(), waiting: big }]),
    /Nova's waiting picture is too big for the charm/,
  )
  checkBots([{ ...bot, image: new Uint8Array(0), waiting: new Uint8Array(0) }])
})

test("the charm's row says whether it is paired and when it last synced", async () => {
  const { charmSubtitle } = await import("../src/lib/charm-words.ts")
  const now = Date.UTC(2026, 10, 20, 12)
  assert.equal(charmSubtitle(null, now), "Not paired")
  assert.equal(charmSubtitle({ name: "Gots Charm" }, now), "Gots Charm · Never synced")
  assert.equal(
    charmSubtitle({ name: "Gots Charm", syncedAt: now - 10_000 }, now),
    "Gots Charm · Synced just now",
  )
  assert.equal(
    charmSubtitle({ name: "Gots Charm", syncedAt: now - 5 * 60_000 }, now),
    "Gots Charm · Synced 5 min ago",
  )
  assert.equal(
    charmSubtitle({ name: "Gots Charm", syncedAt: now - 3 * 3_600_000 }, now),
    "Gots Charm · Synced 3 h ago",
  )
})

test("the pet row says which bot lives on the charm", async () => {
  const { petSubtitle } = await import("../src/lib/charm-words.ts")
  assert.equal(petSubtitle(undefined), "Your bots only, as they are now")
  assert.equal(petSubtitle({ enabled: false, botId: "nova" }), "Your bots only, as they are now")
  assert.equal(petSubtitle({ enabled: true }), "Choose the bot that lives there")
  assert.equal(petSubtitle({ enabled: true, botId: "nova" }, "Nova"), "Lives on the charm")
})

test("the paired charm's own row says only when it last synced", async () => {
  const { charmSynced } = await import("../src/lib/charm-words.ts")
  const now = Date.UTC(2026, 10, 20, 12)
  assert.equal(charmSynced({ name: "Gots Charm" }, now), "Never synced")
  assert.equal(
    charmSynced({ name: "Gots Charm", syncedAt: now - 5 * 60_000 }, now),
    "Synced 5 min ago",
  )
})

/**
 * The network block, as the firmware's `docs/PROTOCOL.md` writes it: one control write per ask, the
 * four-byte answers, and the two asks whose answer carries `[extraLen][extra]`. These literals are
 * the document's, not the app's.
 */
const NETWORK_WIRE = {
  version: 1,
  wifi: 0x30,
  forget: 0x31,
  network: 0x32,
  tailnet: 0x33,
  update: 0x34,
  updateStatus: 0x35,
  ssidBytes: 32,
  passBytes: 63,
  urlBytes: 180,
  keyBytes: 96,
  sha256Bytes: 32,
}

const spell = (text) => [...new TextEncoder().encode(text)]
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

test("the network ops are the ones PROTOCOL.md numbers, and the bounds are its own", () => {
  assert.equal(CharmOp.Wifi, NETWORK_WIRE.wifi)
  assert.equal(CharmOp.Forget, NETWORK_WIRE.forget)
  assert.equal(CharmOp.Network, NETWORK_WIRE.network)
  assert.equal(CharmOp.Tailnet, NETWORK_WIRE.tailnet)
  assert.equal(CharmOp.Update, NETWORK_WIRE.update)
  assert.equal(CharmOp.UpdateStatus, NETWORK_WIRE.updateStatus)
  assert.equal(CHARM_MAX_SSID_BYTES, NETWORK_WIRE.ssidBytes)
  assert.equal(CHARM_MAX_PASS_BYTES, NETWORK_WIRE.passBytes)
  assert.equal(CHARM_MAX_URL_BYTES, NETWORK_WIRE.urlBytes)
  assert.equal(CHARM_MAX_KEY_BYTES, NETWORK_WIRE.keyBytes)
  assert.equal(CHARM_SHA256_BYTES, NETWORK_WIRE.sha256Bytes)
  // The three that carry nothing: the version, the op, and the charm's answer to come.
  assert.deepEqual([...forgetMessage()], [NETWORK_WIRE.version, NETWORK_WIRE.forget])
  assert.deepEqual([...networkMessage()], [NETWORK_WIRE.version, NETWORK_WIRE.network])
  assert.deepEqual([...updateStatusMessage()], [NETWORK_WIRE.version, NETWORK_WIRE.updateStatus])
})

test("a Wi-Fi write carries the name and the passphrase as UTF-8", () => {
  const ssid = "Café ☕"
  const name = spell(ssid)
  assert.deepEqual(
    [...wifiMessage(ssid, "hunter2")],
    [1, NETWORK_WIRE.wifi, name.length, ...name, 7, ...spell("hunter2")],
  )
  // An open network is a passphrase of no bytes, not a field left out: the charm reads the zero.
  assert.deepEqual([...wifiMessage("Home", "")], [1, NETWORK_WIRE.wifi, 4, ...spell("Home"), 0])
})

test("a key and an address go over with their own lengths", () => {
  const key = "tskey-auth-abc"
  assert.deepEqual([...tailnetMessage(key)], [1, NETWORK_WIRE.tailnet, key.length, ...spell(key)])
  const url = "https://fw.example/gots.bin"
  const sha = Uint8Array.from({ length: 32 }, (_, at) => (at * 7) & 0xff)
  // The hash is its own 32 bytes, with no length in front of them.
  assert.deepEqual(
    [...updateMessage(url, sha)],
    [1, NETWORK_WIRE.update, url.length, ...spell(url), ...sha],
  )
})

test("a name, a passphrase, a key, an address and a hash are refused before any write", () => {
  assert.throws(() => wifiMessage("x".repeat(33), ""), /at most 32 bytes/)
  assert.throws(() => wifiMessage("", ""), /at least 1 byte/)
  assert.throws(() => wifiMessage("Home", "p".repeat(CHARM_MAX_PASS_BYTES + 1)), /at most 63 bytes/)
  assert.throws(() => tailnetMessage("k".repeat(CHARM_MAX_KEY_BYTES + 1)), /at most 96 bytes/)
  assert.throws(() => tailnetMessage(""), /at least 1 byte/)
  // The charm makes the request itself, so it can only be one it can fetch: https, never http.
  assert.throws(() => updateMessage("http://e.test/fw.bin", new Uint8Array(32)), /https address/)
  assert.throws(() => updateMessage("ftp://e.test/fw.bin", new Uint8Array(32)), /https address/)
  assert.throws(() => updateMessage("https://e.test/fw.bin", new Uint8Array(31)), /32-byte SHA-256/)
  assert.throws(
    () => updateMessage(`https://e.test/${"a".repeat(CHARM_MAX_URL_BYTES)}`, new Uint8Array(32)),
    /at most 180 bytes/,
  )
})

test("a hash reads back from hex in either case, and refuses what is not hex", () => {
  const sha = Uint8Array.from({ length: 32 }, (_, at) => at * 3)
  assert.equal(hexOf(sha).length, 64)
  assert.deepEqual([...hexBytes(hexOf(sha))], [...sha])
  // A paste in capitals, with spaces or colons, is still the hash it was.
  assert.deepEqual([...hexBytes("A0 b1:C2")], [0xa0, 0xb1, 0xc2])
  assert.throws(() => hexBytes("not hex"), /64 hexadecimal characters/)
  assert.throws(() => hexBytes("abc"), /64 hexadecimal characters/, "an odd count is half a byte")
})

/** A `Network` answer as the charm sends one: the head, the extra's length, then the extra. */
function networkAnswer({ state, reason, ip, ssid, tunnel, tunnelIp }) {
  const extra = [
    state,
    reason,
    ip.length,
    ...spell(ip),
    ssid.length,
    ...spell(ssid),
    tunnel,
    tunnelIp.length,
    ...spell(tunnelIp),
  ]
  return new Uint8Array([1, 0, NETWORK_WIRE.network, 0, extra.length, ...extra])
}

test("a Network answer reads the Wi-Fi link and the tunnel", () => {
  const answer = networkAnswer({
    state: CharmLinkState.Online,
    reason: 0,
    ip: "192.168.1.20",
    ssid: "Home",
    tunnel: CharmLinkState.Online,
    tunnelIp: "100.64.0.7",
  })
  assert.deepEqual(parseNetworkReport(viewOf(answer)), {
    wifi: { state: 2, reason: 0, ip: "192.168.1.20", ssid: "Home" },
    tailnet: { state: 2, ip: "100.64.0.7" },
  })
  // A charm with neither link says so with the same shape: zero lengths, not missing fields.
  assert.deepEqual(
    parseNetworkReport(
      viewOf(networkAnswer({ state: 0, reason: 0, ip: "", ssid: "", tunnel: 0, tunnelIp: "" })),
    ),
    { wifi: { state: 0, reason: 0, ip: "", ssid: "" }, tailnet: { state: 0, ip: "" } },
  )
})

test("a truncated or wrong-op answer is no report at all", () => {
  const full = networkAnswer({
    state: 3,
    reason: 3,
    ip: "",
    ssid: "Home",
    tunnel: 1,
    tunnelIp: "",
  })
  // Every cut, however early, is short of the report the charm promised.
  for (let at = 0; at < full.length; at++)
    assert.equal(parseNetworkReport(viewOf(full.subarray(0, at))), null, `cut at ${at}`)
  // An answer that says it carries more than it does is no answer either.
  const lying = new Uint8Array(full)
  lying[4] = full.length
  assert.equal(parseNetworkReport(viewOf(lying)), null)
  // And another op's answer is never read as this one.
  assert.equal(parseNetworkReport(viewOf(updateAnswer({ state: 1, percent: 1, reason: 0 }))), null)
})

/** An `UpdateStatus` answer: the head, the extra's three bytes, and nothing else. */
const updateAnswer = ({ state, percent, reason }) =>
  new Uint8Array([1, 0, NETWORK_WIRE.updateStatus, 0, 3, state, percent, reason])

test("an UpdateStatus answer reads the state, the percent and the reason", () => {
  assert.deepEqual(parseUpdateStatus(viewOf(updateAnswer({ state: 1, percent: 42, reason: 0 }))), {
    state: 1,
    percent: 42,
    reason: 0,
  })
  assert.deepEqual(parseUpdateStatus(viewOf(updateAnswer({ state: 3, percent: 0, reason: 3 }))), {
    state: 3,
    percent: 0,
    reason: 3,
  })
  const full = updateAnswer({ state: 2, percent: 100, reason: 0 })
  for (let at = 0; at < full.length; at++)
    assert.equal(parseUpdateStatus(viewOf(full.subarray(0, at))), null, `cut at ${at}`)
  // An extra that is shorter than the three bytes the answer is made of is no answer.
  assert.equal(
    parseUpdateStatus(viewOf(new Uint8Array([1, 0, NETWORK_WIRE.updateStatus, 0, 2, 1, 2]))),
    null,
  )
  assert.equal(
    parseUpdateStatus(
      viewOf(networkAnswer({ state: 2, reason: 0, ip: "", ssid: "", tunnel: 0, tunnelIp: "" })),
    ),
    null,
  )
})

test("the network lines are the charm's own state in words", async () => {
  const { tailnetWords, updateWords, wifiReasonWords, wifiWords } =
    await import("../src/lib/charm-words.ts")
  assert.equal(wifiWords(undefined), "Not set")
  assert.equal(wifiWords({ state: CharmLinkState.Off, reason: 0, ip: "", ssid: "" }), "Not set")
  assert.equal(wifiWords({ state: 1, reason: 0, ip: "", ssid: "Home" }), "Joining…")
  assert.equal(
    wifiWords({ state: 2, reason: 0, ip: "10.0.0.2", ssid: "Home" }),
    "Connected to Home",
  )
  assert.equal(wifiWords({ state: 2, reason: 0, ip: "10.0.0.2", ssid: "" }), "Connected")
  assert.equal(wifiWords({ state: 3, reason: 3, ip: "", ssid: "Home" }), "Wrong passphrase")
  assert.equal(wifiWords({ state: 3, reason: 2, ip: "", ssid: "Home" }), "Not in range")
  assert.equal(wifiReasonWords(4), "No address from the network")
  assert.equal(wifiReasonWords(5), "Dropped off the network")
  // Before the charm answers, the line is what this phone last told it.
  assert.equal(wifiWords(undefined, { ssid: "Home", saved: true }), "Saved Home")
  assert.equal(
    wifiWords(undefined, { ssid: "Home", saved: false }),
    "Home, kept for this boot only",
  )

  assert.equal(tailnetWords(undefined), "Not set")
  assert.equal(tailnetWords({ state: 2, ip: "" }), "On your tailnet")
  assert.equal(tailnetWords({ state: 2, ip: "100.64.0.7" }), "On your tailnet at 100.64.0.7")
  assert.equal(tailnetWords({ state: 3, ip: "" }), "Couldn't reach the tailnet")
  assert.equal(tailnetWords(undefined, true), "Key saved; not joined")

  assert.equal(updateWords(null), "No update running")
  assert.equal(
    updateWords({ state: CharmUpdateState.Downloading, percent: 42, reason: 0 }),
    "Downloading… 42%",
  )
  assert.equal(updateWords({ state: 2, percent: 100, reason: 0 }), "Ready: the charm is restarting")
  assert.equal(
    updateWords({ state: 3, percent: 0, reason: 3 }),
    "Update failed: the image didn't match its SHA-256",
  )
})

test("the new codes say what they mean", () => {
  assert.equal(
    codeWords(CharmCode.SavedToRam),
    "This charm's flash isn't encrypted, so it will forget this at the next boot",
  )
  assert.match(codeWords(CharmCode.Offline), /isn't on Wi-Fi/)
  assert.match(codeWords(CharmCode.Busy), /busy/)
})

test("the record a Wi-Fi write leaves is the name and whether the charm keeps it", () => {
  assert.deepEqual(wifiRecord("Home", CharmCode.Ok), { ssid: "Home", saved: true })
  // Kept in RAM is a yes the charm forgets, so the record says it is not saved.
  assert.deepEqual(wifiRecord("Home", CharmCode.SavedToRam), { ssid: "Home", saved: false })
  assert.deepEqual(Object.keys(wifiRecord("Home", CharmCode.Ok)).sort(), ["saved", "ssid"])
})
test("the glass's messages are laid out as the firmware reads them", () => {
  assert.deepEqual([...wakeMessage({ doubleTap: true, quietSeconds: 60 })], [1, 0x0c, 1, 60])
  assert.deepEqual([...wakeMessage({ doubleTap: false, quietSeconds: 15 })], [1, 0x0c, 0, 15])
  // A window the charm does not run is refused here, before it reaches the radio.
  assert.throws(() => wakeMessage({ doubleTap: true, quietSeconds: 20 }))
  assert.deepEqual([...batteryMessage()], [1, 0x0d])
})

test("the battery answer is a level and a charger, and an unread one is unknown", () => {
  const bytes = (list) => new DataView(new Uint8Array(list).buffer)
  // Two bytes of extra behind a length, as the network's report is: the level, then the charger.
  assert.deepEqual(parseBattery(bytes([1, 0, 0x0d, 0, 2, 85, 1])), { percent: 85, charging: true })
  assert.deepEqual(parseBattery(bytes([1, 0, 0x0d, 0, 2, 85, 0])), { percent: 85, charging: false })
  // A four-byte answer is a charm that never heard the op; -1 is a charm that could not read itself,
  // which is unknown rather than empty and is kept so the row can say so.
  assert.equal(parseBattery(bytes([1, 0, 0x0d, 0])), null)
  assert.equal(parseBattery(bytes([1, 0, 0x0d, 0, 3, 85, 1, 0])), null)
  assert.equal(parseBattery(bytes([1, 0, 0x20, 0, 2, 85, 1])), null)
  assert.deepEqual(parseBattery(bytes([1, 0, 0x0d, 0, 2, 0xff, 0])), { percent: -1, charging: false })
})

test("an old charm's refusal is said in words a reader can act on", () => {
  // A charm whose firmware predates the op answers BadMessage to every op it never heard of.
  assert.match(refusalWords(CharmCode.BadMessage), /older than the app/)
})

test("the battery ask is one op with no payload", () => {
  assert.deepEqual([...batteryMessage()], [1, 0x0d])
})

test("a stored choice the charm could not have is put back to the defaults", () => {
  assert.deepEqual(charmWakeOf(undefined), { doubleTap: true, quietSeconds: 15 })
  assert.deepEqual(charmWakeOf({ doubleTap: false, quietSeconds: 60 }), {
    doubleTap: false,
    quietSeconds: 60,
  })
  // A window outside the three, or a field that is not a boolean, is no choice at all.
  assert.deepEqual(charmWakeOf({ quietSeconds: 20 }), { doubleTap: true, quietSeconds: 15 })
  assert.deepEqual(charmWakeOf({ doubleTap: false, quietSeconds: "60" }), {
    doubleTap: false,
    quietSeconds: 15,
  })
})

test("the battery row's words keep unknown apart from empty, and show the reading's age", () => {
  const now = 1_800_000_000_000
  assert.equal(batteryWords(undefined, now), "Not read yet")
  assert.equal(batteryWords({ percent: -1, charging: false, at: now }, now), "Unknown")
  assert.equal(batteryWords({ percent: 0, charging: false, at: now }, now), "0% · just now")
  assert.equal(
    batteryWords({ percent: 82, charging: true, at: now - 5 * 60_000 }, now),
    "82% · Charging · 5 min ago",
  )
})
