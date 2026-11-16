/**
 * A bot's own chat: its bar carries neither a way to its bot's list nor a `…`, and the press its
 * title answers opens the chat's settings — its name, its mute, its pin, its archive and its delete,
 * which the menu that stood there held (ADR 0153).
 *
 * A project session is not a chat's settings: it keeps the menu, whose resolve, discard and delete
 * are its own. That is what the last case holds.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { ChatPage } from "@/routes/chat"
import { setArchived, setPinned } from "@/lib/chat-marks"
import { db, type Conversation } from "@/lib/db"
import {
  absentText,
  atWidth,
  botProfile,
  click,
  find,
  findAll,
  findText,
  json,
  missing,
  mount,
  Path,
  path,
  seedSettings,
  settle,
  until,
} from "./component-kit.tsx"

const bot = botProfile("chat-settings", { id: "bot-settings", name: "Settler" })
const CHAT = "c-settings"
const SESSION = "c-session"

const chatRow = (patch: Partial<Conversation> = {}): Conversation =>
  ({
    id: CHAT,
    profileId: bot.id,
    title: "A chat of the bot's",
    hermesSessionId: SESSION,
    createdAt: 10,
    updatedAt: 10,
    changedAt: 10,
    ...patch,
  }) as Conversation

async function seed(patch: Partial<Conversation> = {}) {
  localStorage.clear()
  await seedSettings({ developer: true, activeProfileId: bot.id })
  await db.profiles.clear()
  await db.profiles.put(bot)
  await db.messages.clear()
  await db.conversations.clear()
  await db.conversations.put(chatRow(patch))
}

/**
 * The same bot, already holding `count` pins besides this chat — the cap is counted over the list the
 * chat is drawn in, so the pins have to be rows of it.
 */
async function seedPins(count: number, patch: Partial<Conversation> = {}) {
  await seed(patch)
  for (let i = 0; i < count; i += 1)
    await db.conversations.put(
      chatRow({
        id: `c-pin-${i}`,
        title: `A pinned chat ${i}`,
        hermesSessionId: `s-pin-${i}`,
        updatedAt: 20 + i,
        pinned: true,
        pinnedAt: 100 + i,
      }),
    )
}

const screen = (id = CHAT) => (
  <MemoryRouter initialEntries={[`/c/${id}`]}>
    <Routes>
      <Route
        path="/c/:id"
        element={
          <>
            <ChatPage slot="route" />
            <Path />
          </>
        }
      />
      <Route path="/code" element={<Path />} />
      <Route path="/" element={<Path />} />
    </Routes>
  </MemoryRouter>
)

/** The bar's title, as the one press a chat's header answers with. */
const titlePress = () => find("[data-chat-settings-open]")
/** The sheet the press opens, by the name it wears. */
const sheet = () => findText("[role=dialog]", "Edit chat")
/** The sheet's Pin switch, by the row it is drawn in — the mute stays the sheet's first switch. */
const pinSwitch = () => find("[data-chat-pin] [role=switch]")
/** The sheet's Archive control, whose word is Unarchive once the chat is archived. */
const archiveButton = () => find("[data-chat-archive]")
/** Whether a switch is shut, whichever way the component says so. */
const shut = (element: Element | null) =>
  Boolean(element && (element.hasAttribute("disabled") || element.getAttribute("data-disabled") !== null))

test("a bot's chat draws no way to its list and no menu in its bar", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    assert.equal(findAll('[aria-label^="Chats with"]').length, 0, "no list control")
    assert.equal(findAll('[aria-label="Chat options"]').length, 0, "and no menu beside it")
    assert.equal(
      findAll('[data-slot="header-actions"] button[aria-label^="Context"]').length,
      1,
      "its context, as the ring the bar keeps at every width",
    )
  })
})

/**
 * The ring is the bar's one control, and it opens the same use the sheet used to hold a row for: the
 * sheet would rather the reader saw it while reading, not after a press.
 */
test("the bar's ring opens the chat's usage at 1280 as it does on a phone", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await atWidth(1280, async () => {
    await mount(screen(), async () => {
      await until(
        () => Boolean(find('[data-slot="header-actions"] button[aria-label^="Context"]')),
        "the ring in the bar",
      )
      await click(find('[data-slot="header-actions"] button[aria-label^="Context"]'))
      await until(
        async () => Boolean(findText("[role=dialog]", "Usage")),
        "the usage sheet the ring opens",
      )
    })
  })
})

test("the bar's title opens the chat's settings, holding its name, its mute and its delete", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    assert.equal(findAll("[role=dialog]").length, 0, "nothing is open until the title is pressed")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    const name = find("[data-chat-name]")
    assert.equal(name?.tagName, "INPUT", "its name, as the field it is typed in")
    assert.equal(
      name?.closest("[data-settings-group]"),
      null,
      "and not in a card, which a field is not",
    )
    const mute = find('[role="switch"]')?.closest("[data-settings-group]")
    assert.ok(mute, "its notifications, as a switch in a card of its own")
    assert.ok(find("[data-chat-pin]"), "its pin, as the switch beside the mute")
    assert.equal(
      findAll("[data-settings-group]").length,
      1,
      "one card in the sheet, holding the mute and the pin",
    )
    assert.equal(missing("[data-chat-context]"), true, "no context row: the bar draws the ring")
    assert.ok(findText("button", "Delete chat"), "and the one control that ends it")
  })
})

