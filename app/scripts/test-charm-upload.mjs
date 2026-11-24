/**
 * A firmware image on its way to the Gots Charm, against a charm faked in memory: the bytes match
 * the firmware's spec (docs/PROTOCOL.md in hermesgots-charm), the three ops go over in order, the
 * chunks cover the image exactly, and a refusal is said with the reason the charm gave.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  CHARM_SHA256_BYTES,
  CharmCode,
  CharmOp,
  CharmUpdateReason,
  CharmUpdateState,
  busyFill,
  chunkSize,
  firmwareMessage,
  imageChunks,
  parseFirmware,
  parseStatus,
  updateBeginMessage,
  updateEndMessage,
} from "../src/lib/charm-protocol.ts"
import { FirmwareRefused, uploadFirmware, versionAfterReboot } from "../src/lib/charm-firmware.ts"

/**
 * The network block's last three ops, as the firmware's `docs/PROTOCOL.md` numbers them. These
 * literals are the document's, not the app's.
 */
const UPDATE_WIRE = {
  version: 1,
  firmware: 0x36,
  begin: 0x37,
  end: 0x38,
  status: 0x35,
  sha256Bytes: 32,
}

const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
const spell = (text) => [...new TextEncoder().encode(text)]
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const sha256Of = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest())
const image = (n, seed = 3) => new Uint8Array(n).map((_, i) => (i * 13 + seed) & 0xff)

/** The fake charm below has no clock of its own, so the upload's paced gap waits nothing. */
const NO_PACE = { pace: async () => {} }

test("the firmware ops are the ones PROTOCOL.md numbers", () => {
  assert.equal(CharmOp.Firmware, UPDATE_WIRE.firmware)
  assert.equal(CharmOp.UpdateBegin, UPDATE_WIRE.begin)
  assert.equal(CharmOp.UpdateEnd, UPDATE_WIRE.end)
  assert.equal(CHARM_SHA256_BYTES, UPDATE_WIRE.sha256Bytes)
  // The two that carry nothing: the version, the op, and the charm's answer to come.
  assert.deepEqual([...firmwareMessage()], [UPDATE_WIRE.version, UPDATE_WIRE.firmware])
  assert.deepEqual([...updateEndMessage()], [UPDATE_WIRE.version, UPDATE_WIRE.end])
  // The third: the image's length, then its hash as its own 32 bytes with no length in front.
  const sha = Uint8Array.from({ length: 32 }, (_, at) => at + 1)
  assert.deepEqual(
    [...updateBeginMessage(700 * 1024, sha)],
    [UPDATE_WIRE.version, UPDATE_WIRE.begin, ...u32(700 * 1024), ...sha],
  )
  // A hash that is not the image's 32 bytes never reaches the radio.
  assert.throws(() => updateBeginMessage(10, new Uint8Array(31)), /32-byte SHA-256/)
})

test("a Firmware answer reads the version, and a charm too old to know it says none", () => {
  const answer = (version) =>
    new Uint8Array([1, 0, UPDATE_WIRE.firmware, 0, version.length, ...spell(version)])
  assert.equal(parseFirmware(viewOf(answer("0.1.0"))), "0.1.0")
  assert.equal(parseFirmware(viewOf(answer("0.2.10"))), "0.2.10")
  // A charm from before the op answers the four cheap bytes of BadMessage, with no extra at all.
  assert.equal(
    parseFirmware(viewOf(new Uint8Array([1, CharmCode.BadMessage, UPDATE_WIRE.firmware, 0]))),
    null,
  )
  // Every cut of a real answer is short of the version it promised.
  const full = answer("0.2.0")
  for (let at = 0; at < full.length; at++)
    assert.equal(parseFirmware(viewOf(full.subarray(0, at))), null, `cut at ${at}`)
  // An extra that says it is longer than it is, and one of no bytes, are no version either.
  assert.equal(
    parseFirmware(viewOf(new Uint8Array([1, 0, UPDATE_WIRE.firmware, 0, 9, ...spell("0.1")]))),
    null,
  )
  assert.equal(parseFirmware(viewOf(new Uint8Array([1, 0, UPDATE_WIRE.firmware, 0, 0]))), null)
  // And another op's answer is never read as this one.
  assert.equal(
    parseFirmware(viewOf(new Uint8Array([1, 0, UPDATE_WIRE.status, 0, 3, 1, 10, 0]))),
    null,
  )
})

