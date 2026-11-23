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
  CHARM_MAX_URL_BYTES,
  CharmLinkState,
  encoder,
  type CharmNetworkReport,
} from "./charm-protocol.ts"
import { schemeOf } from "./host-url.ts"

/** The image route's tokened variant under the plugin prefix, as the phone already knows it. */
const FIRMWARE_FETCH_PATH = "/charm/firmware/image/fetch"

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
 * The URL the phone hands the charm: the voice hand-over's own base, with the tokened image route
 * on it and the fetch token as the door. Throws the reader's sentence for a base the charm cannot
 * dial — a scheme neither door speaks — before any connection is opened, so a record gone stale
 * costs no link; the whole URL is bounded by the charm's own frame, as every address it carries is.
 */
export function firmwareFetchUrl(base: string, token: string): string {
  const trimmed = base.trim().replace(/\/+$/, "")
  const scheme = schemeOf(trimmed)
  if (scheme !== "http" && scheme !== "https")
    throw new Error("The charm fetches over https on its Wi-Fi or http on its tailnet.")
  if (encoder.encode(token).length === 0) throw new Error("A fetch token is at least 1 byte")
  const url = `${trimmed}${FIRMWARE_FETCH_PATH}?token=${encodeURIComponent(token)}`
  if (encoder.encode(url).length > CHARM_MAX_URL_BYTES)
    throw new Error(`An update address is at most ${CHARM_MAX_URL_BYTES} bytes`)
  return url
}

/** Which way the image goes onto the charm: its own fetch, or the transfer this phone drives. */
export type FirmwareDoor = "fetch" | "transfer"

/**
 * The door the update walks, from the charm's own report of its links and the voice hand-over this
 * phone keeps. The door is the address the hand-over wrote the charm: https is the host's own
 * address, which the charm fetches over the Wi-Fi it joins; http is its tailnet address, which the
 * charm takes only while its tunnel is up — so the scheme the reader keeps and the one the address
 * carries must name the same door, since a scheme switched since the last sync is a preference the
 * charm has not been handed, not a door it holds. No address kept, no door.
 *
 * Pure, like the rest of this module: the ask the report comes from is `charmNetwork`'s, the one
 * the settings page already makes.
 */
export function firmwareDoor(
  report: CharmNetworkReport,
  scheme: "http" | "https",
  address: string | undefined,
): FirmwareDoor {
  if (!address || schemeOf(address) !== scheme) return "transfer"
  const link = scheme === "https" ? report.wifi.state : report.tailnet.state
  return link === CharmLinkState.Online ? "fetch" : "transfer"
}
