/**
 * The chat's bot picker, named by the bots' own names: two linked hosts call their default profile
 * "Hermes", so the picker says which host each is only where two namesakes live apart — and a name
 * nobody shares stands alone (`bot-name.ts`, ADR 0149). Its rows run by name, not by the order the
 * bots were linked in.
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

test("two hosts' sealed defaults say which host each is, and a name nobody shares stands alone", async () => {
  const bots = [
    bot("a", "hermes.domain.com"),
    bot("b", "hermes.example.com"),
    bot("c", "notes.third.dev", "/v1", "Notes"),
  ]
  await seed(bots)
  await mount(picker(bots[0]), async () => {
    const pill = () => document.querySelector('button[aria-label^="Bot: "]')
    await until(async () => Boolean(pill()), "the picker's pill")
    assert.equal(
      pill()!.getAttribute("aria-label"),
      "Bot: Hermes (domain)",
      "the pill names the bot, and the host that tells it from its namesake",
    )
    await click(pill())
    await until(
      async () => findAll('[role="menuitemradio"]').length === 3,
      "the picker's three bots",
    )
    assert.deepEqual(
      findAll('[role="menuitemradio"]').map((one) => wordsOf(one)),
      ["Hermes (domain)", "Hermes (example)", "Notes"],
      "the two hosts sharing one name read as their domain parts, a name alone reads bare, and the "
        + "rows run A to Z",
    )
    assert.equal(
      findAll('[role="menuitemradio"]').filter((one) => wordsOf(one) === "Hermes").length,
      0,
      "a name two hosts share is never drawn without the host that tells them apart",
    )
    await settle()
  })
})

test("the rows run by name, and one host's several bots read by their own names", async () => {
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
      ["Hermes (domain)", "Hermes (example)", "work"],
      "the second bot of one host is its own name, and the two sealed defaults still say their hosts",
    )
    await settle()
  })
})

test("a name two bots of one host share is drawn without the host", async () => {
  const bots = [
    bot("a", "hermes.domain.com"),
    bot("b", "hermes.domain.com", "/p/work/v1"),
  ]
  await seed(bots)
  await mount(picker(bots[0]), async () => {
    const pill = () => document.querySelector('button[aria-label^="Bot: "]')
    await until(async () => Boolean(pill()), "the picker's pill")
    await click(pill())
    await until(
      async () => findAll('[role="menuitemradio"]').length === 2,
      "the picker's two bots",
    )
    assert.deepEqual(
      findAll('[role="menuitemradio"]').map((one) => wordsOf(one)),
      ["Hermes", "Hermes"],
      "one host tells the two apart from nothing, so it is not drawn",
    )
    await settle()
  })
})
