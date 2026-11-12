/**
 * A bot's label: what a list calls a bot, read off the host it answers at rather than the name that
 * host sealed for it. Every default profile is called "Hermes" on its own host, so two linked hosts
 * used to draw two identical rows (`bot-name.ts`).
 */
import assert from "node:assert/strict"
import test from "node:test"

import { botLabel, botLabels, labelOf } from "../src/lib/bot-name.ts"

/** A bot as a list hands it over: an id, the address it answers at, and the name it was sealed with. */
const bot = (id, baseUrl, name = "Hermes") => ({ id, baseUrl, name })

test("a host reads as its short name", () => {
  const hermes = bot("a", "https://hermes.domain.com/v1")
  assert.equal(botLabel(hermes, [hermes]), "hermes")
  const pair = [hermes, bot("b", "https://api.domain.com/v1")]
  assert.deepEqual(
    pair.map((one) => botLabel(one, pair)),
    ["hermes", "api"],
    "two hosts of one domain are told apart by their own names",
  )
})

test("two hosts sharing a short name read as their domain parts", () => {
  const pair = [
    bot("a", "https://hermes.domain.com/v1"),
    bot("b", "https://hermes.example.com/v1"),
  ]
  assert.deepEqual(pair.map((one) => botLabel(one, pair)), ["domain", "example"])
})

test("a domain part long enough to still collide falls back to the whole host", () => {
  const pair = [bot("a", "https://hermes.domain.co.uk/v1"), bot("b", "https://hermes.domain.com/v1")]
  assert.deepEqual(pair.map((one) => botLabel(one, pair)), ["domain.co", "domain"])
  const triple = [...pair, bot("c", "https://hermes.domain.co/v1")]
  assert.deepEqual(
    triple.map((one) => botLabel(one, triple)),
    ["domain.co", "hermes.domain.com", "hermes.domain.co"],
    "the two that collide say their whole host, and one that stands alone keeps its domain part",
  )
})

test("one host's several bots append the profile they are reached at", () => {
  const host = [
    bot("a", "https://hermes.domain.com/v1"),
    bot("b", "https://hermes.domain.com/p/work/v1", "work"),
  ]
  assert.deepEqual(host.map((one) => botLabel(one, host)), ["hermes", "hermes/work"])
  assert.deepEqual(
    host.map((one) => botLabel(one, [...host, bot("c", "https://other.example.com/p/home/v1")])),
    ["hermes", "hermes/work"],
    "another host's profiles change nothing about this one",
  )
})

test("two hosts' profiles read with the domain part and the profile", () => {
  const four = [
    bot("a", "https://hermes.domain.com/v1"),
    bot("b", "https://hermes.domain.com/p/work/v1", "work"),
    bot("c", "https://hermes.example.com/v1"),
    bot("d", "https://hermes.example.com/p/home/v1", "home"),
  ]
  assert.deepEqual(four.map((one) => botLabel(one, four)), [
    "domain",
    "domain/work",
    "example",
    "example/home",
  ])
})

test("the app's own name is never a label", () => {
  const hermes = bot("a", "https://hermes.domain.com/v1", "Hermes")
  assert.equal(botLabel(hermes, [hermes]), "hermes")
})

test("a bot with no server keeps its own name, and one with no name at all is a bot", () => {
  const unlinked = bot("a", "", "Notes")
  assert.equal(botLabel(unlinked, [unlinked]), "Notes")
  const anonymous = bot("b", "   ", "Hermes")
  assert.equal(botLabel(anonymous, [anonymous]), "Bot")
})

test("a bare host keeps its port, the only thing telling two of them apart", () => {
  const pair = [bot("a", "http://localhost:8642/v1"), bot("b", "http://localhost:8643/v1")]
  assert.deepEqual(pair.map((one) => botLabel(one, pair)), [
    "localhost:8642",
    "localhost:8643",
  ])
})

test("a base URL that does not parse is its own host", () => {
  const odd = bot("a", "hermes.local/gateway")
  assert.equal(botLabel(odd, [odd]), "hermes")
})

test("a list's labels are read once, and a bot the list doesn't hold keeps its name", () => {
  const bots = [bot("a", "https://hermes.domain.com/v1"), bot("b", "https://hermes.example.com/v1")]
  const labels = botLabels(bots)
  assert.equal(labels.get("a"), "domain")
  assert.equal(labels.get("b"), "example")
  assert.equal(labelOf(labels, bot("c", "https://third.example.com/v1", "Away")), "Away")
  assert.equal(labelOf(undefined, bots[0]), "Hermes")
})
