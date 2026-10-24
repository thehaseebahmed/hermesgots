/**
 * The Cheatsheet's way in: `/cheatsheet` in the composer's slash menu, picked the way a keyboard
 * picks it, over a seeded device database and the real chat route. The branch it drives is the one
 * whose fall-through opens Settings, so a missed branch fails here rather than in a demo.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatPage } from "@/routes/chat"
import { db, saveAppearance, type Settings } from "@/lib/db"
import {
  botProfile,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  type,
  until,
} from "./component-kit.tsx"

const CHAT = "cheat-1"
const bot = botProfile("cheatsheet", { id: "bot-1", name: "Cheatsy" })

async function seed(patch: Partial<Omit<Settings, "id">> = {}) {
  await seedSettings({ activeProfileId: bot.id, ...patch })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put({
    id: CHAT,
    profileId: bot.id,
    title: "A chat",
    hermesSessionId: `${CHAT}-hermes`,
    createdAt: 1,
    updatedAt: 1,
    changedAt: 1,
  })
}

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

const screen = (
  <MemoryRouter initialEntries={[`/c/${CHAT}`]}>
    <Routes>
      <Route path="c/:id" element={<ChatPage />} />
    </Routes>
  </MemoryRouter>
)

const field = () => find('textarea[aria-label="Message"]') as HTMLTextAreaElement | null
const options = () => findAll('[role="option"]').map((row) => row.textContent ?? "")
const offered = (name: string) => options().some((row) => row.startsWith(name))

async function enter() {
  await act(async () => {
    field()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    )
  })
  await settle()
}

/** The open sheet: a pop-up's last dialog, which is the one on top. */
const sheet = () => findAll('[role="dialog"]').at(-1) ?? null
const groups = () => findAll("[data-group]").map((one) => one.getAttribute("data-group"))

/** The sheet as the slash menu opens it: the command typed, then Enter. */
async function openSheet() {
  await type(field(), "/cheatsheet")
  await until(async () => offered("/cheatsheet"), "the command in the menu")
  await enter()
  await until(async () => Boolean(sheet()), "the sheet")
}

/** The sheet's own way out — an Escape the pop-up takes — so a reopening starts from shut. */
async function shutSheet() {
  await act(async () => {
    sheet()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    )
  })
  await until(async () => !sheet(), "the sheet shut")
}

/** The switch as the device holds it, which an opening must leave alone. */
const storedSwitch = async () => (await db.settings.get("settings"))?.navShortcuts

/** What this page kept in localStorage, key by key, to compare before and after. */
const stored = () =>
  Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)]))

test("the menu offers /cheatsheet as a command, beside the others", async () => {
  await seed()
  host()
  await mount(screen, async () => {
    await until(async () => Boolean(field()), "the composer")
    await type(field(), "/")
    await until(async () => options().length > 0, "the command menu")
    assert.ok(offered("/cheatsheet"), "the command is on offer")
    const row = findAll('[role="option"]').find((one) =>
      (one.textContent ?? "").startsWith("/cheatsheet"),
    )
    assert.ok(
      row?.querySelector("svg"),
      "the row carries an icon, as every command's does",
    )
  })
})

test("picking /cheatsheet opens the sheet with its groups and rows, and sends nothing", async () => {
  await seed()
  const seen = host()
  await mount(screen, async () => {
    await until(async () => Boolean(field()), "the composer")
    await type(field(), "/cheatsheet")
    await until(async () => offered("/cheatsheet"), "the command in the menu")
    await enter()
    await until(async () => Boolean(sheet()), "the sheet")
    assert.match(sheet()?.textContent ?? "", /Cheatsheet/, "titled")
    assert.deepEqual(
      groups(),
      ["Composer", "Slash menu", "Chat", "While something's open"],
      "its groups, in order, with no gated one by default",
    )
    const rows = sheet()?.textContent ?? ""
    for (const row of [
      "Send the message",
      "Start a new line",
      "Clear the message, keeping attachments",
      "Move through the menu",
      "Pick the highlighted row",
      "Close the menu",
      "Stop a running reply",
      "Step through the attachments",
      "Cancel the recording",
    ])
      assert.ok(rows.includes(row), `the sheet says ${row}`)
    for (const key of [
      "Enter",
      "Shift+Enter",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "Tab",
      "Ctrl+C",
      "ArrowLeft",
      "ArrowRight",
    ])
      assert.ok(rows.includes(key), `the sheet names ${key}`)
    assert.equal(field()?.value, "", "the pick cleared the composer")
    assert.ok(field(), "the chat is still on screen: the branch didn't fall through to Settings")
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
  await mount(screen, async () => {
    await until(async () => Boolean(field()), "the composer")
    assert.equal(await storedSwitch(), false, "the switch starts off, as it ships")
    await openSheet()
    assert.ok(!groups().includes("Navigation"), "no Navigation group, empty heading nor row")
    assert.deepEqual(groups(), ["Composer", "Slash menu", "Chat", "While something's open"])
    assert.ok(!(sheet()?.textContent ?? "").includes("Alt+1…9"), "and no key for a dead binding")
  })
})

test("with navigation shortcuts on, the sheet opened afterwards names Alt+1…9", async () => {
  await seed({ navShortcuts: true })
  host()
  await mount(screen, async () => {
    await until(async () => Boolean(field()), "the composer")
    await openSheet()
    assert.deepEqual(groups(), [
      "Composer",
      "Slash menu",
      "Chat",
      "Navigation",
      "While something's open",
    ])
    const rows = sheet()?.textContent ?? ""
    assert.ok(rows.includes("Alt+1…9"), "the keys it takes")
    assert.ok(rows.includes("Switch to another bot"), "and what they do")
  })
})

test("a switch flipped while the sheet was shut shows the next time it opens", async () => {
  await seed()
  host()
  await mount(screen, async () => {
    await until(async () => Boolean(field()), "the composer")
    await openSheet()
    assert.ok(!groups().includes("Navigation"), "absent as it opened, the switch being off")
    await shutSheet()

    await act(async () => {
      await saveAppearance({ navShortcuts: true })
    })
    await openSheet()
    assert.ok(groups().includes("Navigation"), "the group the reopened sheet reads")

    await shutSheet()
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
  await mount(screen, async () => {
    await until(async () => Boolean(field()), "the composer")
    db.settings.get = (() => Promise.reject(new Error("the device is gone"))) as typeof db.settings.get
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
  await mount(screen, async () => {
    await until(async () => Boolean(field()), "the composer")
    const settingsBefore = await db.settings.get("settings")
    const storageBefore = stored()
    await openSheet()
    assert.equal(settingsBefore?.navShortcuts, true, "the seeded switch it reads")
    assert.deepEqual(
      await db.settings.get("settings"),
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
