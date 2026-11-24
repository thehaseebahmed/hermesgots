/**
 * The charm's own fetch of the image: the URL the phone hands the charm in the `Update` op. The base
 * is the host address the voice hand-over already keeps (`PairedCharm.talk` — https over the charm's
 * Wi-Fi, plain http over its tailnet, whichever the voice scheme picked), so the door the charm
 * walks is one it already holds; the short-lived fetch token rides the URL (`plugin/fetch_tokens.py`),
 * because the `Update` op's payload is `[urlLen][url][sha256]` — a token in the URL needs no wire
 * change — and the address is never logged with it.
 *
 * The image's bytes are pinned by the SHA-256 the phone sends the charm either way — the hash is
 * the trust anchor, and the token is only the door.
 *
 * Pure, so `scripts/test-firmware-fetch.mjs` runs it as a rule; the ask that mints the token is
 * `getCharmFirmwareFetchToken`'s own business in hermes.ts, as the streamed read is
 * `getCharmFirmwareImage`'s.
 */
import {
  addressBytes,
  CharmLinkState,
  encoder,
  type CharmNetworkReport,
} from "./charm-protocol.ts"
import { schemeOf } from "./host-url.ts"
import { compareVersions } from "./version-compare.ts"
import { talkAddress } from "./talk.ts"

/** The image route's tokened variant under the plugin prefix, as the phone already knows it. */
const FIRMWARE_FETCH_PATH = "/charm/firmware/image/fetch"

/**
 * The first build whose update door takes a plain http address. Before it the charm's `Update`
 * op takes https only — while a charm of those builds can still hold an http voice address over
 * its tailnet, a state this app's own Voice switch writes — so a build from before it, or one
 * this phone cannot name at all, is never handed the http door.
 */
const HTTP_DOOR_BUILD = "0.2.1-beta"

/** The host's token at its widest, as `fetch_tokens.py`'s `TOKEN_BYTES` spells it: 64 hex. */
const TOKEN_HEX = 64

/**
 * The token the host's mint answers, or the one sentence for an answer this app cannot read. A body
 * that names no token is no door at all: handing the charm a URL without one would send it walking
 * into a refusal the phone could have seen here.
 */
export function firmwareFetchToken(body: unknown): string {
  const held = body as { token?: unknown } | null
  if (typeof held?.token !== "string" || held.token === "")
    throw new Error("The host's answer about the charm's fetch token was unreadable.")
  return held.token
}

/**
 * The URL the phone hands the charm: the voice hand-over's own base, read by the rule every
 * charm-held address is (`talkAddress`), with the scheme lower-cased — the voice row keeps the
 * case the reader typed and the charm's own talk door folds it, but its update door reads the
 * scheme case-exactly, so the lower case is the one spelling both doors take. Throws the
 * reader's sentence for a base the charm cannot dial — a scheme neither door speaks — before
 * any connection is opened, so a record gone stale costs no link; the whole URL is bounded by
 * the charm's own frame, as every address it carries is.
 */
export function firmwareFetchUrl(base: string, token: string): string {
  const trimmed = talkAddress(base).replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, (scheme) =>
    scheme.toLowerCase(),
  )
  if (encoder.encode(token).length === 0) throw new Error("A fetch token is at least 1 byte")
  const url = `${trimmed}${FIRMWARE_FETCH_PATH}?token=${encodeURIComponent(token)}`
  addressBytes(
    url,
    ["http", "https"],
    "An update address",
    "The charm fetches over https on its Wi-Fi or http on its tailnet.",
  )
  return url
}

/** Which way the image goes onto the charm: its own fetch, or the transfer this phone drives. */
export type FirmwareDoor = "fetch" | "transfer"

/**
 * Whether the fetch URL this address opens can fit the charm's own frame: the URL is the address
 * plus the image route and the host's token, so an address the voice row keeps can still leave no
 * room for the door. The builder's own bound is the rule, asked with the widest token the host
 * mints — and the builder's throw stays the backstop on the walk itself, for a host that mints
 * wider.
 */
function fetchUrlFits(base: string): boolean {
  try {
    firmwareFetchUrl(base, "f".repeat(TOKEN_HEX))
    return true
  } catch {
    return false
  }
}

/**
 * The door the update walks, from the charm's own report of its links, the voice hand-over this
 * phone keeps, and the build the charm itself answered. The door is the address the hand-over
 * wrote the charm: https is the host's own address, which the charm fetches over the Wi-Fi it
 * joins; http is its tailnet address, which the charm takes only while its tunnel is up — and
 * only from the first build that learned to take it, so a scheme switched since the last sync
 * is a preference the charm has not been handed, not a door it holds. No address kept, no door;
 * no room in the frame for the URL, no door either — the transfer is the one walk that cannot
 * be refused on the wire.
 *
 * Pure, like the rest of this module: the ask the report comes from is `charmNetwork`'s, the one
 * the settings page already makes, and the build is the version read the update itself takes
 * before anything goes — `null` where the charm could not say, which is not a build that takes
 * the http door.
 */
export function firmwareDoor(
  report: CharmNetworkReport,
  scheme: "http" | "https",
  address: string | undefined,
  build: string | null,
): FirmwareDoor {
  if (!address || schemeOf(address) !== scheme) return "transfer"
  // The http update door is new in the charm's own line: an older build — or one this phone
  // cannot name — takes https only, and the transfer is the door it always takes.
  if (scheme === "http" && (build === null || (compareVersions(build, HTTP_DOOR_BUILD) ?? -1) < 0))
    return "transfer"
  const link = scheme === "https" ? report.wifi.state : report.tailnet.state
  if (link !== CharmLinkState.Online) return "transfer"
  if (!fetchUrlFits(address)) return "transfer"
  return "fetch"
}