test("a Busy notice's extra names the fill, and a charm from before the fix names none", () => {
  const notice = (fill) => new Uint8Array([1, CharmCode.Busy, 0, 0, 4, ...u32(fill)])
  // The fixed charm: the offset its updater waits at, four little-endian bytes of extra.
  assert.equal(busyFill(viewOf(notice(4096))), 4096)
  assert.equal(busyFill(viewOf(notice(0xdeadbeef))), 0xdeadbeef)
  // Every charm before the fix: the four bytes alone, which name no position to resume from.
  assert.equal(busyFill(viewOf(new Uint8Array([1, CharmCode.Busy, 0, 0]))), null)
  // An extra that is not the fill's four bytes is no fill to read.
  assert.equal(busyFill(viewOf(new Uint8Array([1, CharmCode.Busy, 0, 0, 2, 1, 2]))), null)
  // And every cut of a real notice is short of the fill it promised.
  const full = notice(4096)
  for (let at = 0; at < full.length; at++)
    assert.equal(busyFill(viewOf(full.subarray(0, at))), null, `cut at ${at}`)
})

/**
 * A charm in memory, following the firmware's upload session: the begin announces an image, the
 * data writes carry it at their offsets, a status ask answers how much has arrived, and the end
 * checks the length and the hash it was told.
 */
function fakeCharm({ version = "0.2.0", busy = false, failAt = null, strayOnce = false, refuseAt = null } = {}) {
  const ops = []
  const writes = []
  const attempts = []
  const asked = []
  let session = null
  let received = []
  let gap = false
  let strayed = false
  let failure = null
  let latched = null // the Busy notice's stand-in: the link's latch, held until the upload reads it
  let refusedOnce = false
  const answer = (code, op) => new Uint8Array([1, code, op, 0])
  // The asks whose answer carries extra put its length in front of it; a plain answer is the four.
  const carrying = (code, op, extra) => new Uint8Array([1, code, op, 0, extra.length, ...extra])
  const percent = () =>
    session?.size ? Math.min(100, Math.floor((received.length / session.size) * 100)) : 0
  return {
    ops,
    writes,
    attempts,
    asked,
    get received() {
      return received
    },
    link: {
      mtu: 185,
      // The charm's refusal of a data write, as the link latches it: this charm's notice names
      // no fill, so the chunk just written is the one that goes again.
      refusal() {
        const was = latched
        latched = null
        return was
      },
      // As `charm.ts`'s link answers: the bytes the charm sent, as a view.
      async ask(m) {
        return viewOf(await this.reply(m))
      },
      async control(m) {
        return parseStatus(await this.ask(m))
      },
      async reply(m) {
        const op = m[1]
        ops.push(op)
        if (op === UPDATE_WIRE.firmware) return carrying(0, op, spell(version))
        if (op === UPDATE_WIRE.begin) {
          if (busy) return answer(CharmCode.Busy, op)
          session = { size: viewOf(m).getUint32(2, true), sha: [...m.subarray(6)] }
          received = []
          return answer(0, op)
        }
        if (op === UPDATE_WIRE.status) {
          // A data write refused for buffer room notifies a code of its own, with no extra, and
          // that notification can answer this ask: one ask comes back as it does.
          if (strayOnce && !strayed) {
            strayed = true
            return answer(CharmCode.Busy, 0)
          }
          if (failure !== null)
            return carrying(0, op, [CharmUpdateState.Failed, percent(), failure])
          asked.push(percent())
          return carrying(0, op, [CharmUpdateState.Downloading, percent(), 0])
        }
        if (op === UPDATE_WIRE.end) {
          if (!session) return answer(CharmCode.NoSession, op)
          if (gap) return answer(CharmCode.BadOffset, op)
          const whole = received.length === session.size
          const same = [...sha256Of(Uint8Array.from(received))].join() === session.sha.join()
          if (!whole || !same) {
            failure = CharmUpdateReason.BadHash
            return answer(CharmCode.BadImage, op)
          }
          session = null
          return answer(0, op)
        }
        return answer(CharmCode.BadMessage, op)
      },
      async data(chunk) {
        attempts.push(chunk)
        const offset = viewOf(chunk).getUint32(0, true)
        // A buffer with no room refuses the write on the status characteristic, and takes the same
        // chunk when it comes again: nothing is lost and the offset stays the next one.
        if (refuseAt !== null && offset === refuseAt && !refusedOnce) {
          refusedOnce = true
          latched = { fill: null }
          return
        }
        writes.push(chunk)
        // A write that is not the next one is a gap, which ends the attempt at the end.
        if (!session || offset !== received.length) {
          gap = true
          return
        }
        received.push(...chunk.subarray(4))
        if (failAt !== null && received.length >= failAt) failure = CharmUpdateReason.WriteFailed
      },
    },
  }
}

