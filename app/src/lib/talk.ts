/**
 * Voice: what the settings page asks a bot's host for when the reader sets a charm up, what it
 * writes to the charm from the answer, and the words the charm's own answer is drawn in.
 *
 * The host mints one token per bot and keeps only its hash (`plugin/talk_tokens.py`), so the token
 * is in the clear exactly twice: in the host's answer, and on the charm's flash once this write has
 * landed. Nothing in between keeps it — not this module, not the page's store, not the phone.
 *
 * The address is the one thing here the app has to be told rather than ask for: the host answers
 * the address this app dialled, which is public and https, while the charm calls over the tailnet in
 * plain http. So the row prefills what the host said and the reader edits it to an address the
 * charm can reach; `talkProblem` is the rule that says when they have not.
 *
 * Pure, so the row's rules are tested with no radio and no host (`scripts/test-charm-talk.mjs`).
 */
import { CHARM_MAX_URL_BYTES, CharmCode, codeWords, talkFrame } from "./charm-protocol.ts"
import { pluginRoot } from "./host-url.ts"

/** The route's own name in the plugin's feature list: a host older than it has no Voice row. */
export const TALK_FEATURE = "talk"

/** What the host answers the app's one ask with (`GET talk` in `plugin/__init__.py`). */
export interface TalkOffer {
  /** Where the charm's turns go, which the charm appends `/talk/v1/turn` to. */
  host: string
  /** The bot the token was minted for, as the id the charm knows it by. */
  bot: string
  /** The one copy of the token this axis of the world ever sees in the clear. */
  token: string
}

/** Where the ask goes: the plugin's own route on this bot's host, with the app's key. */
export const talkRoute = (baseUrl: string) => `${pluginRoot(baseUrl)}/talk`

/**
 * The host's answer, or the one sentence for an answer this app cannot read. A body that names no
 * address or no token is no offer at all: writing half of one would leave the charm with an address
 * that cannot prove itself.
 */
export function talkOffer(body: unknown): TalkOffer {
  const held = body as { host?: unknown; bot?: unknown; token?: unknown } | null
  if (
    typeof held?.host !== "string" ||
    held.host.trim() === "" ||
    typeof held.bot !== "string" ||
    typeof held.token !== "string" ||
    held.token === ""
  )
    throw new Error("The host's answer about your charm's voice was unreadable.")
  return { host: held.host, bot: held.bot, token: held.token }
}

/** Nothing was typed: the charm would have nowhere to send a turn. */
export const TALK_NEEDS_ADDRESS = "Your charm needs the address it can reach."
/** The charm's own call is plain http — the tailnet is the encrypted boundary, not its client. */
export const TALK_NEEDS_HTTP =
  "The charm speaks plain http on your tailnet — give it your host's tailnet address, not the https one your phone uses."
/** The firmware's own bound on the address it keeps. */
export const TALK_TOO_LONG = "That address is longer than the charm holds (180 bytes at most)."

/** The address as the frame carries it: trimmed, and without a slash the charm would double. */
export const talkAddress = (address: string) => address.trim().replace(/\/+$/, "")

/**
 * Why this address is not one the charm can be given, in the reader's words, or null for one it can.
 * The host answers the address the app dialled — https, on a public name — and the charm reaches the
 * host on the tailnet in plain http, so an https answer is a starting point rather than an address.
 */
export function talkProblem(address: string): string | null {
  const trimmed = address.trim()
  if (trimmed === "") return TALK_NEEDS_ADDRESS
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase()
  if (scheme === "https") return TALK_NEEDS_HTTP
  if (scheme !== "http") return TALK_NEEDS_ADDRESS
  if (new TextEncoder().encode(talkAddress(trimmed)).length > CHARM_MAX_URL_BYTES)
    return TALK_TOO_LONG
  return null
}

/**
 * The frame to write: the address and the token the charm keeps. Throws the reader's sentence for an
 * address it cannot use, before any connection is opened, so a typed-in mistake costs no link.
 */
export function talkMessage(address: string, token: string): Uint8Array {
  const problem = talkProblem(address)
  if (problem) throw new Error(problem)
  return talkFrame(talkAddress(address), token)
}

/** The charm kept both: the row's word that the hand-over is done. */
export const TALK_SENT = "Sent to your charm."

/** A plaintext charm keeps the token where anyone holding it can read it — said, not glossed. */
export const TALK_READABLE =
  "The charm kept it, but anyone holding the charm can read the token off the chip."

/** The charm does not speak the op at all: its firmware is older than this app. */
export const TALK_OLDER =
  "This charm's firmware is older than the app — update it, then set voice up again."

/**
 * What the charm's answer to the write means, in the words the row shows. Three of the codes have
 * their own sentence here; anything else is the charm's own words, as every other settings row
 * draws them.
 */
export function talkWords(code: number): string {
  if (code === CharmCode.Ok) return TALK_SENT
  if (code === CharmCode.KeptReadable) return TALK_READABLE
  if (code === CharmCode.BadMessage) return TALK_OLDER
  return codeWords(code)
}

/** The row's line under its title: what holding B does, which is the whole point of the setting. */
export const VOICE_ASK = "Hold B on your charm and talk to this bot"

/**
 * Under the address field: why the address the host answered is not the address the charm gets, in
 * the reader's own terms. Said once, before they have had to guess at it.
 */
export const VOICE_HINT =
  "Your phone reaches this bot at its own address; your charm needs one it can reach on your tailnet, and calls /talk/v1/turn on it."
