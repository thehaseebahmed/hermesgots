/**
 * A firmware upload over a link that tells the truth about BLE timing: a refused data write is
 * announced on the status characteristic, and that notice is on the wire while the phone is
 * already writing its next chunk — `writeWithoutResponse` carries no answer, and a notification
 * is at least a connection event behind the write it answers.
 *
 * Nothing here waits out real time. The charm runs on a clock the rig turns: every data write
 * and every gap the phone paces advance it, the charm's drain is a pass every `passEvery` ms
 * that empties the upload buffer in one go (as `Updater::drain` does — a loop pass with a flash
 * write), and a refusal's notice takes `noticeEvery` ms to land. Two charms, one rig: today's
 * (`src/update.cpp` in hermesgots-charm) ends the attempt over a chunk at any offset but its
 * own — checked before room — and its notice names no position to resume from; the fixed charm
 * (the plan's step 2) answers a chunk in order but ahead of its fill with the same Busy and
 * names the fill in the notice, one notice on the wire at a time, so a flood cannot drown the
 * notice queue and the next refusal after one lands raises the next.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { CharmCode, CharmUpdateReason, CharmUpdateState } from "../src/lib/charm-protocol.ts"
import { PACE_MS, uploadFirmware } from "../src/lib/charm-firmware.ts"

const UPDATE_WIRE = { begin: 0x37, end: 0x38, status: 0x35 }
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const sha256Of = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest())
const image = (n, seed = 3) => new Uint8Array(n).map((_, i) => (i * 13 + seed) & 0xff)
const answer = (code, op) => new Uint8Array([1, code, op, 0])
const carrying = (code, op, extra) => new Uint8Array([1, code, op, 0, extra.length, ...extra])

/** The airtime of one data write: a write the phone does not pace is the next one a moment later. */
const WRITE_MS = 1

/**
 * A charm with a 4 KB upload buffer the way the firmware has it (`kUploadBuffer`), on the
 * rig's clock. `fill` picks the wire it speaks: true for the fixed charm, whose Busy notice
 * carries the offset its updater waits at — `[1][13][0][0][4][fill u32 LE]` — and whose answer
 * to a chunk in order but ahead of that is another Busy; false for today's, whose notice is
 * the four bytes `[1][13][0][0]` and whose answer to any chunk past its fill ends the attempt.
 */
