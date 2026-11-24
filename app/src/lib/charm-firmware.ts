/**
 * An image the phone sends over the link it already holds: the SHA-256 the phone computes is the
 * whole trust anchor, so a wrong or truncated image is refused whatever served it.
 *
 * Pure over a transport, so a test drives a charm in memory with no radio.
 */
import {
  CharmCode,
  CharmUpdateReason,
  CharmUpdateState,
  chunkAt,
  chunkSize,
  parseStatus,
  parseUpdateStatus,
  updateBeginMessage,
  updateEndMessage,
  updateStatusMessage,
  type CharmUpdateStatus,
} from "./charm-protocol.ts"
import type { CharmTransport } from "./charm-sync.ts"
import { refusalWords, updateReasonWords, FIRMWARE_NOT_HELD } from "./charm-words.ts"

/** How long the row waits between asks for the rebooted charm's version, and how many asks. */
export const REBOOT_MS = 3_000
export const REBOOT_TRIES = 4

/**
 * A link an image goes over: a sync's transport, plus the answer as the bytes the charm sent. A
 * status ask can be answered by the notification a refused data write raises — the ask has no way
 * to tell — so the upload sees the answer itself rather than a parsed status, and reads a refusal
 * off the link's latch rather than out of an answer.
 */
export interface FirmwareLink extends CharmTransport {
  ask(message: Uint8Array): Promise<DataView>
  /**
   * The charm's refusal of a data write just made, latched from its Busy notice and read once
   * per notice: null while none has landed, and a fill of null when the notice carried none,
   * which is every charm from before the fill rode the notice.
   */
  refusal(): CharmRefusal | null
}

/**
 * The Busy notice's account of a refused data write: where the charm is waiting for the image to
 * resume, when the notice says.
 */
export interface CharmRefusal {
  /**
   * The fill's byte offset as the notice's extra carried it; null for the four-byte notice every
   * charm before the fix sends, which names no position to resume from.
   */
  fill: number | null
}

export interface FirmwareProgress {
  /**
   * The furthest byte the phone has written, and the image's whole length. A re-anchor moves the
   * next write back to the charm's fill; this count never runs back with it — it is a counter the
   * row draws, and the charm's own percent is the true progress.
   */
  sent: number
  total: number
  /** The charm's own count, in whole percent, once a status answer has said one. */
  percent?: number
}

/** An upload the charm refused, or one it started and then failed. */
export class FirmwareRefused extends Error {
  /** The answer's code, or `CharmCode.Ok` when only the status reported the failure. */
  readonly code: number
  /** Why a started upload failed, as `UpdateStatus` says; `CharmUpdateReason.None` otherwise. */
  readonly reason: number
  constructor(code: number, reason: number = CharmUpdateReason.None) {
    // A reason is the charm's own account of a started upload, so it is worth more than the code
    // the op it failed in answered with.
    super(
      reason !== CharmUpdateReason.None
        ? `The update failed: ${updateReasonWords(reason)}`
        : refusalWords(code),
    )
    this.code = code
    this.reason = reason
    this.name = "FirmwareRefused"
  }
}

/**
 * The refusal a `Failed` update status is, wherever one is read — mid-upload or while the screen
 * watches the charm's own fetch: the charm's own reason for an attempt it started, carried by a
 * status rather than an op's answer, so the code is `Ok`'s and the reason is all there is.
 */
export function updateFailedRefusal(status: Pick<CharmUpdateStatus, "reason">): FirmwareRefused {
  return new FirmwareRefused(CharmCode.Ok, status.reason)
}

/**
 * How many bytes go over between status asks: often enough to notice a failure early, seldom enough
 * that a slow link carries the image rather than the questions about it.
 */
const STATUS_BYTES = 64 * 1024

/**
 * How many asks the tail of an upload may take: after the last byte is written, the charm's own
 * count is what says it landed, and a healthy drain outruns the paced writes — but a charm wedged
 * yet answering would be an unbounded hot poll, so the asks are counted and the row's own words end
 * the wait. Generous by design: it is a bound, not a pace.
 */
const TAIL_TRIES = 120

/**
 * How long the phone leaves between one data write and the next. A write carries no answer, so the
 * charm's refusal arrives as a notification, at least a connection event behind the write it
 * answers; a gap longer than that is what lands a refusal's notice before the write that follows
 * it. It is also longer than a pass of the charm's drain, so a charm that empties its whole buffer
 * per pass is never refused at all. Empirical rather than provable: the drain's flash timing is the
 * charm's, not the phone's.
 */
export const PACE_MS = 50

/**
 * The upload's one knob: the wait between data writes. A rig stands in for it, and a build whose
 * Busy notice names the fill it waits at is handed no wait at all — the notice re-anchors the send,
 * so the gap would only cost the image its minutes.
 */
export interface UploadOptions {
  pace?: () => Promise<void>
}

/**
 * Sends an image the phone holds: announce its length and hash, write it in link-sized chunks,
 * then end. Progress is the phone's own count of bytes written, with the charm's percentage beside
 * it once the charm has said where it got to.
 */