test("an image goes over as offset-prefixed chunks, in order, then the end", async () => {
  const charm = fakeCharm()
  const bytes = image(4000)
  const sha = sha256Of(bytes)
  const result = await uploadFirmware(charm.link, bytes, sha, undefined, NO_PACE)

  assert.equal(charm.ops[0], UPDATE_WIRE.begin, "the size and the hash are announced first")
  assert.equal(charm.ops.at(-1), UPDATE_WIRE.end)
  const size = chunkSize(charm.link.mtu)
  const joined = []
  for (const chunk of charm.writes) {
    assert.ok(chunk.length <= size, "no write outgrows the link")
    assert.equal(viewOf(chunk).getUint32(0, true), joined.length, "each write names its own offset")
    joined.push(...chunk.subarray(4))
  }
  assert.deepEqual(joined, [...bytes], "each byte of the image goes exactly once, in order")
  assert.equal(charm.writes.length, Math.ceil(bytes.length / (size - 4)))
  assert.deepEqual(result, { sent: bytes.length, total: bytes.length, percent: 100 })
})

test("progress rises, and only the charm's own count is a percentage", async () => {
  const charm = fakeCharm()
  const bytes = image(200 * 1024)
  const seen = []
  await uploadFirmware(charm.link, bytes, sha256Of(bytes), (progress) => seen.push(progress), NO_PACE)

  // Every report says how much the phone has written, and that count never runs back.
  const sent = seen.map((progress) => progress.sent)
  assert.deepEqual(
    sent,
    [...sent].sort((a, b) => a - b),
  )
  assert.equal(sent.at(-1), bytes.length)
  // One report per whole percent, plus the end's own: the row is not redrawn thousands of times.
  assert.ok(seen.length <= 102, `one report per percent (${seen.length} for 200 KB)`)
  // Nothing is known as a percentage before the charm answers, so nothing is said as one; after
  // that it never falls.
  assert.equal(seen[0].percent, undefined, "no percentage until the charm's own count arrives")
  const percents = seen.map((progress) => progress.percent).filter((percent) => percent !== undefined)
  assert.deepEqual(
    percents,
    [...percents].sort((a, b) => a - b),
  )
  assert.ok(
    percents.some((percent) => percent > 0 && percent < 100),
    "it moves as bytes land",
  )
  assert.equal(percents.at(-1), 100)
  assert.ok(charm.asked.length >= 3, "the charm was asked where it had got to as the image went")
})

test("a status ask answered by a refused data write is no progress, and no reason to stop", async () => {
  const charm = fakeCharm({ strayOnce: true })
  const bytes = image(200 * 1024)
  const seen = []
  const result = await uploadFirmware(charm.link, bytes, sha256Of(bytes), (progress) =>
    seen.push(progress), NO_PACE,
  )
  assert.equal(result.percent, 100)
  assert.equal(charm.ops.filter((op) => op === UPDATE_WIRE.end).length, 1)
  // The stray answer carried no percentage, so none was drawn from it; the next ask still was.
  assert.ok(charm.asked.length >= 2)
  assert.equal(seen.at(-1).percent, 100)
})

test("a charm already updating refuses the begin, and nothing is written", async () => {
  const charm = fakeCharm({ busy: true })
  const bytes = image(1000)
  await assert.rejects(
    () => uploadFirmware(charm.link, bytes, sha256Of(bytes), undefined, NO_PACE),
    (error) => error instanceof FirmwareRefused && error.code === CharmCode.Busy,
  )
  assert.equal(charm.writes.length, 0)
  assert.deepEqual(charm.ops, [UPDATE_WIRE.begin])
})

