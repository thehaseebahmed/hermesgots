/**
 * The inventory and the sweep, driven over a fake store: a listing sorts into the key spaces that
 * survive, an invented one is printed as unrecognised, a sweep deletes only the prefix it was
 * handed, and `--expect-empty` fails while a retired space holds a key. No site, no token and no
 * network — a handle over a Map is all the script is given.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { RETIRED, SPACES, STORES, inventory, listingOf, parseArgs, run, sortStore } from "./inventory.mjs"

/** The bytes one stored blob costs, as the inventory measures them. */
const bodyOf = (key) => `{"key":${JSON.stringify(key)}}`

/** A store as the script reads it, over a Map: the keys under a prefix, one blob's bytes, a delete. */
function memoryStore(keys = []) {
  const data = new Map(keys.map((key) => [key, bodyOf(key)]))
  return {
    data,
    async list(prefix = "") {
      return [...data.keys()].filter((key) => key.startsWith(prefix)).sort()
    },
    async bytes(key) {
      const body = data.get(key)
      if (body === undefined) throw new Error(`no such key: ${key}`)
      return Buffer.byteLength(body)
    },
    async delete(key) {
      data.delete(key)
    },
  }
}

/** Every store the script knows, a Map each, from the keys one test cares about. */
function storesFrom(listings = {}) {
  return Object.fromEntries(STORES.map((name) => [name, memoryStore(listings[name] ?? [])]))
}

const cli = (argv, stores, out = () => {}) => run(parseArgs(argv), stores, out)

/** A listing with one surviving key space, one invented one and one retired one. */
const REGISTRY = [
  "tokens/aaa",
  "users/u1/bots/b1",
  "users/u1/bots/b2",
  "users/u1/labels/l1",
  "users/u1/labels/l2",
  "users/u1/seen/b1",
]

/** The bytes of the REGISTRY fixture: 20 + 26 + 26 + 28 + 28 + 26. */
const REGISTRY_BYTES = 154

function registryReport(listing = REGISTRY) {
  const [store] = inventory({ "gots-registry": listing }).stores
  return store
}

test("the table names every store, and retires the six patterns of the plan's four spaces", () => {
  assert.deepEqual(Object.keys(SPACES).sort(), [...STORES].sort())
  for (const store of Object.keys(RETIRED)) {
    assert.ok(STORES.includes(store), `RETIRED names a store that does not exist: ${store}`)
  }
  // The chats document, the check-in record, the three throttles and the rankings cache.
  assert.deepEqual(
    Object.entries(RETIRED).map(([store, spaces]) => [store, spaces.length]),
    [
      ["gots-sync", 1],
      ["gots-registry", 4],
      ["gots-rankings", 1],
    ],
  )
})

test("a listing sorts into the key spaces that survive, with a count and its bytes", () => {
  const entries = REGISTRY.map((key) => ({ key, bytes: Buffer.byteLength(bodyOf(key)) }))
  const store = registryReport(entries)
  const space = (name) => store.known.find((held) => held.space === name)

  assert.equal(store.name, "gots-registry")
  assert.equal(store.keys, 6)
  assert.equal(store.bytes, REGISTRY_BYTES)
  assert.equal(space("tokens/<sha256>").count, 1)
  assert.equal(space("tokens/<sha256>").bytes, 20)
  assert.equal(space("users/<userId>/bots/<botId>").count, 2)
  assert.equal(space("users/<userId>/bots/<botId>").bytes, 52)
  // A space the store holds none of is still listed, so a surviving key space reads as empty.
  assert.equal(space("codes/<codeId>").count, 0)
  assert.equal(space("community/owners/<login>").count, 0)
})

test("the whole listing is measured by default, so a count comes with its bytes", async () => {
  const stores = storesFrom({ "gots-registry": REGISTRY })
  const lines = []
  assert.equal(await cli([], stores, (line) => lines.push(line)), 0)
  assert.ok(
    lines.includes(`gots-registry: 6 keys, ${REGISTRY_BYTES} bytes`),
    `no measured store line in:\n${lines.join("\n")}`,
  )
})

test("--no-bytes lists the keys and reads no body", async () => {
  const stores = storesFrom({ "gots-registry": REGISTRY })
  let reads = 0
  stores["gots-registry"].bytes = async () => {
    reads += 1
    return 0
  }
  const lines = []
  assert.equal(await cli(["--no-bytes"], stores, (line) => lines.push(line)), 0)
  assert.equal(reads, 0, "the cheap run downloads nothing")
  assert.ok(lines.includes("gots-registry: 6 keys"), lines.join("\n"))
})

