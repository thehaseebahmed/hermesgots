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
  charmKept,
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
import { talkMessage } from "./talk.ts"

export interface CharmTransport {
  /** Writes a control message and resolves with the charm's answer to it. */
  control(message: Uint8Array): Promise<CharmStatus>
  /** Writes a data chunk without a response. */
  data(chunk: Uint8Array): Promise<void>
  mtu: number
}

/** A link the caller opened, which the caller also closes. */
export interface CharmSession extends CharmTransport {
  close(): Promise<void>
}

/** What the phone remembers of the clock it last gave a charm, so one errand's links write one. */
export interface ClockMemo {
  /** When the charm last kept the phone's clock, in epoch milliseconds. */
  at: number
}

/** How long a clock the charm kept is trusted before the next link writes it again. */
export const CLOCK_TRUSTED_MS = 30_000

/** Anything older is a clock the charm refuses: 2020-01-01T00:00:00Z, the charm's own line. */
const SANE_CLOCK_MS = 1_577_836_800_000

export interface LinkOptions {
  /** The phone's clock, in epoch milliseconds; a test pins it. */
  now?: number
  /** Remembered by this helper when the charm keeps the clock, and read on the next link. */
  clock?: ClockMemo
}

export interface SyncOptions {
  /** Pet mode as the sheet has it, with the pet's pictures ready to send. */
  pet?: { settings: CharmPetSettings; poses: CharmPose[] }
  /** The voice hand-over this sync owes the charm: the address, and the mint that issues its token.
   * The mint is called at the frame's own write — after the bots, the pictures and the pet — because a
   * mint revokes the token the charm is holding, so that window is one write long rather than a sync's. */
  talk?: { address: string; mint: () => Promise<string> }
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
  /** The refusal was the clock, because this phone's own time reads before 2020. */
  petClockRefused?: boolean
  /** Whether the voice hand-over landed: the page's line, and what its record keeps. */
  voice?: "sent" | "refused"
  /** The charm's own code when it refused, so the page can say which refusal it was. */
  voiceCode?: number
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
    // A phone whose clock reads before 2020 hands the charm a time it refuses, and the pet's meters
    // would never move: the sync says which refusal that is instead of blaming the firmware for it.
    if (options.pet && (options.now ?? Date.now()) < SANE_CLOCK_MS) {
      progress.petRefused = true
      progress.petClockRefused = true
    } else {
      try {
        await sendPet(link, size, options)
      } catch (error) {
        // The bots are already on the charm. A charm that cannot run a pet must not turn a good sync
        // into a failed one, and a dead link still fails.
        if (!(error instanceof CharmRefused)) throw error
        progress.petRefused = true
      }
    }
    // The voice hand-over is last and never fails the sync: a charm that refuses it, a host that will
    // not mint and a link that goes at the last write all leave the bots and the pet landed, and the
    // next sync offers the voice again.
    if (options.talk) {
      try {
        const token = await options.talk.mint()
        const answer = await link.control(talkMessage(options.talk.address, token))
        const kept = charmKept(answer.code)
        progress.voice = kept ? "sent" : "refused"
        // The charm's own code, so the page can say which refusal it was: an older firmware's "update
        // it" is not a busy charm's "try again".
        if (!kept) progress.voiceCode = answer.code
      } catch {
        progress.voice = "refused"
      }
    }
    return progress
  } catch (error) {
    // Best effort: the charm drops a half-done sync on disconnect anyway.
    await link.control(abortMessage()).catch(() => {})
    throw error
  }
}

/**
 * Hands the charm the phone's clock, and answers whether it kept it. A refusal is an answer and not
 * an error: a firmware older than `Time` says `BadMessage`, and a clock the charm cannot believe is
 * no reason to fail a link the reader opened for something else.
 */
export async function sendClock(link: CharmTransport, nowMs = Date.now()): Promise<boolean> {
  const answer = await link.control(timeMessage(Math.floor(nowMs / 1000)))
  return charmKept(answer.code)
}

/**
 * One link, in the only order there is: opened, handed the phone's clock, then the caller's op, and
 * closed whatever either of them did. A refused clock costs this link a round trip and nothing else,
 * because the op it was opened for is what the reader asked for. The opener belongs to the caller,
 * so this is drivable without a radio, and a memo of the last clock kept means one errand's run of
 * links — a sync's battery read, a log's pages, an update's polls — writes it once.
 */
export async function withLink<L extends CharmSession, T>(
  open: () => Promise<L>,
  run: (link: L) => Promise<T>,
  options: LinkOptions = {},
): Promise<T> {
  const link = await open()
  try {
    const now = options.now ?? Date.now()
    const memo = options.clock
    if (!memo || now - memo.at > CLOCK_TRUSTED_MS) {
      // Only a clock the charm kept restarts the window: one it refused is worth trying again, since
      // what the charm could not believe may have been mended in between.
      const kept = await sendClock(link, now).catch(() => false)
      if (kept && memo) memo.at = now
    }
    return await run(link)
  } finally {
    await link.close()
  }
}

async function sendPet(link: CharmTransport, size: number, options: SyncOptions) {
  if (!options.pet) return
  const { settings, poses } = options.pet
  // The clock the pet's meters run on. A charm that refuses it is left with the pet as it was
  // rather than switched on with a clock that never moves, and the page is told — as it is for a
  // firmware with no pet mode at all.
  if (!(await sendClock(link, options.now))) throw new CharmRefused(CharmCode.BadMessage)
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

