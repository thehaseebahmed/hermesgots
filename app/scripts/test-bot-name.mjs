/**
 * A bot's label: the name its host gave it, and the host it answers at only where another bot of that
 * name answers somewhere else (ADR 0149).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { botLabel, botLabels, byBotLabel, labelOf } from "../src/lib/bot-name.ts"

/** A bot as a list hands it over: an id, the address it answers at, and the name its host sealed. */
const bot = (id, baseUrl, name = "Hermes") => ({ id, baseUrl, name })

test("a bot alone in a list reads its own name, and no host", () => {
  const one = bot("a", "https://hermes.domain.com/v1", "Studio")
  assert.equal(botLabel(one, [one]), "Studio")
})

test("one name on two hosts says each host, and nothing else is lengthened", () => {
  const three = [
    bot("a", "https://alpha.example.com/v1", "Alpha"),
    bot("b", "https://beta.example.com/v1", "Beta"),
    bot("c", "https://gamma.example.com/v1", "Alpha"),
  ]
  assert.deepEqual(
    three.map((one) => botLabel(one, three)),
    ["Alpha (alpha)", "Beta", "Alpha (gamma)"],
    "a name nobody shares is drawn as it is, which is the whole of the rule",
  )
})

test("one name twice on one host says no host at all", () => {
  const twins = [
    bot("a", "https://hermes.domain.com/v1"),
    bot("b", "https://hermes.domain.com/p/work/v1"),
  ]
  assert.deepEqual(
    twins.map((one) => botLabel(one, twins)),
    ["Hermes", "Hermes"],
    "the host tells the two apart from nothing, so it is not the thing that says which is which",
  )
})

test("two hosts wearing one short name read as their domain parts", () => {
  const pair = [
    bot("a", "https://hermes.domain.co.uk/v1"),
    bot("b", "https://hermes.domain.com/v1"),
  ]
  assert.deepEqual(pair.map((one) => botLabel(one, pair)), ["Hermes (domain.co)", "Hermes (domain)"])
})

test("domain parts long enough to collide still fall back to the whole host", () => {
  const pair = [bot("a", "https://hermes.domain.com/v1"), bot("b", "https://hermes.domain.co/v1")]
  assert.deepEqual(pair.map((one) => botLabel(one, pair)), [
    "Hermes (hermes.domain.com)",
    "Hermes (hermes.domain.co)",
  ])
})

test("names are compared case-blind, so two spellings of one name still say their hosts", () => {
  const pair = [
    bot("a", "https://one.example.com/v1", "Studio"),
    bot("b", "https://two.example.com/v1", "studio"),
  ]
  assert.deepEqual(
    pair.map((one) => botLabel(one, pair)),
    ["Studio (one)", "studio (two)"],
    "each row keeps the spelling its own host sealed",
  )
})

test("a bot with no name is a bot, and a peer with no server makes no namesake", () => {
  const anonymous = bot("a", "https://hermes.domain.com/v1", "   ")
  assert.equal(botLabel(anonymous, [anonymous]), "Bot")
  const unlinked = bot("b", "", "Notes")
  assert.equal(botLabel(unlinked, [unlinked]), "Notes")
  assert.equal(
    botLabel(unlinked, [unlinked, bot("c", "https://hermes.domain.com/v1", "Notes")]),
    "Notes",
    "a peer with no server has no host to draw, so it does not lengthen the one that has one",
  )
})

test("a bare host keeps its port, the only thing telling two of them apart", () => {
  const pair = [bot("a", "http://localhost:8642/v1"), bot("b", "http://localhost:8643/v1")]
  assert.deepEqual(pair.map((one) => botLabel(one, pair)), [
    "Hermes (localhost:8642)",
    "Hermes (localhost:8643)",
  ])
})

test("a base URL with no scheme names its host rather than reading as no host at all", () => {
  const pair = [bot("a", "hermes.domain.com:8642"), bot("b", "hermes.example.com:8642")]
  assert.deepEqual(pair.map((one) => botLabel(one, pair)), ["Hermes (domain)", "Hermes (example)"])
})

test("an address is read whole, port and all", () => {
  const lan = [bot("a", "http://192.168.1.50:8642/v1"), bot("b", "http://192.168.1.51:8642/v1")]
  assert.deepEqual(lan.map((one) => botLabel(one, lan)), [
    "Hermes (192.168.1.50:8642)",
    "Hermes (192.168.1.51:8642)",
  ])
})

test("a list's labels are read once, and a bot the list never saw is read alone", () => {
  const bots = [
    bot("a", "https://alpha.example.com/v1", "Studio"),
    bot("b", "https://beta.example.com/v1", "Studio"),
  ]
  const labels = botLabels(bots)
  assert.equal(labels.get("a"), "Studio (alpha)")
  assert.equal(labels.get("b"), "Studio (beta)")
  assert.equal(
    labelOf(labels, bot("c", "https://gamma.example.com/v1", "Studio")),
    "Studio",
    "no namesake in the list, so nothing to say a host against",
  )
  assert.equal(labelOf(undefined, bots[0]), "Studio", "and a list with no labels at all reads alone")
})

test("a list of bots runs by its labels, case-blind and numeric, ties by id", () => {
  const bots = [
    bot("c", "https://three.example.com/v1", "zulu"),
    bot("d", "https://four.example.com/v1", "session 10"),
    bot("a", "https://one.example.com/v1", "Alpha"),
    bot("b", "https://two.example.com/v1", "session 9"),
  ]
  const labels = botLabels(bots)
  assert.deepEqual(
    [...bots].sort(byBotLabel(labels)).map((one) => one.id),
    ["a", "b", "d", "c"],
    "a number reads as a number, and the case of a name changes nothing",
  )
  const twins = [bot("z", "https://host.example.com/v1"), bot("a", "https://host.example.com/v1")]
  const twinLabels = botLabels(twins)
  assert.deepEqual(
    [...twins].sort(byBotLabel(twinLabels)).map((one) => one.id),
    ["a", "z"],
    "rows that read alike keep one order between them, so no list flickers",
  )
})