test("the listing reads every blob a few at a time, and one it did not read is unmeasured", async () => {
  const keys = Array.from({ length: 20 }, (_, index) => `users/u1/bots/b${index}`)
  let inFlight = 0
  let most = 0
  const handle = {
    async list() {
      return [...keys]
    },
    async bytes(key) {
      inFlight += 1
      most = Math.max(most, inFlight)
      await new Promise((resolve) => setImmediate(resolve))
      inFlight -= 1
      // The last one went between the listing and the read.
      return key === keys.at(-1) ? null : 26
    },
  }
  const entries = await listingOf(handle, true)

  assert.deepEqual(entries.map((entry) => entry.key), keys, "every key is in the listing, in order")
  assert.equal(most, 8, "eight reads at a time, not one after another")
  assert.equal(entries.at(-1).bytes, null, "a body that was not read is not zero bytes")
  assert.equal(sortStore("gots-registry", entries).bytes, null, "so the store reads unmeasured")
})

test("a listing handed without bytes reads unmeasured, not empty", () => {
  const store = registryReport()
  assert.equal(store.bytes, null)
  for (const space of store.known) assert.equal(space.bytes, null)
})

test("exactly the invented prefix is reported as unrecognised, and printed", async () => {
  const store = registryReport()
  assert.deepEqual(
    store.unrecognised.map((prefix) => prefix.prefix),
    ["users/u1/labels/"],
  )
  assert.deepEqual(store.unrecognised[0].keys, ["users/u1/labels/l1", "users/u1/labels/l2"])
  assert.equal(store.unrecognised[0].count, 2)
  // The retired key is not "unrecognised": the script knows the name, and says so instead.
  assert.deepEqual(
    store.retired.map((space) => space.space),
    ["users/<userId>/seen/<botId>"],
  )
  assert.deepEqual(store.retired[0].keys, ["users/u1/seen/b1"])

  const lines = []
  await cli([], storesFrom({ "gots-registry": REGISTRY }), (line) => lines.push(line))
  assert.ok(
    lines.some((line) => line.includes("users/u1/labels/") && line.includes("unrecognised")),
    `no unrecognised line in:\n${lines.join("\n")}`,
  )
})

test("a sweep deletes the keys under the prefix it is given and nothing else", async () => {
  const stores = storesFrom({
    "gots-registry": [
      "users/u1/seen/b1",
      "users/u1/seen/b2",
      "users/u1/seen-archive/b1",
      "users/u1/bots/b1",
    ],
  })
  const lines = []
  const code = await cli(["--sweep", "gots-registry/users/u1/seen/"], stores, (line) => lines.push(line))

  assert.equal(code, 0)
  assert.deepEqual([...stores["gots-registry"].data.keys()].sort(), [
    "users/u1/bots/b1",
    "users/u1/seen-archive/b1",
  ])
  assert.deepEqual(
    lines.filter((line) => line.startsWith("deleted ")),
    ["deleted users/u1/seen/b1", "deleted users/u1/seen/b2"],
  )
})

test("a dry run prints every key it would delete and deletes none", async () => {
  const stores = storesFrom({ "gots-registry": ["users/u1/seen/b1", "users/u1/seen/b2"] })
  const lines = []
  const code = await cli(
    ["--sweep", "gots-registry/users/u1/seen/", "--dry-run"],
    stores,
    (line) => lines.push(line),
  )

  assert.equal(code, 0)
  assert.equal(stores["gots-registry"].data.size, 2)
  assert.deepEqual(
    lines.filter((line) => line.startsWith("would delete ")),
    ["would delete users/u1/seen/b1", "would delete users/u1/seen/b2"],
  )
})

test("a sweep names a store and a prefix, or it deletes nothing at all", async () => {
  const stores = storesFrom({ "gots-registry": ["users/u1/seen/b1"] })
  for (const argv of [
    ["--sweep", "gots-registry/"],
    ["--sweep", "gots-registry"],
    ["--sweep", "gots-nope/users/"],
  ]) {
    assert.throws(() => parseArgs(argv), /sweep|store|prefix/, argv.join(" "))
  }
  assert.equal(stores["gots-registry"].data.size, 1)
})

test("--expect-empty fails while a retired key space holds a key", async () => {
  const holding = storesFrom({ "gots-registry": ["users/u1/seen/b1"] })
  const lines = []
  assert.equal(await cli(["--expect-empty"], holding, (line) => lines.push(line)), 1)
  assert.ok(
    lines.some((line) => line.includes("users/u1/seen/b1")),
    `the key it refuses on is not named in:\n${lines.join("\n")}`,
  )

  const empty = storesFrom({ "gots-registry": ["users/u1/bots/b1"], "gots-sync": ["u1/vault"] })
  assert.equal(await cli(["--expect-empty"], empty), 0)
})

test("--store reads the store it names and leaves the rest unread", async () => {
  const stores = storesFrom({ "gots-sync": ["u1/vault"], "gots-registry": ["tokens/aaa"] })
  const lines = []
  assert.equal(await cli(["--store", "gots-sync"], stores, (line) => lines.push(line)), 0)
  assert.ok(lines.some((line) => line.startsWith("gots-sync")))
  assert.ok(!lines.some((line) => line.startsWith("gots-registry")), lines.join("\n"))
  assert.throws(() => parseArgs(["--store", "gots-everything"]), /gots-everything/)
})
