/**
 * The chat's bot picker, named by the host each bot answers at: two linked hosts call their default
 * profile "Hermes", so the picker drew two identical rows (`bot-name.ts`, ADR 0148). The rows are the
 * hosts' short names, the domain part where two hosts share one, and the Hermes profile where one
 * host holds several bots.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { BotPicker } from "@/components/chat/bot-picker"
import { db } from "@/lib/db"

import {
  botProfile,
  click,
  findAll,
  mount,
  seedSettings,
  settle,
  until,
  wordsOf,
} from "./component-kit.tsx"

const bot = (id: string, host: string, path = "/v1", name = "Hermes") =>
  botProfile(host, { id, name, baseUrl: `https://${host}${path}` })

/** The device holds these bots, turned on, with the first of them the account's active one. */
async function seed(bots: ReturnType<typeof bot>[]) {
  await seedSettings({ activeProfileId: bots[0].id })
  await db.profiles.clear()
  await db.profiles.bulkPut(bots)
}

const picker = (one: ReturnType<typeof bot>) => <BotPicker profile={one} />

test("two hosts' default profiles read as their hosts, not as the name both were sealed with", async () => {
  const bots = [
    bot("a", "hermes.domain.com"),
    bot("b", "hermes.example.com"),
    bot("c", "notes.third.dev"),
  ]
  await seed(bots)
  await mount(picker(bots[0]), async () => {
    const pill = () => document.querySelector('button[aria-label^="Bot: "]')
    await until(async () => Boolean(pill()), "the picker's pill")
    assert.equal(
      pill()!.getAttribute("aria-label"),
      "Bot: domain",
      "the pill names the host its bot answers at",
    )
    await click(pill())
    await until(
      async () => findAll('[role="menuitemradio"]').length === 3,
      "the picker's three bots",
    )
    assert.deepEqual(
      findAll('[role="menuitemradio"]').map((one) => wordsOf(one)),
      ["domain", "example", "notes"],
      "the two hosts sharing a short name read as their domain parts, and one alone as its own name",
    )
    assert.equal(
      findAll('[role="menuitemradio"]').filter((one) => wordsOf(one) === "Hermes").length,
      0,
      "and the app's own name is in none of them",
    )
    await settle()
  })
})

test("one host's several bots append the profile they are reached at", async () => {
  const bots = [
    bot("a", "hermes.domain.com"),
    bot("b", "hermes.domain.com", "/p/work/v1", "work"),
    bot("c", "hermes.example.com"),
  ]
  await seed(bots)
  await mount(picker(bots[0]), async () => {
    const pill = () => document.querySelector('button[aria-label^="Bot: "]')
    await until(async () => Boolean(pill()), "the picker's pill")
    await click(pill())
    await until(
      async () => findAll('[role="menuitemradio"]').length === 3,
      "the picker's three bots",
    )
    assert.deepEqual(
      findAll('[role="menuitemradio"]').map((one) => wordsOf(one)),
      ["domain", "domain/work", "example"],
      "the host holding two bots tells them apart by the profile each is reached at",
    )
    await settle()
  })
})
