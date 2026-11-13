/**
 * What the blob stores hold, and the sweep that takes a prefix away.
 *
 * Every store the app writes is listed against the table of key spaces that survive, so a removal can
 * be proved rather than believed: a count and a byte total per space, the prefixes it does not
 * recognise, and the four key spaces this plan retires (`--expect-empty` fails while one of them
 * still holds a key). `--sweep <store>/<prefix>` deletes under the prefix it is handed and nothing
 * else, printing each key; `--dry-run` prints them and deletes none.
 *
 * It runs off-platform on a store handle built from NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN, so it
 * needs no deploy. The listing, the sorting and the sweep are pure over the handle they are given,
 * which is what `scripts/test-inventory.mjs` drives over a Map.
 *
 *   NETLIFY_SITE_ID=... NETLIFY_AUTH_TOKEN=... pnpm inventory [--store <name>] [--bytes]
 *   ... pnpm inventory --sweep <store>/<prefix> [--dry-run]
 *   ... pnpm inventory --expect-empty
 */
import { fileURLToPath } from "node:url"

/** The stores the app writes, each one `getStore({ name, consistency: "strong" })` in a function. */
export const STORES = ["gots-sync", "gots-registry", "gots-community", "gots-rankings"]

/**
 * The key spaces that survive, per store, as a pattern over the key's segments: a `<name>` segment
 * is whatever the handler puts there and every other segment is literal. The table names only what
 * survives — the spaces this plan retires are in `RETIRED` below — so "unrecognised" goes on
 * proving that the table and the code agree.
 */
export const SPACES = {
  "gots-sync": ["<userId>/vault", "<userId>/bots", "<userId>/prompts", "<userId>/settings"],
  "gots-registry": [
    "codes/<codeId>",
    "tokens/<sha256>",
    "users/<userId>/hosts/<hostId>",
    "users/<userId>/bots/<botId>",
    "users/<userId>/devices/<deviceId>",
    "users/<userId>/community",
    "community/owners/<login>",
    "community/reports/<userId>/<hostId>",
  ],
  "gots-community": ["users/<login>", "board"],
  "gots-rankings": [],
}

/**
 * The four key spaces this plan retires, and the six patterns they cover: the legacy chat document
 * (`<userId>/chats/<profileId>`), the check-in record (`seen/`), the three throttles (`pushed/`,
 * `tested` and `community/gap/`) and the rankings cache (`overall`). `--expect-empty` reads this
 * list and no other, so a space that only looks retired is still reported as unrecognised.
 */
export const RETIRED = {
  "gots-sync": ["<userId>/chats/<profileId>"],
  "gots-registry": [
    "users/<userId>/seen/<botId>",
    "users/<userId>/pushed/<hostId>",
    "users/<userId>/tested",
    "community/gap/<hostId>",
  ],
  "gots-rankings": ["overall"],
}

const USAGE = `inventory [--store <name>] [--bytes] [--expect-empty]
          inventory --sweep <store>/<prefix> [--dry-run]

  --store <name>         read only this store (${STORES.join(", ")})
  --bytes                measure every blob, one read each, and total it per space
  --sweep <store>/<prefix>  delete every key under the prefix, printing each one
  --dry-run              print what a sweep would delete and delete nothing
  --expect-empty         fail while any of the four retired key spaces holds a key`

/** An option or an environment the script refuses to run without. */
export class UsageError extends Error {}

const PLACEHOLDER = /^<\w+>$/

/** The keys a listing holds, as `{ key, bytes }` — a fixture may hand plain keys, unmeasured. */
function entriesOf(listing) {
  return listing.map((entry) => (typeof entry === "string" ? { key: entry } : entry))
}

/** A key's segments, or null where it is empty or carries an empty one (`a//b`, a trailing `/`). */
function segmentsOf(key) {
  const segments = key.split("/")
  return segments.includes("") ? null : segments
}

/** Whether a key answers to a space's pattern. */
export function inSpace(space, key) {
  const pattern = space.split("/")
  const segments = segmentsOf(key)
  return (
    segments !== null &&
    segments.length === pattern.length &&
    pattern.every((part, index) => PLACEHOLDER.test(part) || part === segments[index])
  )
}

/**
 * The prefix an unrecognised key is reported under: its own directory, or the key itself where it
 * has none. That is what a `--sweep` would name to take the leftover away, and it folds a whole
 * invented space onto one line instead of one line per blob.
 */
export function prefixOf(key) {
  const cut = key.lastIndexOf("/")
  return cut === -1 ? key : key.slice(0, cut + 1)
}

/** The bytes these keys cost, or null where the listing was never measured. */
const sumBytes = (entries, sized) =>
  sized ? entries.reduce((total, entry) => total + entry.bytes, 0) : null

