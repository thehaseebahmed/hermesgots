/**
 * What a list calls a bot: the host it answers at, not the name that host sealed for it. A Hermes
 * host names its default profile "Hermes" (`plugin/link.py`), so two linked hosts drew two identical
 * rows in every picker.
 *
 * The label is read, never stored (`docs/adr/0148-a-bot-is-named-by-the-host-it-lives-on.md`):
 * - a host's short name is its first DNS label, `hermes.domain.com` → `hermes`;
 * - where two hosts wear one short name, they read as the domain part instead, `domain` and `example`;
 * - a host holding more than one bot appends the Hermes profile it is reached at, `hermes/work`.
 *
 * Import-free, like `host-url.ts` beside it, so the unit tier reads it as a pure rule. The `/p/<name>`
 * and `/v1` rules are that file's, repeated here to keep the module readable on its own.
 */

/** The three fields a label is read from: `Profile` carries them and so does a list's row. */
export interface NamedBot {
  id: string
  name: string
  baseUrl: string
}

/**
 * The app's own name for a host's default profile. A bot with no host at all — one added by hand and
 * never linked — keeps its own name, and a name that is only this reads as a bot.
 */
const APP_NAME = "Hermes"

/** A host as a bot's address names it: its name and, where one is given, its port. */
function hostOf(baseUrl: string) {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ""
  try {
    const url = new URL(trimmed)
    return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    // A base URL that doesn't parse is its own host, which is what `hostKey` says of it too.
    return trimmed.replace(/\/+$/, "")
  }
}

const nameOf = (host: string) => host.replace(/:\d+$/, "")
const labelsOf = (host: string) => nameOf(host).split(".").filter(Boolean)

/**
 * The name a host goes by: its first DNS label. A single-label host — `localhost`, an address — has
 * only its whole self to be called, its port included, since that is all that tells two apart.
 */
function shortOf(host: string) {
  const labels = labelsOf(host)
  return labels.length > 1 ? labels[0] : host
}

/**
 * What tells one host from another wearing the same short name: its own part of the domain, with the
 * public suffix's last label off — `hermes.domain.com` → `domain`, `hermes.foo.co.uk` → `foo.co`.
 * `undefined` where there is nothing between the two, as `localhost` has not.
 */
function domainOf(host: string) {
  const labels = labelsOf(host)
  return labels.length > 2 ? labels.slice(1, -1).join(".") : undefined
}

/** The Hermes profile a bot is, where its host serves it under `/p/<profile>`; else the default one. */
function placeOf(baseUrl: string) {
  const root = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "")
  return root.match(/\/p\/([^/?#]+)$/)?.[1]
}

/** A bot with no server to be named by keeps its own name, unless that is only the app's. */
function ownName(bot: NamedBot) {
  const name = bot.name.trim()
  return name && name !== APP_NAME ? name : "Bot"
}

/**
 * The label a list gives `bot`, among the bots that list holds. The peers are what tell a name from
 * another host's: a bot read alone is named by its host's short name alone.
 */
export function botLabel(bot: NamedBot, peers: NamedBot[]): string {
  const host = hostOf(bot.baseUrl)
  if (!host) return ownName(bot)
  const others = peers.filter((peer) => peer.id !== bot.id).map((peer) => hostOf(peer.baseUrl))
  const short = shortOf(host)
  // Another host wears this name too: the domain part tells them apart, and the whole host where
  // even that is shared.
  let base = short
  if (others.some((other) => other && other !== host && shortOf(other) === short)) {
    const part = domainOf(host)
    base = part ?? host
    if (
      part &&
      others.some((other) => other && other !== host && (domainOf(other) ?? other) === part)
    )
      base = host
  }
  // One host holding several bots: the profile says which of them this is. The default profile is
  // the host itself, so it keeps the bare name — and two bots linked at one host *and* one profile
  // are told apart by their own name, the only thing left that holds them apart.
  const sameHost = peers.filter((peer) => peer.id !== bot.id && hostOf(peer.baseUrl) === host)
  const place = placeOf(bot.baseUrl)
  if (sameHost.some((peer) => placeOf(peer.baseUrl) === place)) base = ownName(bot)
  else if (sameHost.length && place) base = `${base}/${place}`
  return base
}

/** Every bot of a list, labelled against the others: what a picker draws its rows from. */
export function botLabels(bots: NamedBot[]) {
  return new Map(bots.map((bot) => [bot.id, botLabel(bot, bots)]))
}

/** A list's label for `bot`, or its own name where the list drew no label for it. */
export function labelOf(labels: Map<string, string> | undefined, bot: NamedBot) {
  return labels?.get(bot.id) ?? bot.name
}
