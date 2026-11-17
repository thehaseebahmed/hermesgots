/**
 * A bot's entry, and where it lands: `/b/<bot>` is a doorway onto the bot's **Main** chat — one
 * permanent conversation per bot, published by the plugin as the record carrying `main` — so Home and
 * the sidebar's row land a reader in a conversation rather than on a list to choose from. The list
 * keeps an address of its own (`/b/<bot>/sidechats`), which is what a chat of the bot's leads back to,
 * and a bot this device holds no Main for yet draws that list where its address stands.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { AppRoutes } from "@/App"
import { ConversationList } from "@/components/conversation-list"
import { db } from "@/lib/db"

import {
  Nav,
  Path,
  atWidth,
  botProfile,
  click,
  composerField,
  find,
  findAll,
  findText,
  json,
  missing,
  mount,
  nav,
  path,
  seedSettings,
  until,
} from "./component-kit.tsx"

const bot = botProfile("bot-main", { id: "bot-1", name: "Mainly" })
const MAIN = "main-bot-1"
/** A chat of the bot's that is not its Main: what a row of the list opens. */
const SIDE = "side-bot-1"

/**
 * The bot's Main, as a device already holds it: the flag is the plugin's and the title is the host's,
 * which no screen draws (Main is the app's own word for it).
 */
const mainRow = () => ({
  id: MAIN,
  profileId: bot.id,
  title: "Bot Chat",
  main: true,
  hermesSessionId: `gots-${MAIN}`,
  createdAt: 10,
  updatedAt: 10,
  changedAt: 0,
})

/** A chat beside Main, said in, so it is a row of the list. */
const sideRow = () => ({
  id: SIDE,
  profileId: bot.id,
  title: "A side chat",
  hermesSessionId: `gots-${SIDE}`,
  createdAt: 20,
  updatedAt: 30,
  changedAt: 30,
})

async function seed(
  rows: ReturnType<typeof mainRow>[] = [],
  patch: { developer?: boolean; legacyChat?: boolean; meetings?: boolean; canvas?: boolean } = {},
) {
  await seedSettings({
    activeProfileId: bot.id,
    ...patch,
  })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  if (rows.length) await db.conversations.bulkPut(rows)
}

/** The app's own screens at an address: the route table and the shell this step changes. */
const app = (at: string) => (
  <MemoryRouter initialEntries={[at]}>
    <Path />
    <Nav />
    <AppRoutes />
  </MemoryRouter>
)

/** The chats a list draws, by the address each row leads to. */
const rowIds = () => findAll('ul a[href^="/c/"]').map((row) => row.getAttribute("href") ?? "")

test("a bot's address is its Main chat, in place of the entry it opened", async () => {
  await seed([mainRow(), sideRow()])
  globalThis.fetch = async () => json({})
  await mount(app(`/b/${bot.id}`), async () => {
    await until(async () => path() === `/c/${MAIN}`, "the bot's Main")
    assert.equal(
      nav(),
      `REPLACE:/c/${MAIN}`,
      "the chat's own address taken in the bot's place, so back from Main is the app",
    )
  })
})

test("Home lands on the bot's Main chat", async () => {
  await seed([mainRow(), sideRow()])
  globalThis.fetch = async () => json({})
  await mount(app("/"), async () => {
    await until(async () => path() === `/c/${MAIN}`, "the active bot's Main")
    assert.equal(nav(), `REPLACE:/c/${MAIN}`, "and `/` is replaced by it rather than left behind")
  })
})

test(
  "the sidebar's bot row lands on the bot's Main chat",
  atWidth(1024, async () => {
    await seed([mainRow(), sideRow()])
    globalThis.fetch = async () => json({})
    await mount(app(`/c/${SIDE}`), async () => {
      const row = () => find(`aside a[href="/b/${bot.id}"]`)
      await until(async () => Boolean(row()), "the bot's row in the sidebar")
      await click(row())
      await until(async () => path() === `/c/${MAIN}`, "the bot's Main")
      assert.equal(nav(), `REPLACE:/c/${MAIN}`, "the chat in the bot's place, as Home lands too")
    })
  }),
)

test("a bot with no Main yet draws its list where its address stands", async () => {
  // A device that has never met a plugin publishing one: there is no chat to land on, and the list is
  // what the reader gets rather than a blank screen.
  await seed([sideRow()])
  globalThis.fetch = async () => json({})
  await mount(app(`/b/${bot.id}`), async () => {
    await until(async () => rowIds().includes(`/c/${SIDE}`), "the bot's chats")
    assert.equal(path(), `/b/${bot.id}`, "the address the reader gave it: no Main to replace it with")
    assert.ok(findText('[data-slot="header-title"]', "Sidechats"), "and the list's own bar, not nothing")
    assert.ok(findText('[data-slot="header-line"]', "Mainly"), "naming the bot it is a list of")
    assert.equal(
      await db.conversations.filter((chat) => Boolean(chat.main)).count(),
      0,
      "the app mints no Main of its own: the plugin is Main's only writer",
    )
  })
})