export async function uploadFirmware(
  link: FirmwareLink,
  image: Uint8Array,
  sha256: Uint8Array,
  onProgress?: (progress: FirmwareProgress) => void,
  options: UploadOptions = {},
): Promise<FirmwareProgress> {
  const pace: () => Promise<void> =
    options.pace ?? (() => new Promise<void>((done) => setTimeout(done, PACE_MS)))
  const progress: FirmwareProgress = { sent: 0, total: image.length }
  const begin = parseStatus(await link.ask(updateBeginMessage(image.length, sha256)))
  if (begin.code !== CharmCode.Ok) throw new FirmwareRefused(begin.code)
  // The row is redrawn for each whole percent, not for each chunk: a megabyte is thousands of
  // writes, and nothing on screen changes between one percent and the next.
  let shown: number | undefined
  const report = () => {
    const whole = progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0
    if (whole === shown) return
    shown = whole
    onProgress?.({ ...progress })
  }
  report()

  const size = chunkSize(link.mtu)
  let sinceAsk = 0
  let at = 0
  let last = 0 // where the write before it went, for the notice that names no fill
  // Null when a stray Busy notice answered the ask with no status of its own, which is no progress
  // and no failure — `test-charm-upload.mjs` holds that rule, over a charm that strays once.
  const askStatus = async (): Promise<CharmUpdateStatus | null> => {
    const status = await updateStatusOf(link)
    if (!status) return null
    if (status.state === CharmUpdateState.Failed) throw updateFailedRefusal(status)
    progress.percent = status.percent
    report()
    return status
  }
  // Settle asks since the walk last wrote: re-anchoring on a refusal starts the count over, since
  // the walk is writing again rather than waiting on a charm that has everything it was sent.
  let tail = 0
  for (;;) {
    // The gap is what a Busy notice needs to land: the write before it carried no answer, and a
    // notification is at least a connection event behind.
    await pace()
    const refusal = link.refusal()
    if (refusal) {
      // A notice that names the charm's fill re-anchors the send position there — the fill is
      // where the charm waits for the image, which the phone may already have written past. A
      // notice that names none is about the chunk just written, so that one goes again: the
      // next offset would be a gap, which the charm ends the whole image over.
      at = refusal.fill ?? last
      tail = 0
    }
    if (at < image.length) {
      const chunk = chunkAt(image, at, size)
      await link.data(chunk)
      last = at
      at += chunk.length - 4
      if (at > progress.sent) {
        sinceAsk += at - progress.sent
        progress.sent = at
        report()
      }
      if (sinceAsk < STATUS_BYTES) continue
      sinceAsk = 0
      await askStatus()
      continue
    }
    // The last byte is written, but a write carries no answer: the charm's own count is what
    // says it landed, and a refusal's notice can outlast the gap that wrote it. Until the
    // count says the charm holds the whole image, the loop keeps answering refusals; the end
    // goes out only to a charm that has it all — and a charm that says everything but 100 this
    // many asks over is waited on no further, in the row's own words.
    if (image.length === 0) break
    if ((await askStatus())?.percent === 100) break
    if ((tail += 1) === TAIL_TRIES) throw new Error(FIRMWARE_NOT_HELD)
  }

  const end = parseStatus(await link.ask(updateEndMessage()))
  if (end.code !== CharmCode.Ok) throw new FirmwareRefused(end.code, await failureReason(link))
  // The end is a yes only once the slot is bootable, which is the charm's Ready; it reboots a
  // moment later, so the last thing the phone hears before the link drops is this.
  const done = { ...progress, percent: 100 }
  onProgress?.(done)
  return done
}

/**
 * The version the charm answers once it is back after an upload, or the one it never left: `read`
 * is asked `tries` times, `waitMs` apart, and a change is what says the new build booted. `was` is
 * the build the row read before the upload — null where it read none, so any answer is a change.
 */
export async function versionAfterReboot(
  read: () => Promise<string | null>,
  was: string | null,
  { tries = REBOOT_TRIES, waitMs = REBOOT_MS } = {},
): Promise<{ changed: boolean; version: string | null }> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const now = await read()
      if (now !== was) return { changed: true, version: now }
    } catch {
      // The link is going down under it, which is the reboot itself.
    }
    await new Promise((done) => setTimeout(done, waitMs))
  }
  return { changed: false, version: was }
}

/**
 * Where the charm has got to, as `UpdateStatus` answers it. Null for an answer of another shape:
 * a data write refused for buffer room notifies a code of its own with no extra, and that
 * notification can answer this ask, since a data write has no answer to wait on.
 */
async function updateStatusOf(link: FirmwareLink): Promise<CharmUpdateStatus | null> {
  return parseUpdateStatus(await link.ask(updateStatusMessage()))
}

/** Why the charm refused the end, if it started an attempt to say so. */
async function failureReason(link: FirmwareLink): Promise<number> {
  // Best effort: an end refused for a session the charm no longer holds can be a link already
  // going, and the code it answered with is reason enough on its own.
  const status = await updateStatusOf(link).catch(() => null)
  return status?.state === CharmUpdateState.Failed ? status.reason : CharmUpdateReason.None
}