function timedCharm({ fill, buffer = 4096, passEvery, noticeEvery }) {
  let now = 0 // the rig's clock, turned by every write, ask and paced gap
  let nextPass = passEvery
  let notice = null // one Busy notice on the wire, not yet landed
  let latched = null // the landed notice the phone has not read: the link's latch, faked
  let size = 0
  let accepted = 0 // `Updater::accepted_`: the offset every write must name
  let held = 0 // `Updater::held_`: bytes in the buffer no pass has drained yet
  let reason = null // the charm's own report once an attempt has ended
  let refusals = 0
  let expectedSha = []
  const received = []
  const tick = (ms) => {
    now += ms
    while (now >= nextPass) {
      held = 0 // one loop pass drains the whole buffer to flash
      nextPass += passEvery
    }
    if (notice && now >= notice.due) {
      latched = notice
      notice = null
    }
  }
  const refuse = () => {
    refusals += 1
    if (!notice) notice = { fill: fill ? accepted : null, due: now + noticeEvery }
  }
  return {
    link: {
      mtu: 517,
      refusal() {
        const was = latched
        latched = null
        return was
      },
      async ask(m) {
        return viewOf(await this.reply(m))
      },
      async control(m) {
        return viewOf(await this.reply(m))
      },
      async reply(m) {
        tick(WRITE_MS) // a control write goes over the air, and the charm's loop runs beside it
        const op = m[1]
        if (op === UPDATE_WIRE.begin) {
          if (reason !== null) return answer(CharmCode.Busy, op)
          size = viewOf(m).getUint32(2, true)
          expectedSha = [...m.subarray(6)]
          accepted = 0
          held = 0
          received.length = 0
          return answer(CharmCode.Ok, op)
        }
        if (op === UPDATE_WIRE.status) {
          const state = reason !== null ? CharmUpdateState.Failed : CharmUpdateState.Downloading
          const percent = size ? Math.min(100, Math.floor((received.length / size) * 100)) : 0
          return carrying(CharmCode.Ok, op, [state, percent, reason ?? CharmUpdateReason.None])
        }
        if (op === UPDATE_WIRE.end) {
          if (reason !== null) return answer(CharmCode.NoSession, op)
          const whole = accepted === size
          const same = whole && [...sha256Of(Uint8Array.from(received))].join() === expectedSha.join()
          if (!whole || !same) {
            reason = whole ? CharmUpdateReason.BadHash : CharmUpdateReason.Cancelled
            return answer(CharmCode.BadImage, op)
          }
          return answer(CharmCode.Ok, op)
        }
        return answer(CharmCode.BadMessage, op)
      },
      async data(chunk) {
        tick(WRITE_MS)
        if (reason !== null) return // a dead attempt answers nothing, as WRITE_NR does
        const offset = viewOf(chunk).getUint32(0, true)
        const n = chunk.length - 4
        // `Updater::data`, in its own order: a resend of bytes already taken is fine, a chunk
        // past the end of the image ends the attempt, and then the fill's own rule — today's
        // charm ends the attempt over any other offset, before room is even asked about,
        // while the fixed one refuses it Busy: the phone running past the drain is flow
        // control, not corruption.
        if (offset < accepted && offset + n <= accepted) return
        if (offset + n > size) {
          reason = CharmUpdateReason.Cancelled
          return
        }
        if (offset !== accepted) {
          if (fill) refuse()
          else reason = CharmUpdateReason.Cancelled
          return
        }
        if (held + n > buffer) {
          refuse()
          return
        }
        held += n
        accepted += n
        received.push(...chunk.subarray(4))
      },
    },
    // The phone's own gap, as the upload runs it — but turning the rig's clock, not sleeping.
    pace: async () => {
      tick(PACE_MS)
    },
    get received() {
      return received
    },
    get reason() {
      return reason
    },
    get refusals() {
      return refusals
    },
  }
}

test("an upload whose Busy notices land a write late still completes", async () => {
  // The fixed charm: a pass a second is a drain the paced phone outruns, and the notice takes
  // a tenth of a second to land — two writes behind the refusal it answers.
  const charm = timedCharm({ fill: true, passEvery: 1_000, noticeEvery: 100 })
  // Two buffers' worth and then some: the race lives in every pass the phone outwrites.
  const bytes = image(20 * 1024)
  const sha = sha256Of(bytes)

  const result = await uploadFirmware(charm.link, bytes, sha, undefined, { pace: charm.pace })
  assert.equal(result.percent, 100)
  assert.deepEqual([...charm.received], [...bytes])
  assert.equal(charm.reason, null)
  assert.ok(charm.refusals > 0, "the phone really did outrun the drain")
})

test("a paced upload against a charm that names no fill still completes", async () => {
  // Today's charm: no offset in the notice, and a chunk past the fill ends the attempt. The
  // pace is the whole defence — a gap longer than the notice's own latency, so a refusal's
  // notice lands before the write that follows the refused one, and the chunk it is about is
  // the chunk just written.
  const charm = timedCharm({ fill: false, passEvery: 1_000, noticeEvery: 30 })
  const bytes = image(20 * 1024)
  const sha = sha256Of(bytes)

  const result = await uploadFirmware(charm.link, bytes, sha, undefined, { pace: charm.pace })
  assert.equal(result.percent, 100)
  assert.deepEqual([...charm.received], [...bytes])
  assert.equal(charm.reason, null, "no write ever named an offset the charm had not taken")
  assert.ok(charm.refusals > 0, "the drain really did fall behind")
})
