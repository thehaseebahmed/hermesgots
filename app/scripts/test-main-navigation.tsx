/**
 * A bot's entry, and where it lands: `/b/<bot>` is a doorway onto the bot's **Main** chat — one
 * permanent conversation per bot, published by the plugin as the record carrying `main` — so Home and
 * the sidebar's row land a reader in a conversation rather than on a list to choose from. The list
 * keeps an address of its own (`/b/<bot>/sidechats`), which is what a chat of the bot's leads back to,
 * and a bot this device holds no Main for yet draws that list where its address stands.
 *
 * Main is not a chat like the others, so its bar is not either (G3, G13): the context ring stands down
 * in favour of the one control that opens the Side Chat List, badged when a side chat is unread and
 * gone where that list is already beside the chat, and the title leads to the bot's settings page
 * rather than opening an Edit sheet. The last cases hold that.
 *
 * The Developer switch turns the app back onto the flat list (ADR 0162): the bot's own address draws
 * every chat of it, a routine's delivery included, and the side-chat address lands there rather than
 * on a list the layout has not got. The case before the sidebar's holds that.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { AppRoutes } from "@/App"
import { ConversationList } from "@/components/conversation-list"
import { db } from "@/lib/db"
import { markRead } from "@/lib/read-marks"

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
  laptop,
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
    assert.equal(
      path(),
      `/b/${bot.id}`,
      "the address the reader gave it: no Main to replace it with",
    )
    assert.ok(
      findText('[data-slot="header-title"]', "Sidechats"),
      "and the list's own bar, not nothing",
    )
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
    assert.ok(
      findText('[data-slot="header-title"]', "Sidechats"),
      "the Side Chat List, not the entry's screen",
    )
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

test("with nothing stored the app draws the new UX", async () => {
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

test("the switch turns on today's flat list, at the bot's own address", async () => {
  // The flat layout is the one screen of every chat the app shipped before a bot opened on a Main
  // (ADR 0162): the bot's address draws it, its routines' deliveries are rows among the chats, and the
  // six pills are back. A chat of it is one step above that list.
  const run = {
    id: "run-bot-1",
    profileId: bot.id,
    title: "Morning watch",
    routine: true,
    line: "The tide turns at 06:40.",
    hermesSessionId: `gots-run-${bot.id}`,
    createdAt: 5,
    updatedAt: 5,
    changedAt: 5,
  }
  await seed([mainRow(), sideRow(), run], { legacyChat: true })
  globalThis.fetch = async () => json({})
  await mount(app(`/b/${bot.id}`), async () => {
    await until(
      async () => Boolean(findText('[data-slot="header-title"]', "Mainly")),
      "the bot's list",
    )
    assert.equal(path(), `/b/${bot.id}`, "the bot's address is its list, not a chat")
    assert.equal(
      findAll('[role="group"][aria-label="Filter chats"] button')
        .map((one) => (one.textContent ?? "").trim())
        .join(" "),
      "All Unread Archived Chats Rooms Routines",
      "the six pills of that list, the routines' one among them",
    )
    assert.ok(
      rowIds().includes(`/c/${run.id}`),
      "and its routines' deliveries are rows of it, which the new UX's list leaves to the page",
    )
    assert.ok(
      rowIds().includes(`/c/${SIDE}`),
      "with Main drawn as one of its rows rather than a screen of its own",
    )
  })
  // A chat of it leads back to that address, which is the list's own under this layout.
  await mount(app(`/c/${SIDE}`), async () => {
    const back = () => find('button[aria-label="Back to Mainly"]')
    await until(async () => Boolean(back()), "the chat's way back")
    await click(back())
    await until(async () => path() === `/b/${bot.id}`, "the list the chat stands in")
  })
  // The new UX's address is no screen under this layout: it lands the list this one draws.
  await mount(app(`/b/${bot.id}/sidechats`), async () => {
    await until(
      async () => path() === `/b/${bot.id}`,
      "the address the flat layout's list stands on",
    )
    await until(
      async () => Boolean(findText('[data-slot="header-title"]', "Mainly")),
      "its one list, drawn there",
    )
  })
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

/**
 * A word the bot said in a chat at `at`: what the row's own clock — the one the unread rule measures
 * — is read from, and the only thing that can light Main's control.
 */
const saidIn = (id: string, at: number) =>
  db.messages.put({
    id: `${id}-said`,
    conversationId: id,
    role: "assistant",
    content: "Said in it",
    status: "done",
    createdAt: at,
  })

/** Main's control in the bar's actions — the place every other chat keeps its context ring in. */
const listButton = () => find('[data-slot="header-actions"] [data-slot="side-chats-button"]')
/** The dot that control wears for a side chat this device has not read. */
const badge = () => find('[data-slot="side-chats-button"] [data-unread]')

