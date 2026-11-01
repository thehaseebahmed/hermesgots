/** The Cheatsheet's way in: `/cheatsheet` picked by a keyboard, over the real chat route. */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { db, getSettings, saveAppearance, type Settings } from "@/lib/db"
import {
  botProfile,
  chatScreen,
  composerField,
  findAll,
  json,
  mount,
  offersCommand,
  pickPress,
  seedChat,
  shutSheet,
  slashOptions,
  type,
  until,
} from "./component-kit.tsx"

const CHAT = "cheat-1"
const bot = botProfile("cheatsheet", { id: "bot-1", name: "Cheatsy" })
const OFF = ["Composer", "Slash menu", "Chat", "While something's open"]
const ON = ["Composer", "Slash menu", "Chat", "Navigation", "While something's open"]

const seed = (patch: Partial<Omit<Settings, "id">> = {}) =>
  seedChat({ id: CHAT, profile: bot, settings: { activeProfileId: bot.id, ...patch } })

/** The HTTP boundary, faked: every request and body kept, so a message can't slip past unseen. */
function host() {
  const seen: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.host.startsWith("cheatsheet")) return json({})
    seen.push(
      `${init?.method ?? "GET"} ${url.pathname}${url.search}${
        typeof init?.body === "string" ? ` ${init.body}` : ""
      }`,
    )
    if (url.pathname.endsWith("/skills")) return json({ object: "list", data: [] })
    return json({})
  }) as typeof fetch
  return seen
}

/** The open sheet: a pop-up's last dialog, which is the one on top. */
const sheet = () => findAll('[role="dialog"]').at(-1) ?? null
const groups = () => findAll("[data-group]").map((one) => one.getAttribute("data-group"))
const drawn = () =>
  findAll("[data-group]").map((section) => ({
    name: section.getAttribute("data-group") ?? "",
    rows: [...section.querySelectorAll("dl > div")].map((row) => ({
      keys: [...row.querySelectorAll("kbd")].map((chip) => chip.textContent ?? ""),
      description: row.querySelector("dt")?.textContent ?? "",
    })),
  }))

async function openSheet() {
  await type(composerField(), "/cheatsheet")
  await until(async () => offersCommand("/cheatsheet"), "the command in the menu")
  await pickPress()
  await until(async () => Boolean(sheet()), "the sheet")
}

const composerRows = () => drawn().find((one) => one.name === "Composer")?.rows ?? []

const storedSwitch = async () => (await getSettings()).navShortcuts

const stored = () =>
  Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]))

test("the menu offers /cheatsheet as a command, beside the others", async () => {
  await seed()
  host()
  await mount(chatScreen(CHAT), async () => {
    await until(async () => Boolean(composerField()), "the composer")
    await type(composerField(), "/")
    await until(async () => slashOptions().length > 0, "the command menu")
    assert.ok(offersCommand("/cheatsheet"), "the command is on offer")
    const row = findAll('[role="option"]').find((one) =>
      (one.textContent ?? "").startsWith("/cheatsheet"),
    )
    assert.ok(row?.querySelector("svg"), "the row carries an icon, as every command's does")
  })
})

test("picking /cheatsheet opens the sheet with its groups and rows, and sends nothing", async () => {
  await seed()
  const seen = host()
  await mount(chatScreen(CHAT), async () => {
    await until(async () => Boolean(composerField()), "the composer")
    await openSheet()
    assert.match(sheet()?.textContent ?? "", /Cheatsheet/, "titled")
    assert.deepEqual(groups(), OFF, "its groups, in order, with no gated one by default")
    // Literal rows, never a comparison against `cheatsheetGroups`: a case that asks the function it
    // is testing what to expect stays green when that function changes.
    assert.deepEqual(
      composerRows().map((row) => [row.keys.join("+"), row.description]),
      [
        ["Enter", "Start a new line"],
        ["Ctrl+Enter", "Send the message"],
        ["Escape+Escape", "Clear the message, keeping attachments"],
      ],
      "Enter is the line, the chord sends, and Shift's row would only repeat Enter's",
    )
    assert.equal(composerField()?.value, "", "the pick cleared the composer")
    assert.ok(
      composerField(),
      "the chat is still on screen: the branch didn't fall through to Settings",
    )
    assert.deepEqual(
      seen.filter((request) => /cheatsheet/i.test(request)),
      [],
      "the command never reached the host",
    )
  })
})

