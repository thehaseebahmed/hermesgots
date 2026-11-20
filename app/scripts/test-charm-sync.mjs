/**
 * The Gots Charm sync, phone side, against a charm faked in memory: the bytes match the firmware's
 * spec (docs/PROTOCOL.md in hermesgots-charm), only missing pictures go over the air, a damaged one
 * is sent again, and a refusal leaves the charm's list as it was.
 */
import assert from "node:assert/strict"
import test from "node:test"

import {
  CharmCode,
  beginMessage,
  botMessage,
  charmMood,
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

test("messages are laid out as the firmware reads them", () => {
  assert.deepEqual([...beginMessage(3)], [1, 1, 3])
  const image = new Uint8Array([1, 2, 3])
  const m = botMessage(2, { id: "ab", name: "N", accent: 0x1234, image })
  const crc = crc32(image)
  assert.deepEqual(
    [...m],
    [
      1,
      2,
      2,
      0x34,
      0x12,
      3,
      0,
      0,
      0,
      crc & 0xff,
      (crc >>> 8) & 0xff,
      (crc >>> 16) & 0xff,
      crc >>> 24,
      2,
      0x61,
      0x62,
      1,
      0x4e,
    ],
  )
})

const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]

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
function fakeCharm({ corruptOnce = false, refuseCommit = false, corruptPoseOnce = false } = {}) {
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
          const idLen = m[13]
          const id = new TextDecoder().decode(m.subarray(14, 14 + idLen))
          const name = new TextDecoder().decode(m.subarray(15 + idLen, 15 + idLen + m[14 + idLen]))
          pending[index] = { id, name, len, crc }
          return answer(0, op, len > 0 && held.get(crc) !== len)
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
          if (bytes.length !== bot.len || crc32(bytes) !== bot.crc) return answer(7, op, true)
          held.set(bot.crc, bot.len)
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
    { id: "nova", name: "Nova", accent: 1, image: picture(1) },
    { id: "pixel", name: "Pixel", accent: 2, image: picture(2) },
    { id: "plain", name: "Plain", accent: 3, image: new Uint8Array() },
  ]
  const seen = []
  const first = await syncCharm(charm.link, bots, (p) => seen.push(p.done))
  assert.deepEqual(first, { done: 3, total: 3, sent: 2 })
  assert.deepEqual(seen, [0, 1, 2, 3])
  assert.deepEqual(
    charm.shown.map((b) => b.name),
    ["Nova", "Pixel", "Plain"],
  )

  const renamed = [{ ...bots[1], name: "Pix" }, bots[0], { ...bots[2], image: picture(9) }]
  const second = await syncCharm(charm.link, renamed)
  assert.equal(second.sent, 1)
  assert.deepEqual(charm.imagesSent, ["nova", "pixel", "plain"])
  assert.deepEqual(
    charm.shown.map((b) => b.name),
    ["Pix", "Nova", "Plain"],
  )
})

const nova = { id: "nova", name: "Nova", accent: 1, image: picture(1) }
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
    { id: "nova", name: "Nova", accent: 1, image: picture(1) },
  ])
  assert.equal(result.sent, 1)
  assert.equal(charm.shown.length, 1)
})

test("a refusal throws in words and leaves the charm's list alone", async () => {
  const charm = fakeCharm({ refuseCommit: true })
  await assert.rejects(
    syncCharm(charm.link, [{ id: "nova", name: "Nova", accent: 1, image: picture(1) }]),
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
  }))
  await assert.rejects(syncCharm(charm.link, many), /at most 32/)
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