test("the sheet's switch mutes the chat, and unmutes it again", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    const toggle = () => find('[role="switch"]')
    assert.equal(toggle()?.getAttribute("aria-checked"), "false", "a chat starts unmuted")
    await click(toggle())
    await until(async () => (await db.conversations.get(CHAT))?.muted === true, "the chat muted")
    await settle()
    await click(find('[role="switch"]'))
    await until(async () => (await db.conversations.get(CHAT))?.muted === undefined, "unmuted again")
  })
})

test("the sheet's pin writes the flag and its clock, and clears both when turned off", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    await until(async () => Boolean(pinSwitch()), "the pin, beside the mute")
    assert.equal(pinSwitch()?.getAttribute("aria-checked"), "false", "a chat starts unpinned")
    await click(pinSwitch())
    await until(async () => {
      const row = await db.conversations.get(CHAT)
      return row?.pinned === true && typeof row.pinnedAt === "number"
    }, "the pin and the clock its place is ordered by, written together")
    await settle()
    await click(pinSwitch())
    await until(async () => {
      const row = await db.conversations.get(CHAT)
      return row?.pinned === undefined && row.pinnedAt === undefined
    }, "and both cleared when the pin is turned off")
  })
})

/**
 * A pin behind the Archived pill could not be turned off from any list, so archiving takes it in the
 * same write — and the control says what pressing it again would do.
 */
test("Archive takes the pin with it, and Unarchive clears the archive", async () => {
  await seed({ pinned: true, pinnedAt: 7, updatedAt: 11 })
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    await until(async () => Boolean(archiveButton()), "the Archive control, above Delete")
    assert.equal(archiveButton()?.textContent, "Archive", "a chat of the list is archived, not unarchived")
    await click(archiveButton())
    await until(async () => {
      const row = await db.conversations.get(CHAT)
      return row?.archived === true && row.pinned === undefined && row.pinnedAt === undefined
    }, "archived, with no pin left stranded behind the pill")
    await settle()
    await until(
      async () => archiveButton()?.textContent === "Unarchive",
      "the control naming what it now does",
    )
    await click(archiveButton())
    await until(
      async () => (await db.conversations.get(CHAT))?.archived === undefined,
      "unarchived again",
    )
  })
})

/**
 * A pin on an archived row could never be drawn — the row is out of the pinned group every list
 * draws, and archiving already cleared the pin it had — so the sheet offers no switch for it. What
 * it keeps is its name, its mute, the way back and the delete.
 */
test("an archived chat's sheet draws no Pin, only its name, its mute and Unarchive", async () => {
  await seed({ archived: true, updatedAt: 11 })
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    await until(async () => Boolean(archiveButton()), "the way back")
    assert.equal(archiveButton()?.textContent, "Unarchive", "drawn, naming what the press does")
    assert.equal(
      findAll('[role="switch"]').length,
      1,
      "one switch: the mute, and no pin beside it",
    )
    assert.equal(
      missing("[data-chat-pin]"),
      true,
      "no pin: a mark on a row out of every list is a mark nothing could draw",
    )
    assert.ok(findText("button", "Delete chat"), "and the one control that ends it")
  })
})

test("a chat nothing was said in is offered no way to put it away", async () => {
  // Nothing was said in it, so the sheet is the only way into it: a control that put it out of every
  // list would be the one thing that lost it (ADR 0158).
  await seed()
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    const row = await db.conversations.get(CHAT)
    assert.equal(row?.updatedAt, row?.createdAt, "the record a New chat press mints")
    assert.equal(missing("[data-chat-archive]"), true, "no Archive, and no Unarchive either")
    assert.ok(findText("button", "Delete chat"), "while the one control that ends it stays")
  })
})

test("a sixth pin reads off, with the line saying what has to happen first", async () => {
  await seedPins(5)
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    await until(async () => shut(pinSwitch()), "the switch shut once the list holds its five")
    assert.equal(pinSwitch()?.getAttribute("aria-checked"), "false", "this chat is none of them")
    assert.ok(
      findText("[data-chat-pin]", "Five pins is the most one list holds. Unpin one to make room."),
      "and the line that says why",
    )
  })
})

test("a pinned chat keeps its switch on and turnable at five", async () => {
  await seedPins(4, { pinned: true, pinnedAt: 99 })
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    await until(
      async () => pinSwitch()?.getAttribute("aria-checked") === "true",
      "this chat reads as one of the five",
    )
    assert.equal(shut(pinSwitch()), false, "and unpinning it is how room is made")
  })
})

/**
 * The sheet's switch is only one way in, and a shut switch is not a rule: a sixth pin written
 * straight through the writer would spend a slot the list does not have, so the writer counts the
 * list itself and refuses. The count is over the pins the list holds — the one this row already
 * made is no sixth — so the same write lands the moment one is freed, and a pin already made is
 * never taken away by a full list.
 */