test("Main's bar carries the list control in the ring's place, and no context readout", async () => {
  await seed([mainRow(), sideRow()])
  globalThis.fetch = async () => json({})
  await mount(app(`/c/${MAIN}`), async () => {
    await until(async () => Boolean(listButton()), "the control that opens the bot's list")
    assert.equal(
      listButton()?.getAttribute("href"),
      `/b/${bot.id}/sidechats`,
      "one press onto the Side Chat List",
    )
    assert.equal(
      findAll('[data-slot="header-actions"] [aria-label^="Context"]').length,
      0,
      "and no ring, where every other chat keeps one",
    )
    // The ring was the usage sheet's only door, and Main mounts none to be opened.
    assert.ok(missing('[role="dialog"]'), "nothing opens from Main's bar")
    await click(listButton())
    await until(async () => path() === `/b/${bot.id}/sidechats`, "the list the control opens")
  })
})

test("a Main on the current screen draws the same bar: the list in the ring's place", async () => {
  // A bot with an address but no key cannot be called, so its chats open on the current screen rather
  // than chat-next — and that bar must say the same thing about Main as the other one does.
  await seedSettings({ activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put({ ...bot, apiKey: undefined })
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.bulkPut([mainRow(), sideRow()])
  globalThis.fetch = async () => json({})
  await mount(app(`/c/${MAIN}`), async () => {
    await until(async () => Boolean(find("header")), "the chat's bar")
    await until(async () => Boolean(listButton()), "the control that opens the bot's list")
    assert.equal(
      listButton()?.getAttribute("href"),
      `/b/${bot.id}/sidechats`,
      "the same press, on the screen this chat opens on",
    )
    assert.equal(
      findAll('[data-slot="header-actions"] [aria-label^="Context"]').length,
      0,
      "and no ring, as on Main's other bar",
    )
    assert.equal(
      find('[data-slot="header-title"] a')?.getAttribute("href"),
      `/settings/bots/${bot.id}`,
      "with the title leading to the bot's settings page here too",
    )
  })
})

test("Main's control is badged for an unread side chat, and not for a word in Main", async () => {
  const at = Date.now() - 60_000
  await seed([mainRow(), sideRow()])
  // The side chat said something at `at`, and this device had read it before that: one unread side
  // chat, which is what the Side Chat List's own Unread pill would keep.
  await saidIn(SIDE, at)
  markRead(SIDE, at - 1_000)
  globalThis.fetch = async () => json({})
  await mount(app(`/c/${MAIN}`), async () => {
    await until(async () => Boolean(badge()), "the dot for the side chat's word")
    assert.equal(
      find('[data-slot="side-chats-button"]')?.textContent?.includes("Unread side chats"),
      true,
      "and it says so to a reader who cannot see a dot",
    )
  })

  // Main is the bot's own conversation, not a side chat: a word in it is never news this control
  // carries, however little of it this device has read.
  await seed([mainRow()])
  await saidIn(MAIN, Date.now() - 1_000)
  await mount(app(`/c/${MAIN}`), async () => {
    await until(async () => Boolean(listButton()), "Main's control")
    assert.ok(missing('[data-slot="side-chats-button"] [data-unread]'), "no dot for a word in Main")
  })
})

test(
  "at the split width the control is gone: the list already stands beside Main",
  laptop(async () => {
    await seed([mainRow(), sideRow()])
    globalThis.fetch = async () => json({})
    await mount(app(`/c/${MAIN}`), async () => {
      await until(async () => Boolean(find('[data-slot="header-actions"]')), "Main's bar")
      assert.ok(
        missing('[data-slot="side-chats-button"]'),
        "nothing for a control to reveal, so nothing to draw",
      )
      assert.equal(
        findAll('[data-slot="header-actions"] [aria-label^="Context"]').length,
        0,
        "and Main reads no context at this width either",
      )
    })
  }),
)

test("Main's title opens the bot's settings page, and no Edit sheet", async () => {
  await seed([mainRow(), sideRow()])
  globalThis.fetch = async () => json({})
  await mount(app(`/c/${MAIN}`), async () => {
    const title = () => find('[data-slot="header-title"] a')
    await until(async () => Boolean(title()), "Main's title")
    assert.equal(
      title()?.getAttribute("href"),
      `/settings/bots/${bot.id}`,
      "the bot's own page, the way the sidebar's Settings row opens it",
    )
    assert.equal(
      (title()?.textContent ?? "").trim(),
      "Main",
      "over the app's own word for it, never the host's title",
    )
    assert.ok(missing("[data-chat-settings-open]"), "and no press that opens an Edit sheet")
    await click(title())
    await until(async () => path() === `/settings/bots/${bot.id}`, "the settings page")
    assert.ok(missing("[data-chat-name]"), "no sheet came with it")
  })
})
