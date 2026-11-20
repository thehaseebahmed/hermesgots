/**
 * One sync to the Gots Charm, over any transport: announce the list, send only the pictures the
 * charm lacks, commit. The charm's shown list changes only on commit, so a sync cut off anywhere
 * leaves the last good one in place.
 */
import {
  CharmCode,
  abortMessage,
  beginMessage,
  botMessage,
  checkBots,
  chunkSize,
  codeWords,
  commitMessage,
  imageChunks,
  imageEndMessage,
  imageMessage,
  type CharmBot,
  type CharmStatus,
} from "./charm-protocol.ts"

export interface CharmTransport {
  /** Writes a control message and resolves with the charm's answer to it. */
  control(message: Uint8Array): Promise<CharmStatus>
  /** Writes a data chunk without a response. */
  data(chunk: Uint8Array): Promise<void>
  mtu: number
}

export interface SyncProgress {
  done: number
  total: number
  /** Pictures actually sent; the rest the charm already had. */
  sent: number
}

export class CharmRefused extends Error {
  readonly code: number
  constructor(code: number) {
    super(codeWords(code))
    this.code = code
    this.name = "CharmRefused"
  }
}

/** Times one picture is sent again after arriving damaged. */
const IMAGE_TRIES = 3

async function ask(link: CharmTransport, message: Uint8Array): Promise<CharmStatus> {
  const answer = await link.control(message)
  if (answer.code !== CharmCode.Ok && answer.code !== CharmCode.BadImage)
    throw new CharmRefused(answer.code)
  return answer
}

export async function syncCharm(
  link: CharmTransport,
  bots: CharmBot[],
  onProgress?: (progress: SyncProgress) => void,
): Promise<SyncProgress> {
  checkBots(bots)
  const progress: SyncProgress = { done: 0, total: bots.length, sent: 0 }
  const size = chunkSize(link.mtu)
  try {
    await ask(link, beginMessage(bots.length))
    onProgress?.({ ...progress })
    for (const [index, bot] of bots.entries()) {
      const { needImage } = await ask(link, botMessage(index, bot))
      if (needImage) {
        await sendImage(link, index, bot.image, size)
        progress.sent++
      }
      progress.done++
      onProgress?.({ ...progress })
    }
    await ask(link, commitMessage())
    return progress
  } catch (error) {
    // Best effort: the charm drops a half-done sync on disconnect anyway.
    await link.control(abortMessage()).catch(() => {})
    throw error
  }
}

async function sendImage(link: CharmTransport, index: number, image: Uint8Array, size: number) {
  for (let attempt = 1; ; attempt++) {
    await ask(link, imageMessage(index))
    for (const chunk of imageChunks(image, size)) await link.data(chunk)
    const answer = await ask(link, imageEndMessage(index))
    if (answer.code === CharmCode.Ok) return
    if (attempt >= IMAGE_TRIES) throw new CharmRefused(CharmCode.BadImage)
  }
}