test("with navigation shortcuts off, the sheet has no Navigation group at all", async () => {
  await seed()
  host()
  await mount(chatScreen(CHAT), async () => {
    await until(async () => Boolean(composerField()), "the composer")
    assert.equal(await storedSwitch(), false, "the switch starts off, as it ships")
    await openSheet()
    assert.ok(!groups().includes("Navigation"), "no Navigation group, empty heading nor row")
    assert.deepEqual(groups(), OFF)
    assert.ok(!(sheet()?.textContent ?? "").includes("Alt+1…9"), "and no key for a dead binding")
  })
})

test("with navigation shortcuts on, the sheet opened afterwards names Alt+1…9", async () => {
  await seed({ navShortcuts: true })
  host()
  await mount(chatScreen(CHAT), async () => {
    await until(async () => Boolean(composerField()), "the composer")
    await openSheet()
    assert.ok(groups().includes("Navigation"), "the gated group, the switch being on")
    assert.deepEqual(groups(), ON)
    assert.deepEqual(
      composerRows().map((row) => row.keys.join("+")),
      ["Enter", "Ctrl+Enter", "Escape+Escape"],
      "the composer's rows are the switch's, not the navigation one's",
    )
    assert.ok((sheet()?.textContent ?? "").includes("Alt+1…9"), "the keys it takes")
  })
})

test("with Send on Enter on, the sheet gives Enter back to the send", async () => {
  await seed({ sendOnEnter: true })
  host()
  await mount(chatScreen(CHAT), async () => {
    await until(async () => Boolean(composerField()), "the composer")
    await openSheet()
    assert.equal(
      await getSettings().then((one) => one.sendOnEnter),
      true,
      "the switch the sheet read",
    )
    assert.deepEqual(
      composerRows().map((row) => [row.keys.join("+"), row.description]),
      [
        ["Enter", "Send the message"],
        ["Shift+Enter", "Start a new line"],
        ["Ctrl+Enter", "Send the message"],
        ["Escape+Escape", "Clear the message, keeping attachments"],
      ],
      "Enter sends, Shift is the line, and the chord keeps its row, which sends either way",
    )
  })
})

test("a switch flipped while the sheet was shut shows the next time it opens", async () => {
  await seed()
  host()
  await mount(chatScreen(CHAT), async () => {
    await until(async () => Boolean(composerField()), "the composer")
    await openSheet()
    assert.ok(!groups().includes("Navigation"), "absent as it opened, the switch being off")
    await shutSheet(sheet)

    await act(async () => {
      await saveAppearance({ navShortcuts: true })
    })
    await openSheet()
    assert.ok(groups().includes("Navigation"), "the group the reopened sheet reads")

    await shutSheet(sheet)
    await act(async () => {
      await saveAppearance({ navShortcuts: false })
    })
    await openSheet()
    assert.ok(!groups().includes("Navigation"), "off again: the next opening reads it afresh")
  })
})

test("a sheet whose settings read fails still opens, with the switch as it ships", async () => {
  await seed({ navShortcuts: true })
  host()
  const read = db.settings.get.bind(db.settings)
  await mount(chatScreen(CHAT), async () => {
    await until(async () => Boolean(composerField()), "the composer")
    db.settings.get = (() =>
      Promise.reject(new Error("the device is gone"))) as typeof db.settings.get
    try {
      await openSheet()
      assert.ok(sheet(), "the sheet is up anyway")
      assert.ok(!groups().includes("Navigation"), "and says only what it can stand behind")
    } finally {
      db.settings.get = read
    }
  })
})

test("opening the sheet writes nothing to settings or the page's storage", async () => {
  await seed({ navShortcuts: true })
  const seen = host()
  await mount(chatScreen(CHAT), async () => {
    await until(async () => Boolean(composerField()), "the composer")
    const settingsBefore = await getSettings()
    const storageBefore = stored()
    await openSheet()
    assert.equal(settingsBefore.navShortcuts, true, "the seeded switch it reads")
    assert.deepEqual(
      await getSettings(),
      settingsBefore,
      "the settings row is untouched, so nothing was written back",
    )
    assert.deepEqual(stored(), storageBefore, "and the page kept nothing new")
    assert.deepEqual(
      seen.filter((request) => !request.startsWith("GET ")),
      [],
      "the host was sent nothing either",
    )
  })
})