test("a sixth pin written straight through the writer is refused, and a fifth lands", async () => {
  // The chat is a row of the list — started, so it is counted among them — and unpinned.
  await seedPins(5, { updatedAt: 11 })
  globalThis.fetch = async () => json({})
  assert.equal(
    await setPinned(CHAT, true),
    false,
    "five pins is one list's whole room, so the writer refuses a sixth",
  )
  const refused = await db.conversations.get(CHAT)
  assert.equal(refused?.pinned, undefined, "and writes nothing: the chat is still unpinned")
  assert.equal(refused?.pinnedAt, undefined, "nor a clock for a pin it never made")
  // One of the five unpinned: the cap is a count, not a shut door.
  await db.conversations.update("c-pin-0", { pinned: undefined, pinnedAt: undefined })
  assert.equal(await setPinned(CHAT, true), true, "the fifth lands")
  const pinned = await db.conversations.get(CHAT)
  assert.equal(pinned?.pinned, true, "the chat is pinned")
  assert.equal(typeof pinned?.pinnedAt, "number", "with the clock its place is ordered by")
  // The same press again on the list's five: a pin already made is no sixth, and unpinning is the
  // one way to make room — so the writer is never the reason a pin cannot be kept.
  assert.equal(await setPinned(CHAT, true), true, "a row keeps the pin it holds")
  assert.equal((await db.conversations.get(CHAT))?.pinned, true, "still pinned")
  // And a sixth, written straight through for the count the sheet would not offer.
  await db.conversations.put(
    chatRow({ id: "c-late", title: "A late chat", hermesSessionId: "s-late", updatedAt: 30 }),
  )
  assert.equal(await setPinned("c-late", true), false, "the list is full")
  assert.equal(
    (await db.conversations.get("c-late"))?.pinned,
    undefined,
    "and the late chat stays out",
  )
})

test("Delete asks first, and takes the chat away only when answered", async () => {
  await seed()
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(titlePress()), "the chat's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the chat's settings")
    await click(findText("button", "Delete chat"))
    await until(async () => Boolean(findText("[role=alertdialog]", "Delete this chat?")), "the ask")
    assert.ok(await db.conversations.get(CHAT), "a confirmation asked is not a chat deleted")
    await click(findText("[role=alertdialog] button", "Delete"))
    await until(async () => path() === "/", "the way out once it is gone")
    assert.equal(await db.conversations.get(CHAT), undefined, "and the chat with it")
  })
})

test("a project session keeps its menu: its settings are not a chat's", async () => {
  await seed({ projectId: "p-1", title: "A session" })
  globalThis.fetch = async () => json({})
  await mount(screen(), async () => {
    await until(async () => Boolean(find('[aria-label="Chat options"]')), "the session's menu")
    assert.ok(missing("[data-chat-settings-open]"), "and no title that opens a chat's settings")
  })
})

/**
 * Main is the bot's own conversation with its host, and it stays that: it may not be renamed, pinned,
 * archived or deleted from any surface (G2), so the sheet a press opens on it offers none of them.
 * Its title is Hermes's, its place is permanent, and its delete is already refused where the record is
 * read — this is the surface that must not offer a press the write would refuse.
 */
test("Main is offered no name, no pin and no archive", async () => {
  await seed({ id: "main-1", title: "Bot Chat", main: true, updatedAt: 11, hermesSessionId: "s-main" })
  globalThis.fetch = async () => json({})
  await mount(screen("main-1"), async () => {
    await until(async () => Boolean(titlePress()), "Main's bar")
    await click(titlePress())
    await until(async () => Boolean(sheet()), "the sheet the title opens")
    assert.equal(missing("[data-chat-name]"), true, "no name field: the host's title is not ours to write")
    assert.equal(missing("[data-chat-pin]"), true, "no pin: Main stands where it stands")
    assert.equal(missing("[data-chat-archive]"), true, "and no way to put it away")
    absentText("button", "Delete chat")
    // What is left is what a reader may still say about it: its notifications.
    assert.equal(findAll('[role="switch"]').length, 1, "one switch, the mute")
  })
})

/**
 * The sheet is one way in and the marks are written by two writers besides it, so the refusal lives
 * in them rather than in the surface that offers the press: a pin or an archive written straight
 * through — by a screen, a queue or a caller this build has not written yet — is refused, and
 * nothing is written at all.
 */
test("the writers refuse Main, and write nothing", async () => {
  await seed({ id: "main-1", title: "Bot Chat", main: true, createdAt: 1, updatedAt: 11 })
  globalThis.fetch = async () => json({})
  assert.equal(await setPinned("main-1", true), false, "a pin on Main is refused")
  await setArchived("main-1", true)
  const row = await db.conversations.get("main-1")
  assert.equal(row?.pinned, undefined, "and nothing was pinned")
  assert.equal(row?.pinnedAt, undefined)
  assert.equal(row?.archived, undefined, "nor put away")
  assert.equal(row?.main, true, "Main is still Main")
})
