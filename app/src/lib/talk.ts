/**
 * Voice: what the settings page asks a bot's host for when the reader sets a charm up, what it
 * writes to the charm from the answer, and the rules the address it carries is held to. The words
 * the row draws are `charm-words.ts`'s, with every other sentence a charm's settings read.
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
import { CHARM_MAX_URL_BYTES, CharmCode, charmKept, encoder, talkFrame } from "./charm-protocol.ts"
import {
  TALK_NEEDS_ADDRESS,
  TALK_NEEDS_HTTP,
  TALK_SENT,
  TALK_STILL_HELD,
  TALK_TOO_LONG,
  VOICE_TAIL,
  refusalWords,
} from "./charm-words.ts"
import { pluginRoot, schemeOf } from "./host-url.ts"

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

/** The address as the frame carries it: trimmed, and without a slash the charm would double. */
export const talkAddress = (address: string) => address.trim().replace(/\/+$/, "")

/**
 * Why this address is not one the charm can be given, in the reader's words, or null for one it can.
 * The host answers the address the app dialled — https, on a public name — and the charm reaches the
 * host on the tailnet in plain http, so an https answer is a starting point rather than an address.
 * The scheme is read by the one rule `host-url.ts` holds, and the bound is the frame's own.
 */
export function talkProblem(address: string): string | null {
  const trimmed = address.trim()
  if (trimmed === "") return TALK_NEEDS_ADDRESS
  const scheme = schemeOf(trimmed)
  if (scheme === "https") return TALK_NEEDS_HTTP
  if (scheme !== "http") return TALK_NEEDS_ADDRESS
  if (encoder.encode(talkAddress(trimmed)).length > CHARM_MAX_URL_BYTES) return TALK_TOO_LONG
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

/**
 * What the charm's answer to the write means, in the words the row shows. Its own `Ok` has the row's
 * word; an answer that kept the secret has the charm's code and nothing more, since the token is
 * spent; everything else is the charm's code, drawn by the settings page's one rule for a code — the
 * firmware step for an op the charm is too old to know, with this row's next step on the end of it —
 * followed by the one fact that answer leaves: the token is still this phone's to send again.
 */
export function talkWords(code: number): string {
  if (code === CharmCode.Ok) return TALK_SENT
  const words = refusalWords(code, VOICE_TAIL)
  return charmKept(code) ? words : `${words} ${TALK_STILL_HELD}`
}