function add(map, name, entry) {
  const held = map.get(name)
  if (held) held.push(entry)
  else map.set(name, [entry])
}

/**
 * One store's listing, sorted into three buckets: the spaces that survive (every one the table
 * names, at zero where the store holds none), the retired spaces that still hold a key, and the
 * prefixes it does not recognise. The last two are only there to report what is left, so an empty
 * one is left out.
 */
export function sortStore(name, listing) {
  const entries = entriesOf(listing)
  // A store is measured or it is not: a half-measured listing would read as a total that isn't one.
  const sized = entries.every((entry) => typeof entry.bytes === "number")
  const surviving = new Map()
  const retired = new Map()
  const unknown = new Map()

  for (const entry of entries) {
    const space = (SPACES[name] ?? []).find((known) => inSpace(known, entry.key))
    if (space) {
      add(surviving, space, entry)
      continue
    }
    const gone = (RETIRED[name] ?? []).find((known) => inSpace(known, entry.key))
    if (gone) {
      add(retired, gone, entry)
      continue
    }
    add(unknown, prefixOf(entry.key), entry)
  }

  const held = (entries) => ({
    count: entries.length,
    bytes: sumBytes(entries, sized),
    keys: entries.map((entry) => entry.key).sort(),
  })

  return {
    name,
    keys: entries.length,
    bytes: sumBytes(entries, sized),
    known: (SPACES[name] ?? []).map((space) => {
      const spaceEntries = surviving.get(space) ?? []
      return { space, count: spaceEntries.length, bytes: sumBytes(spaceEntries, sized) }
    }),
    retired: (RETIRED[name] ?? [])
      .filter((space) => retired.has(space))
      .map((space) => ({ space, ...held(retired.get(space)) })),
    unrecognised: [...unknown]
      .map(([prefix, entries]) => ({ prefix, ...held(entries) }))
      .sort((left, right) => left.prefix.localeCompare(right.prefix)),
  }
}

/**
 * Every store in `listings` sorted, and the retired spaces that still hold a key — the one list
 * `--expect-empty` reads, so a key the plan retires and a key nobody claimed are told apart.
 */
export function inventory(listings) {
  const stores = STORES.filter((name) => name in listings).map((name) =>
    sortStore(name, listings[name]),
  )
  const retired = stores.flatMap((store) =>
    store.retired.map((space) => ({ store: store.name, ...space })),
  )
  return { stores, retired }
}

const count = (number, noun) => `${number} ${noun}${number === 1 ? "" : "s"}`
const measured = (bytes) => (bytes === null ? "" : `, ${bytes} bytes`)

/** The report as the lines an operator reads. */
export function render(report) {
  const lines = []
  for (const store of report.stores) {
    lines.push(`${store.name}: ${count(store.keys, "key")}${measured(store.bytes)}`)
    if (store.known.length === 0) lines.push("  no key space survives in this store")
    for (const space of store.known) {
      lines.push(`  ${space.space}: ${count(space.count, "key")}${measured(space.bytes)}`)
    }
    for (const space of store.retired) {
      lines.push(`  ${space.space}: ${count(space.count, "key")} (retired)`)
      for (const key of space.keys) lines.push(`    ${key}`)
    }
    for (const prefix of store.unrecognised) {
      lines.push(
        `  ${prefix.prefix}: ${count(prefix.count, "key")}${measured(prefix.bytes)} (unrecognised)`,
      )
      for (const key of prefix.keys) lines.push(`    ${key}`)
    }
  }
  return lines
}

/** The store a name means, or a refusal — a typo in `--store` or `--sweep` must not be a guess. */
function storeNamed(name) {
  if (!STORES.includes(name)) {
    throw new UsageError(`unknown store ${name}; one of ${STORES.join(", ")}`)
  }
  return name
}

/** `--sweep`'s `<store>/<prefix>`, with the prefix non-empty: a sweep never takes a whole store. */
function sweepNamed(value) {
  const cut = value.indexOf("/")
  if (cut === -1) throw new UsageError(`--sweep takes <store>/<prefix>, not ${value}`)
  const store = storeNamed(value.slice(0, cut))
  const prefix = value.slice(cut + 1)
  if (prefix === "") {
    throw new UsageError(`--sweep ${store}/ needs a prefix; it never sweeps a whole store`)
  }
  return { store, prefix }
}

