/**
 * The Gots Charm sync, phone side, against a charm faked in memory: the bytes match the firmware's
 * spec (docs/PROTOCOL.md in hermesgots-charm), only missing pictures go over the air, a damaged one
 * is sent again, and a refusal leaves the charm's list as it was.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  CHARM_MAX_IMAGE_BYTES,
  CharmCode,
  beginMessage,
  botMessage,
  charmMood,
  checkBots,
  chunkSize,
  crc32,
  imageChunks,
  parseStatus,
  petSettingsFrom,
  petSettingsMessage,
  poseImageEndMessage,
  poseImageMessage,
  poseMessage,
  rgb565,
  timeMessage,
  utf8Clip,
} from "../src/lib/charm-protocol.ts"
import { CharmRefused, syncCharm } from "../src/lib/charm-sync.ts"

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
} = {}) {
  const held = new Map() // crc -> len
  let shown = []
  let pending = []
  let image = []
  let corrupted = !corruptOnce
  const imagesSent = []
  const pet = { enabled: false, petBotId: "", bedStart: 0, bedEnd: 0, utcOffsetMin: 0, clock: 0 }
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
