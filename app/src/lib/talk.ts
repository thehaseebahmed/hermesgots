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
import type { CharmScheme } from "./charm.ts"
import {
  TALK_NEEDS_ADDRESS,
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
  /** The host's own tailnet address, plain http, when it can name one: the `http` scheme's address. */
  tailnet?: string
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
  const held = body as { host?: unknown; tailnet?: unknown; bot?: unknown; token?: unknown } | null
  if (typeof held?.token !== "string" || held.token === "")
    throw new Error("The host's answer about your charm's voice was unreadable.")
  return { ...talkAddresses(body), token: held.token }
}

/**
 * The two addresses in a host's answer, and the bot they were minted for, with no token: the shape
 * `?mint=0` answers, so an app can tell whether it has an address before it spends a token.
 */
export function talkAddresses(body: unknown): Omit<TalkOffer, "token"> {
  const held = body as { host?: unknown; tailnet?: unknown; bot?: unknown } | null
  if (
    typeof held?.host !== "string" ||
    held.host.trim() === "" ||
    typeof held.bot !== "string" ||
    (held.tailnet !== undefined &&
      (typeof held.tailnet !== "string" || held.tailnet.trim() === ""))
  )
    throw new Error("The host's answer about your charm's voice was unreadable.")
  return {
    host: held.host,
    bot: held.bot,
    ...(held.tailnet === undefined ? {} : { tailnet: held.tailnet as string }),
  }
}

/** The address as the frame carries it: trimmed, and without a slash the charm would double. */
export const talkAddress = (address: string) => address.trim().replace(/\/+$/, "")

/**
 * Why this address is not one the charm can be given, in the reader's words, or null for one it can.
 * Both schemes are the charm's now — https over its own Wi-Fi with a certificate, plain http over the
 * tailnet — so the scheme is read to refuse what is neither, and the bound is the frame's own.
 */
export function talkProblem(address: string): string | null {
  const trimmed = address.trim()
  if (trimmed === "") return TALK_NEEDS_ADDRESS
  const scheme = schemeOf(trimmed)
  if (scheme !== "http" && scheme !== "https") return TALK_NEEDS_ADDRESS
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

/**
 * Whether the next sync owes the charm a hand-over: it holds no address, its record is a bare `true`
 * from before this phone kept the address, or the address it holds is the other scheme's. A sync that
 * owes nothing asks the host for nothing, so no token is minted and none is revoked.
 */
export function voiceOwed(
  record: { talk?: boolean | string; talkBot?: string } | null | undefined,
  scheme: CharmScheme,
  bot: string | undefined,
): boolean {
  const held = record?.talk
  // No address, or a record from before addresses were kept: the charm holds nothing this phone can
  // vouch for.
  if (typeof held !== "string") return true
  // The other scheme's address is not one this sync would write.
  if (schemeOf(held) !== scheme) return true
  // A token is minted per bot, so a phone that changed bot owes the charm another one even though the
  // address it holds is the same.
  return Boolean(bot) && record?.talkBot !== bot
}

/**
 * The address a host's answer names for `scheme`: its own public address for https, its tailnet
 * address for plain http — and null when it did not name a tailnet one, which is a sync that says so
 * rather than one that hands the charm an address it cannot dial.
 */
export function voiceAddress(
  offer: { host: string; tailnet?: string },
  scheme: CharmScheme,
): string | null {
  return scheme === "https" ? offer.host : (offer.tailnet ?? null)
}