/** The options, refused where they would mean guessing. */
export function parseArgs(argv) {
  const args = {
    store: null,
    bytes: false,
    sweep: null,
    dryRun: false,
    expectEmpty: false,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${option} needs a value`)
      }
      index += 1
      return next
    }
    if (option === "--store") args.store = storeNamed(value())
    else if (option === "--sweep") args.sweep = sweepNamed(value())
    else if (option === "--bytes") args.bytes = true
    else if (option === "--dry-run") args.dryRun = true
    else if (option === "--expect-empty") args.expectEmpty = true
    else if (option === "--help" || option === "-h") args.help = true
    else throw new UsageError(`unknown option ${option}`)
  }
  if (args.sweep && args.store && args.store !== args.sweep.store) {
    throw new UsageError(`--store ${args.store} and --sweep ${args.sweep.store} disagree`)
  }
  return args
}

/**
 * Deletes every key under the prefix it is handed, printing each one as it goes, and nothing
 * outside it: the handle's listing is narrowed again here, since a prefix is the only thing a sweep
 * is allowed to act on. A dry run prints the same keys and deletes none.
 */
export async function sweep(handle, prefix, { dryRun = false, out }) {
  const keys = (await handle.list(prefix)).filter((key) => key.startsWith(prefix)).sort()
  for (const key of keys) {
    if (dryRun) {
      out(`would delete ${key}`)
      continue
    }
    await handle.delete(key)
    out(`deleted ${key}`)
  }
  return keys
}

/** One store's keys, each measured only where `--bytes` asked for it — a read per blob otherwise. */
async function listingOf(handle, measure) {
  const entries = []
  for (const key of await handle.list("")) {
    entries.push(measure ? { key, bytes: await handle.bytes(key) } : { key })
  }
  return entries
}

/**
 * The whole run: the sweep first when asked, then the listing of every store in scope, then
 * `--expect-empty`'s verdict. Answers the exit code — 0 for a report, 1 for a retired space that
 * still holds a key, 2 for a refusal.
 */
export async function run(args, handles, out = () => {}) {
  if (args.help) {
    out(USAGE)
    return 0
  }
  // `--expect-empty` speaks for all four retired spaces, so it reads every store whatever is asked.
  const scope = args.expectEmpty ? STORES : args.store ? [args.store] : STORES
  try {
    for (const name of new Set([...scope, ...(args.sweep ? [args.sweep.store] : [])])) {
      if (!handles[name]) throw new UsageError(`no handle for ${name}`)
    }

    if (args.sweep) {
      const keys = await sweep(handles[args.sweep.store], args.sweep.prefix, {
        dryRun: args.dryRun,
        out,
      })
      const swept = `${count(keys.length, "key")} under ${args.sweep.store}/${args.sweep.prefix}`
      out(`${args.dryRun ? "would sweep" : "swept"} ${swept}`)
    }

    const listings = {}
    for (const name of scope) listings[name] = await listingOf(handles[name], args.bytes)
    const report = inventory(listings)
    for (const line of render(report)) out(line)

    if (!args.expectEmpty) return 0
    if (report.retired.length === 0) {
      out("every retired key space is empty")
      return 0
    }
    const left = report.retired.reduce((total, space) => total + space.count, 0)
    const spaces = count(report.retired.length, "retired key space")
    out(`${count(left, "key")} still in ${spaces}: sweep before this ships`)
    return 1
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    out(`inventory: ${err.message}`)
    out(USAGE)
    return 2
  }
}

/**
 * The four stores as handles over `@netlify/blobs`: the site and the token come from the
 * environment, so a run needs no deploy, and `getStore` asks the network nothing until a key is
 * read — which is why all four are built here and `--store` only narrows what is listed.
 */
export async function netlifyHandles(env) {
  const siteID = env.NETLIFY_SITE_ID
  const token = env.NETLIFY_AUTH_TOKEN
  if (!siteID || !token) throw new UsageError("set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN")
  const { getStore } = await import("@netlify/blobs")
  return Object.fromEntries(
    STORES.map((name) => {
      const store = getStore({ name, siteID, token, consistency: "strong" })
      return [
        name,
        {
          async list(prefix) {
            const keys = []
            // A page holds at most 1000 keys: read them all, or a sweep leaves the rest behind.
            for await (const page of store.list({ prefix, paginate: true })) {
              keys.push(...page.blobs.map((blob) => blob.key))
            }
            return keys
          },
          async bytes(key) {
            const body = await store.get(key, { type: "arrayBuffer" })
            return body?.byteLength ?? 0
          },
          async delete(key) {
            await store.delete(key)
          },
        },
      ]
    }),
  )
}

async function main() {
  const argv = process.argv.slice(2)
  let args
  try {
    args = parseArgs(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    console.error(`inventory: ${err.message}`)
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  if (args.help) {
    console.log(USAGE)
    return
  }
  let handles
  try {
    handles = await netlifyHandles(process.env)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    console.error(`inventory: ${err.message}`)
    process.exitCode = 2
    return
  }
  process.exitCode = await run(args, handles, console.log)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 2
  })
}
