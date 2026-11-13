import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"

import { db } from "@/lib/db"
import { mentionText } from "@/lib/mention-marker"
import { RETRY_OPEN } from "@/lib/retry-message"

import { fakeHost } from "./chat-next-host.ts"
import {
  absent,
  botProfile,
  chatScreen,
  click,
  composerField,
  find,
  findAll,
  labelled,
  mount,
  pickPress,
  seedChats,
  sendPress,
  settle,
  text,
  type,
  until,
  wordsOf,
} from "./component-kit.tsx"

/**
 * The composer's `@` menu over this device's own rows: the bot's newest titled sessions and the
 * other bots its host registered, narrowed by what is typed after the `@`. Nothing here reads a
 * host — the list is the device's, which is why a seeded database is the whole fixture.
 */
const MENTIONER = botProfile("bot-mention", {
  id: "bot-1",
  name: "Mentioner",
  hostId: "host-1",
  hermesProfile: "mentioner",
})
/** The same host, so its bot is offered — but its chats are not this bot's to name. */
const SIBLING = botProfile("bot-sibling", {
  id: "bot-2",
  name: "Sibling",
  hostId: "host-1",
  hermesProfile: "sibling",
})
/** Another host, so nothing of it can be resolved by the host this message goes to. */
const AWAY = botProfile("bot-away", {
  id: "bot-3",
  name: "Away bot",
  hostId: "host-2",
  hermesProfile: "away",
})

async function seeded() {
  await seedChats(
    [
      { id: "c1", profileId: "bot-1", title: "The chat we are in" },
      { id: "s2", profileId: "bot-1", title: "Weekly review", at: 20 },
      // Two word-runs, so the name that lands in the sentence is the title as read.
      { id: "s3", profileId: "bot-1", title: "Q3  planning review", at: 30 },
      { id: "x1", profileId: "bot-2", title: "Sibling notes", at: 40 },
    ],
    { bots: [MENTIONER, SIBLING, AWAY], active: "bot-1" },
  )
  // chat-next reads the open chat's transcript too; the hosts this menu reads are the device's.
  return fakeHost("gots-c1", { plugin: true })
}

const MENU = '[role="listbox"][aria-label="Sessions and bots"]'
const menu = () => labelled('[role="listbox"]', "Sessions and bots")
const slashMenu = () => labelled('[role="listbox"]', "Commands and skills")
/** A row's words are its title and its line, and `PickRow` puts nothing between them. */
const options = () => findAll('[role="option"]').map((row) => wordsOf(row))
const offers = (name: string, line: "Session" | "Bot") => options().includes(`@${name}${line}`)
const field = composerField

/** One key in the field, as a reader presses it: the menu's own keys are read from here. */
async function press(key: string) {
  await act(async () => {
    field()?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))
  })
  await settle()
}

test("typing @ offers this bot's sessions and its host's other bots, and nothing else", async () => {
  await seeded()
  await mount(chatScreen("c1"), async () => {
    await until(async () => Boolean(field()), "the composer")
    await type(field(), "@")
    await until(async () => Boolean(menu()), "the @ menu")

    assert.ok(offers("Q3 planning review", "Session"), "a session of this bot's is offered")
    assert.ok(offers("Weekly review", "Session"), "and the one under it")
    assert.equal(offers("The chat we are in", "Session"), false, "never the chat you are in")
    assert.equal(offers("Sibling notes", "Session"), false, "and never another bot's session")
    assert.ok(offers("Sibling", "Bot"), "the host's other bot is offered")
    assert.equal(offers("Away bot", "Bot"), false, "a bot of another host is not")
    assert.equal(offers("Mentioner", "Bot"), false, "and this bot never offers itself")

    await type(field(), "@wee")
    await until(async () => Boolean(menu()), "the menu under the query")
    assert.deepEqual(options(), ["@Weekly reviewSession"], "the query keeps the one row it names")
  })
})

test("Return takes the row the cursor is on, and Escape shuts the menu till the text changes", async () => {
  await seeded()
  await mount(chatScreen("c1"), async () => {
    await until(async () => Boolean(field()), "the composer")
    await type(field(), "@wee")
    await until(async () => Boolean(menu()), "the @ menu")

    await pickPress()
    await until(
      async () => field()?.selectionStart === "@Weekly review ".length,
      "the caret past the name",
    )
    assert.equal(field()?.value, "@Weekly review ", "the name lands in the field")
    absent(MENU, "the @ menu is shut")

    await type(field(), "@")
    await until(async () => Boolean(menu()), "the menu again")
    await press("Escape")
    absent(MENU, "Escape shuts the @ menu")

    await type(field(), "@wee")
    await until(async () => Boolean(menu()), "the menu an edit brings back")

    // The same field still reads a `/` as its own token, and one menu stands at a time.
    await type(field(), "/")
    await until(async () => Boolean(slashMenu()), "the / menu")
    absent(MENU, "the @ menu gave way to it")
  })
})

/**
 * A pick's name is the user's sentence and its id is the bot's business: the message the host is
 * handed still names the session, and no screen — the bubble, the title or Main's card — draws the
 * line that carries it.
 */
test("a pick reaches the host, and no screen draws its marker line", async () => {
  const host = await seeded()
  // A chat is titled and its opener made by its first send, which a seeded title pins shut.
  await db.conversations.update("c1", { titleEdited: false })
  await mount(chatScreen("c1"), async () => {
    await until(async () => Boolean(field()), "the composer")
    await type(field(), "@wee")
    await until(async () => Boolean(menu()), "the @ menu")
    await pickPress()
    await until(async () => field()?.value === "@Weekly review ", "the name in the field")

    // Ctrl+Enter, which sends whichever way the device's Send on Enter switch is set.
    await sendPress()
    await until(() => host.asked.runs === 1, "the host was asked to run the message")
    assert.ok(
      String(JSON.stringify(host.latest.body)).includes(
        "[MENTION — Weekly review | session: gots-s2]",
      ),
      "the host is told the session the message named",
    )

    const chat = await db.conversations.get("c1")
    assert.equal(chat?.title, "@Weekly review", "the title is made of the words")
    assert.equal(chat?.opener, "@Weekly review", "and so is Main's card opener")
    await until(
      () => findAll('[data-chat-next] [data-message-id$="-u"]').length > 0,
      "the request drawn in the thread",
    )
    assert.equal(text().includes("[MENTION"), false, "and no row of the thread draws the line")
  })
})

test("a retry re-asks the session the request that failed named", async () => {
  const host = await seeded()
  const pick = { name: "Weekly review", kind: "session", id: "gots-s2" }
  host.seed([
    {
      user: mentionText("@Weekly review plan the week", [pick]),
      reply: "",
      failed: "Your request was not processed.",
    },
  ])
  await mount(chatScreen("c1"), async () => {
    await until(async () => Boolean(find("[data-retry]")), "the failed turn offers Retry")
    await click(find("[data-retry]"))
    await until(() => host.asked.runs === 1, "the request is asked again")
    const sent = String(JSON.stringify(host.latest.body))
    assert.ok(sent.includes(RETRY_OPEN), "the message carries the retry's opening marker")
    assert.ok(
      sent.includes("[MENTION — Weekly review | session: gots-s2]"),
      "and the session the request it asks again named",
    )
  })
})
