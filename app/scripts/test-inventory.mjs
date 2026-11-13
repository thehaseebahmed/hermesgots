/**
 * The inventory and the sweep, driven over a fake store: a listing sorts into the key spaces that
 * survive, an invented one is printed as unrecognised, a sweep deletes only the prefix it was
 * handed, and `--expect-empty` fails while a retired space holds a key. No site, no token and no
 * network — a handle over a Map is all the script is given.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { RETIRED, SPACES, STORES, inventory, parseArgs, run } from "./inventory.mjs"

/** The bytes one stored blob costs, as `--bytes` measures them. */
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

/** The command as an operator runs it: the options parsed, then acted on. */
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

test("nothing is measured unless the listing was, so a count costs no read", () => {
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
