/**
 * One sync to the Gots Charm, over any transport: announce the list, send only the pictures the
 * charm lacks, commit. The charm's shown list changes only on commit, so a sync cut off anywhere
 * leaves the last good one in place.
 *
 * Pet mode rides along after the bots when the settings page has something to say: the phone's
 * clock, the pet's mood pictures, then the toggle itself — so the pet never starts with a face the
 * charm lacks, and a charm too old for pet mode still takes the bot list.
 */
import {
  CharmCode,
  abortMessage,
  beginMessage,
  botMessage,
  checkBots,
  checkPoses,
  chunkSize,
  codeWords,
  commitMessage,
  imageChunks,
  imageEndMessage,
  imageMessage,
  petSettingsMessage,
  poseImageEndMessage,
  poseImageMessage,
  poseMessage,
  timeMessage,
  type CharmBot,
  type CharmPetSettings,
  type CharmPose,
  type CharmStatus,
} from "./charm-protocol.ts"

export interface CharmTransport {
  /** Writes a control message and resolves with the charm's answer to it. */
  control(message: Uint8Array): Promise<CharmStatus>
  /** Writes a data chunk without a response. */
  data(chunk: Uint8Array): Promise<void>
  mtu: number
}

export interface SyncOptions {
  /** Pet mode as the sheet has it, with the pet's pictures ready to send. */
  pet?: { settings: CharmPetSettings; poses: CharmPose[] }
  /** The phone's clock, in epoch milliseconds; tests pin it. */
  now?: number
}

export interface SyncProgress {
  done: number
  total: number
  /** Pictures actually sent; the rest the charm already had. */
  sent: number
  /** The charm would not take pet mode: firmware without it, or a clock it did not believe. */
  petRefused?: boolean
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
  options: SyncOptions = {},
): Promise<SyncProgress> {
  checkBots(bots)
  // Refused before anything goes over: the bots are the part of a sync that must land. Building the
  // settings message here is the check: it throws on a night or a pet the charm could not run.
  if (options.pet) {
    checkPoses(options.pet.poses)
    petSettingsMessage(options.pet.settings)
  }
  const progress: SyncProgress = { done: 0, total: bots.length, sent: 0 }
  const size = chunkSize(link.mtu)
  try {
    await ask(link, beginMessage(bots.length))
    onProgress?.({ ...progress })
    for (const [index, bot] of bots.entries()) {
      const { needImage } = await ask(link, botMessage(index, bot))
      // One bit answers for both pictures, so each the bot announced goes when it says one is
      // missing: the charm keeps a picture by its CRC and already has the other.
      if (needImage) {
        for (const image of [bot.image, bot.waiting]) {
          if (image.length === 0) continue
          await sendImage(link, index, image, size)
          progress.sent++
        }
      }
      progress.done++
      onProgress?.({ ...progress })
    }
    await ask(link, commitMessage())
    try {
      await sendPet(link, size, options)
    } catch (error) {
      // The bots are already on the charm. A charm that cannot run a pet must not turn a good sync
      // into a failed one, and a dead link still fails.
      if (!(error instanceof CharmRefused)) throw error
      progress.petRefused = true
    }
    return progress
  } catch (error) {
    // Best effort: the charm drops a half-done sync on disconnect anyway.
    await link.control(abortMessage()).catch(() => {})
    throw error
  }
}

async function sendPet(link: CharmTransport, size: number, options: SyncOptions) {
  if (!options.pet) return
  const { settings, poses } = options.pet
  await ask(link, timeMessage(Math.floor((options.now ?? Date.now()) / 1000)))
  if (settings.enabled) {
    for (const pose of poses) {
      if (!(await ask(link, poseMessage(pose.mood, pose.image))).needImage) continue
      await sendPicture(
        link,
        pose.image,
        size,
        poseImageMessage(pose.mood),
        poseImageEndMessage(pose.mood),
      )
    }
  }
  // Last, so a pet never starts on a charm that lacks its face.
  await ask(link, petSettingsMessage(settings))
}

async function sendImage(link: CharmTransport, index: number, image: Uint8Array, size: number) {
  await sendPicture(link, image, size, imageMessage(index), imageEndMessage(index))
}

/** Sends one picture, and sends it again if it arrives damaged. */
async function sendPicture(
  link: CharmTransport,
  image: Uint8Array,
  size: number,
  start: Uint8Array,
  end: Uint8Array,
) {
  for (let attempt = 1; ; attempt++) {
    await ask(link, start)
    for (const chunk of imageChunks(image, size)) await link.data(chunk)
    const answer = await ask(link, end)
    if (answer.code === CharmCode.Ok) return
    if (attempt >= IMAGE_TRIES) throw new CharmRefused(CharmCode.BadImage)
  }
}
