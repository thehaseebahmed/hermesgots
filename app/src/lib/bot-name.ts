/**
 * What a list calls a bot: the name its host gave it, and the host it answers at only where another bot
 * of that name answers somewhere else (ADR 0149).
 *
 * A host seals its default profile "Hermes" (`plugin/link.py`), so two linked hosts read alike — and
 * the address is what tells them apart, but as a suffix on the name rather than as the name itself:
 * - two bots of one name on different hosts read `Hermes (domain)`, `Hermes (example)`;
 * - a name nobody else wears reads bare, `Studio`, whatever host it is on;
 * - two bots of one name on one host both read bare too, since no host tells those two apart.
 *
 * The host a suffix shows is read through ADR 0148's ladder, never stored: the first DNS label, the
 * domain part where two hosts wear that name, the whole host where even that collides. `host-url.ts`
 * holds the one rule for where a bot's routes live, and nothing here keeps a second copy of it.
 */
import { byName } from "./compare.ts"

/** The three fields a label is read from: `Profile` carries them and so does a list's row. */
export interface NamedBot {
  id: string
  name: string
  baseUrl: string
}

/** What a bot with no name at all is called, so a row always says something. */
const ANONYMOUS = "Bot"

/**
 * A bot's address with any scheme and path taken off, for the strings `new URL` reads as no host: a
 * hand-typed `hermes.domain.com:8642` parses with a scheme of its own and an empty host.
 */
const withoutPath = (baseUrl: string) =>
  baseUrl
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/+$/, "")

/** A host as a bot's address names it: its name and, where one is given, its port. */
function hostOf(baseUrl: string) {
  const trimmed = baseUrl.trim()
  if (!trimmed) return ""
  try {
    const url = new URL(trimmed)
    if (url.hostname) return url.port ? `${url.hostname}:${url.port}` : url.hostname
  } catch {
    // A base URL that doesn't parse is its own host, which is what `hostKey` says of it too.
  }
  return withoutPath(trimmed)
}

const nameOf = (host: string) => host.replace(/:\d+$/, "")

/** An address is nobody's name: `192.168.1.50` and `[::1]` are read whole, their port and all. */
const isAddress = (name: string) => /^\d+(\.\d+)*$/.test(name) || name.includes(":")

const labelsOf = (host: string) => nameOf(host).split(".").filter(Boolean)

/**
 * The name a host goes by: its first DNS label. A single-label host — `localhost` — and an address
 * have only their whole selves to be called, the port included, since that is all that tells two
 * apart.
 */
function shortOf(host: string) {
  if (isAddress(nameOf(host))) return host
  const labels = labelsOf(host)
  return labels.length > 1 ? labels[0] : host
}

/**
 * What tells one host from another wearing the same short name: its own part of the domain, with the
 * public suffix's last label off — `hermes.domain.com` → `domain`, `hermes.foo.co.uk` → `foo.co`.
 * `undefined` where there is nothing between the two, as `localhost` has not.
 */
function domainOf(host: string) {
  if (isAddress(nameOf(host))) return undefined
  const labels = labelsOf(host)
  return labels.length > 2 ? labels.slice(1, -1).join(".") : undefined
}

/**
 * The host a suffix shows, measured against the hosts it has to be told apart from: its short name,
 * their domain parts where one short name is worn twice, and the whole host where even those collide.
 */
function hostAgainst(host: string, rivals: string[]): string {
  const short = shortOf(host)
  const sameShort = rivals.filter((other) => shortOf(other) === short)
  if (!sameShort.length) return short
  const part = domainOf(host)
  if (!part) return host
  return sameShort.some((other) => (domainOf(other) ?? other) === part) ? host : part
}

/** The name a bot reads as: what its host sealed, or `Bot` where it sealed nothing. */
const nameOfBot = (bot: NamedBot) => bot.name.trim() || ANONYMOUS

/** Where a bot answers, read once: its label is built from this and its peers'. */
const hostOfBot = (bot: NamedBot) => hostOf(bot.baseUrl)

/**
 * The label a list gives `bot`, among the bots that list holds: its own name, and — only where another
 * bot of that name answers at a different host — the host that tells the two apart.
 */
export function botLabel(bot: NamedBot, peers: NamedBot[]): string {
  const name = nameOfBot(bot)
  const host = hostOfBot(bot)
  if (!host) return name
  const rivals = peers
    .filter((peer) => peer.id !== bot.id && byName(nameOfBot(peer), name) === 0)
    .map(hostOfBot)
    // A peer with no server has no host to draw, so it is no namesake a list has to answer for.
    .filter((other) => other && other !== host)
  if (!rivals.length) return name
  return `${name} (${hostAgainst(host, rivals)})`
}

/** Every bot of a list, labelled against the others: what a picker draws its rows from. */
export function botLabels(bots: NamedBot[]) {
  return new Map(bots.map((bot) => [bot.id, botLabel(bot, bots)]))
}

/**
 * A list's label for `bot`, or its name read alone where the list drew no label for it — which is what
 * a bot the list never saw reads as, since a host is only ever drawn against a namesake.
 */
export function labelOf(labels: Map<string, string> | undefined, bot: NamedBot) {
  return labels?.get(bot.id) ?? botLabel(bot, [])
}

/**
 * The order every list of bots runs in: by what its rows say, case-blind and with numbers read as
 * numbers, and by id where two rows say the same thing — so a list that is drawn twice keeps one
 * order between them.
 */
export function byBotLabel(labels: Map<string, string> | undefined) {
  return (one: NamedBot, other: NamedBot) =>
    byName(labelOf(labels, one), labelOf(labels, other)) || one.id.localeCompare(other.id)
}
