/**
 * An image sent to the Gots Charm over the link the phone already holds: announce its length and
 * SHA-256, write it as `[offset u32][bytes]` chunks, then end. The charm checks the hash before it
 * makes the slot bootable, so the SHA-256 the phone computes is the whole trust anchor — a wrong or
 * truncated image is refused whatever served it.
 *
 * Pure over a transport, so a test drives a charm in memory with no radio.
 */
import {
  CharmCode,
  CharmUpdateReason,
  CharmUpdateState,
  chunkSize,
  imageChunks,
  parseStatus,
  parseUpdateStatus,
  updateBeginMessage,
  updateEndMessage,
  updateStatusMessage,
  type CharmUpdateStatus,
} from "./charm-protocol.ts"
import type { CharmTransport } from "./charm-sync.ts"
import { refusalWords, updateReasonWords } from "./charm-words.ts"

/**
 * A link an image goes over: a sync's transport, plus the answer as the bytes the charm sent. A
 * status ask can be answered by the notification a refused data write raises, and that answer has
 * no extra to read, so the upload sees the answer itself rather than a parsed status.
 */
export interface FirmwareLink extends CharmTransport {
  ask(message: Uint8Array): Promise<DataView>
}

export interface FirmwareProgress {
  /** Bytes the phone has written, and the image's whole length. */
  sent: number
  total: number
  /** The charm's own count, in whole percent, as its last status answer said: -1 until it does. */
  percent: number
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
 * How many bytes go over between status asks: often enough to notice a failure early, seldom enough
 * that a slow link carries the image rather than the questions about it.
 */
const STATUS_BYTES = 64 * 1024

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
): Promise<FirmwareProgress> {
  const progress: FirmwareProgress = { sent: 0, total: image.length, percent: -1 }
  const begin = parseStatus(await link.ask(updateBeginMessage(image.length, sha256)))
  if (begin.code !== CharmCode.Ok) throw new FirmwareRefused(begin.code)
  onProgress?.({ ...progress })

  const size = chunkSize(link.mtu)
  let sinceAsk = 0
  for (const chunk of imageChunks(image, size)) {
    await link.data(chunk)
    progress.sent += chunk.length - 4
    onProgress?.({ ...progress })
    sinceAsk += chunk.length - 4
    if (sinceAsk < STATUS_BYTES) continue
    sinceAsk = 0
    const status = await updateStatusOf(link)
    // A data write refused for buffer room notifies a code with no extra, and that notification
    // can answer this ask: it is neither progress nor a reason to stop, so the image carries on.
    if (!status) continue
    if (status.state === CharmUpdateState.Failed)
      throw new FirmwareRefused(CharmCode.Ok, status.reason)
    progress.percent = status.percent
    onProgress?.({ ...progress })
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