test("an image the charm refuses at the end throws the reason it gave", async () => {
  const charm = fakeCharm()
  const bytes = image(3000)
  // A hash that is not this image's: the charm checks the bytes it got against the one announced.
  const wrong = sha256Of(image(3000, 4))
  await assert.rejects(
    () => uploadFirmware(charm.link, bytes, wrong, undefined, NO_PACE),
    (error) =>
      error instanceof FirmwareRefused &&
      error.reason === CharmUpdateReason.BadHash &&
      /SHA-256/.test(error.message),
  )
  // The end's refusal is read for its reason, which is what the row can draw.
  assert.equal(charm.ops.at(-1), UPDATE_WIRE.status)
})

test("a status that says failed stops the upload before its end", async () => {
  const charm = fakeCharm({ failAt: 2 * 64 * 1024 })
  const bytes = image(200 * 1024)
  await assert.rejects(
    () => uploadFirmware(charm.link, bytes, sha256Of(bytes), undefined, NO_PACE),
    (error) => error instanceof FirmwareRefused && error.reason === CharmUpdateReason.WriteFailed,
  )
  assert.ok(!charm.ops.includes(UPDATE_WIRE.end), "a failed attempt is not ended")
})

test("a link at the smallest MTU still carries its offset and a byte of image", () => {
  const size = chunkSize(23)
  assert.ok(size <= 23 - 3, "the write fits the ATT payload")
  assert.ok(size - 4 >= 1, "the four-byte offset leaves room for image bytes")
})

test("chunks are made as they are sent, not all at once", () => {
  const chunks = imageChunks(image(1_000_000), 512)
  // A megabyte held as thousands of chunks is a second copy of the image in memory.
  assert.equal(typeof chunks.next, "function", "an iterator rather than an array of every chunk")
  assert.ok(chunks.next().value.length > 0)
})

test("a chunk the charm refuses for room goes again, and the image completes", async () => {
  const size = chunkSize(185)
  const refusedAt = 2 * (size - 4)
  // The third chunk meets a full buffer once: the charm says `Busy`, and takes it on the resend.
  const charm = fakeCharm({ refuseAt: refusedAt })
  const bytes = image(4000)
  const result = await uploadFirmware(charm.link, bytes, sha256Of(bytes), undefined, NO_PACE)

  assert.equal(result.percent, 100)
  assert.deepEqual([...charm.received], [...bytes], "every byte landed once, in order")
  const offsets = charm.attempts.map((chunk) => viewOf(chunk).getUint32(0, true))
  assert.deepEqual(
    offsets.slice(2, 4),
    [refusedAt, refusedAt],
    "the refused chunk went again before the next offset",
  )
  assert.equal(charm.ops.filter((op) => op === UPDATE_WIRE.end).length, 1)
})

test("the version read answers whether the rebooted charm changed", async () => {
  // A charm out of reach over its restart: the first two asks fail, the third is the new build.
  let asked = 0
  const changed = await versionAfterReboot(
    async () => {
      asked += 1
      if (asked < 3) throw new Error("The charm went out of reach")
      return "0.2.0"
    },
    "0.1.0",
    { tries: 3, waitMs: 0 },
  )
  assert.deepEqual(changed, { changed: true, version: "0.2.0", answered: "0.2.0" })

  // Every ask says the build it started on: the row has to be able to say it did not change.
  const same = await versionAfterReboot(async () => "0.1.0", "0.1.0", { tries: 2, waitMs: 0 })
  assert.deepEqual(same, { changed: false, version: "0.1.0", answered: "0.1.0" })

  // A charm that never answered at all: unchanged, and `answered` says so by saying nothing —
  // an unchanged version and a version nobody read are different ends, and the walk's gates
  // read the difference.
  const gone = await versionAfterReboot(
    async () => {
      throw new Error("The charm went out of reach")
    },
    "0.1.0",
    { tries: 2, waitMs: 0 },
  )
  assert.deepEqual(gone, { changed: false, version: "0.1.0", answered: undefined })
})