test("the bot's list keeps an address of its own", async () => {
  await seed([mainRow(), sideRow()])
  globalThis.fetch = async () => json({})
  await mount(app(`/b/${bot.id}/sidechats`), async () => {
    await until(async () => rowIds().includes(`/c/${SIDE}`), "the bot's chats")
    assert.equal(path(), `/b/${bot.id}/sidechats`, "the list at its own address, Main known or not")
    // Main is the screen this list is of, not a row of it: `test-side-chats.tsx` holds the row it is
    // given at the split width, where it is the chat drawn beside the list.
    assert.ok(findText('[data-slot="header-title"]', "Sidechats"), "the Side Chat List, not the entry's screen")
  })
})

test("a chat leads back to its own layout's list", async () => {
  await seed([mainRow(), sideRow()])
  globalThis.fetch = async () => json({})
  await mount(app(`/c/${SIDE}`), async () => {
    const back = () => find('button[aria-label="Back to Mainly"]')
    await until(async () => Boolean(back()), "the chat's way back")
    await click(back())
    await until(async () => path() === `/b/${bot.id}/sidechats`, "the list the chat stands in")
    assert.equal(
      nav(),
      `REPLACE:/b/${bot.id}/sidechats`,
      "stepped onto where nothing opened the chat, rather than leaving the app",
    )
  })
})

test("Main is where a bot opens, so nothing leads back from it", async () => {
  await seed([mainRow(), sideRow()])
  globalThis.fetch = async () => json({})
  await mount(app(`/c/${MAIN}`), async () => {
    await until(async () => Boolean(find("header")), "the chat's bar")
    assert.equal(
      missing('button[aria-label="Back to Mainly"]'),
      true,
      "no way back on a screen that is the bot's entry",
    )
    assert.ok(
      find('button[aria-label="Open conversations"]'),
      "the drawer stands where the way back would, as on any top-level screen",
    )
  })
})

test("with nothing stored the app is the bot-first layout", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(app("/"), async () => {
    await until(async () => path() === `/b/${bot.id}`, "the bot's own address")
    assert.equal(
      await db.conversations.count(),
      0,
      "a bot with nothing to open draws its list rather than making a chat for it",
    )
  })
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(
        async () => findAll("a").some((row) => row.getAttribute("href") === `/b/${bot.id}`),
        "the bot row",
      )
      assert.ok(!findText("button", "New chat"), "no New chat button beside the bots")
    },
  )
})

test("a chat open writes no memory", async () => {
  await seed([mainRow()])
  localStorage.removeItem("gots:last-chat")
  globalThis.fetch = async () => json({})
  await mount(app(`/c/${MAIN}`), async () => {
    await until(async () => Boolean(composerField()) || Boolean(find("header")), "the chat")
    assert.equal(
      localStorage.getItem("gots:last-chat"),
      null,
      "a chat open remembers nothing as the conversation the app was last left in",
    )
  })
})

test("the legacy switch brings the Recents list and the New chat button back", async () => {
  await seed([], { legacyChat: true })
  globalThis.fetch = async () => json({})
  await mount(app("/"), async () => {
    assert.equal(path(), "/", "home is the new-chat screen again")
  })
  await mount(app(`/b/${bot.id}`), async () => {
    assert.equal(path(), "/", "and a bot's entry falls back home: that layout draws no bot's screen")
    assert.equal(await db.conversations.count(), 0, "no Main")
  })
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(findText("button", "New chat")), "the New chat button")
      assert.equal(
        findAll("a").some((row) => row.getAttribute("href") === `/c/${MAIN}`),
        false,
        "nothing opens a bot's Main: the list is Recents",
      )
    },
  )
})

test("the sidebar's Canvas row follows its Labs switch", async () => {
  await seed([], { canvas: false })
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(find('a[href="/research"]')), "the nav")
      assert.equal(Boolean(find('a[href="/canvas"]')), false, "Canvas is off, so no row")
    },
  )
  await seed()
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(find('a[href="/canvas"]')), "the Canvas row")
      assert.equal(
        find('a[href="/canvas"]')?.textContent?.includes("Labs"),
        true,
        "on by default, and wearing the pill",
      )
    },
  )
})

test("the sidebar marks the lab features with the pill, and its own screens with none", async () => {
  await seed([], { meetings: true })
  globalThis.fetch = async () => json({})
  await mount(
    <MemoryRouter initialEntries={["/"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      const row = (href: string) => find(`a[href="${href}"]`)
      await until(async () => Boolean(row("/meetings")), "the Meetings row")
      for (const href of ["/canvas", "/meetings"]) {
        const mark = row(href)
        assert.ok(mark, `${href} is drawn`)
        assert.equal(mark.textContent?.includes("Labs"), true, `${href} wears the pill`)
      }
      for (const href of ["/projects", "/code", "/research"]) {
        const own = row(href)
        assert.ok(own, `${href} is drawn`)
        assert.equal(own.textContent?.includes("Labs"), false, `${href} is no lab feature`)
      }
    },
  )
})
