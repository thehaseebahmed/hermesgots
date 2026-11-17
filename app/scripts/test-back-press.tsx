/**
 * Android's back press, as the screen on show answers it: the rules a screen registers, and the
 * order they are asked in — the frontmost pop-up first, then the screen, then the app's own exit.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act, useEffect } from "react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"

import { AppShell } from "@/components/app-shell"
import { db } from "@/lib/db"
import { useNav } from "@/lib/nav"
import { answerBackPress, pressBack, setBackGuard, setMenuOpener } from "@/lib/native"
import { SideChatsPage } from "@/routes/side-chats"
import { ChatPage } from "@/routes/chat"
import { SettingsPage } from "@/routes/settings"

import {
  Path,
  absent,
  atDepth,
  atWidth,
  botProfile,
  find,
  findAll,
  GENERAL,
  json,
  mediaHost,
  mount,
  path,
  seedChat,
  seedSettings,
  until,
} from "./component-kit.tsx"

/** The state the address on screen carries, as the chat's way back and the guard both read it. */
const State = () => <p data-state>{JSON.stringify(useLocation().state ?? null)}</p>

function Stepping() {
  const { back } = useNav()
  useEffect(() => setBackGuard(back()), [back])
  return null
}

test("a screen a list pushed steps up to the list behind it", async () => {
  const history = atDepth(1)
  try {
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Stepping />
      </MemoryRouter>,
      async () => {
        assert.equal(pressBack(), "screen", "the screen takes the press")
        assert.deepEqual(history.backs, [1], "and steps back to what opened it")
      },
    )
  } finally {
    history.restore()
  }
})

test("a screen the menu opened leaves the press to the app", async () => {
  const history = atDepth(0)
  try {
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Stepping />
      </MemoryRouter>,
      async () => {
        assert.equal(pressBack(), "app", "the press is the app's, which leaves it")
        assert.deepEqual(history.backs, [], "nothing goes up")
      },
    )
  } finally {
    history.restore()
  }
})

test(
  "a Settings screen a chat opened steps back to the chat",
  atWidth(390, async () => {
    await seedSettings()
    await db.profiles.clear()
    await db.profiles.put(botProfile("settings"))
    mediaHost({ features: ["general_page"], general: GENERAL })
    const history = atDepth(1)
    try {
      await mount(
        <MemoryRouter initialEntries={["/settings"]}>
          <Routes>
            <Route path="/settings/:section?/:botId?/:tab?/:sub?" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>,
        async () => {
          await until(
            () => Boolean(document.querySelector('a[href="/settings/appearance"]')),
            "the menu",
          )
          assert.equal(pressBack(), "screen", "the menu takes the press")
          assert.deepEqual(history.backs, [1], "and steps back to the chat behind it")
        },
      )
    } finally {
      history.restore()
    }
  }),
)

test(
  "a bot's settings answers the press on a laptop, where its list takes the menu's pane",
  atWidth(1024, async () => {
    await seedSettings()
    await db.profiles.clear()
    await db.profiles.put(botProfile("settings"))
    mediaHost({ features: ["general_page"], general: GENERAL })
    const history = atDepth(1)
    try {
      await mount(
        <MemoryRouter initialEntries={["/settings/bots/bot-1/models"]}>
          <Routes>
            <Route path="/settings/:section?/:botId?/:tab?/:sub?" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>,
        async () => {
          await until(() => Boolean(document.querySelector('[aria-label="Back"]')), "the page")
          assert.equal(pressBack(), "screen", "the screen takes the press")
          assert.deepEqual(history.backs, [1], "and steps back to the screen behind it")
        },
      )
    } finally {
      history.restore()
    }
  }),
)

test("an open pop-up takes the press before any screen", async () => {
  const popup = document.createElement("div")
  popup.setAttribute("role", "dialog")
  popup.setAttribute("data-open", "")
  document.body.append(popup)
  try {
    assert.equal(pressBack(), "popup", "the pop-up is closed first")
  } finally {
    popup.remove()
  }
})

function disarm() {
  for (let press = 0; press < 2; press += 1) if (answerBackPress() === "leave") return
}

test("the first press at the root opens the menu, and the second leaves", async () => {
  let opened = 0
  const done = setMenuOpener(() => void (opened += 1))
  try {
    assert.equal(answerBackPress(), "armed", "the first press at the root arms the exit")
    assert.equal(opened, 1, "and offers the app's menu with it")
    assert.equal(answerBackPress(), "leave", "the press inside the window leaves")
  } finally {
    disarm()
    done()
  }
})

test("an armed press leaves with a sheet open", async () => {
  assert.equal(answerBackPress(), "armed", "the first press arms the exit")
  const sheet = document.createElement("div")
  sheet.setAttribute("role", "dialog")
  sheet.setAttribute("data-open", "")
  let escaped = 0
  sheet.addEventListener("keydown", () => void (escaped += 1))
  document.body.append(sheet)
  try {
    assert.equal(answerBackPress(), "leave", "the press the toast promised leaves anyway")
    assert.equal(escaped, 0, "and the sheet standing in front is never the press's to close")
    assert.equal(document.body.contains(sheet), true, "so it is still standing after it")
  } finally {
    sheet.remove()
    disarm()
  }
})

test("a change of address clears the arm", async () => {
  const before = window.location.pathname
  try {
    assert.equal(answerBackPress(), "armed", "the press arms the exit at this address")
    window.history.pushState({}, "", "/c/somewhere-else")
    assert.equal(
      answerBackPress(),
      "armed",
      "a press at another address arms afresh rather than leaving",
    )
    assert.equal(answerBackPress(), "leave", "and the arm it made is the one that leaves")
  } finally {
    window.history.replaceState(window.history.state, "", before)
    disarm()
  }
})

test("a press at another entry of the same address is not the armed press", async () => {
  const href = window.location.href
  try {
    assert.equal(answerBackPress(), "armed", "the press arms the exit at this entry")
    // The same address one entry deeper: a round trip back to it is a different place, so the press
    // there is not the one the toast promised to answer.
    window.history.pushState({ idx: 1 }, "", href)
    assert.equal(
      answerBackPress(),
      "armed",
      "a press at another entry of that address arms afresh rather than leaving",
    )
  } finally {
    disarm()
    window.history.replaceState({}, "", href)
  }
})

/**
 * The bot every list case seeds: its chats are what a conversation is opened above, so its address is
 * the entry the guard steps onto and the one the app's press is answered on.
 */
const BOT = "bot-1"

/**
 * A bot's **Side Chat List** at its own address, where the platform's back is the one rung up to the
 * bot's Main (ADR 0161): the list is a screen of the bot's, never the app's edge, so the press there
 * steps rather than leaving — at the app's first entry it puts Main in the list's place.
 */
const sideListAt = () => (
  <MemoryRouter initialEntries={[`/b/${BOT}/sidechats`]}>
    <Path />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="b/:profileId/sidechats" element={<SideChatsPage />} />
        <Route path="b/:profileId" element={<p data-bot-main />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

const DRAWER_DIALOG = '[role="dialog"][data-open] [data-slot="sheet-title"]'

test(
  "a tablet offers no drawer over the sidebar the press already has",
  atWidth(1024, async () => {
    await seedMainOfBot()
    const history = atDepth(0)
    try {
      await mount(chatAt(MAIN), async () => {
        await until(
          async () => Boolean(document.querySelector('[data-slot="header-title"]')),
          "the bot's Main",
        )
        await act(async () => {
          assert.equal(answerBackPress(), "armed", "the press still arms the exit")
        })
        absent(DRAWER_DIALOG, "and offers no drawer over the sidebar already on screen")
      })
    } finally {
      disarm()
      history.restore()
    }
  }),
)

/** The bot's Main under the app's shell, which is what registers the phone's drawer. */
const mainAt = () => (
  <MemoryRouter initialEntries={[`/c/${MAIN}`]}>
    <Path />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="c/:id" element={<ChatPage />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

const chatAt = (id: string) => (
  <MemoryRouter initialEntries={[`/c/${id}`]}>
    <Path />
    <State />
    <Routes>
      <Route path="c/:id" element={<ChatPage slot="route" />} />
      {/* A chat's way back is its bot's list, which has an address of its own. */}
      <Route path="b/:profileId/sidechats" element={<p data-bot-list />} />
    </Routes>
  </MemoryRouter>
)

/** The bot's Main: the one chat its entry opens on, whose bar leads nowhere. */
const MAIN = "back-main"

async function seedMainOfBot() {
  await seedChatOfBot(MAIN)
  await db.conversations.update(MAIN, { main: true })
}

/** One chat of a bot this device holds, drawn by the screen every bot's chat opens on. */
async function seedChatOfBot(id = "back-chat") {
  const profile = botProfile("back-list", { id: BOT, name: "Mainly" })
  await seedChat({
    id,
    profile,
    settings: { developer: true, activeProfileId: profile.id },
    messages: [
      {
        id: "back-chat-1",
        conversationId: "back-chat",
        role: "user",
        content: "The first thing said",
        status: "done",
        createdAt: 2,
      },
    ],
  })
  globalThis.fetch = async () => json({})
}

test(
  "a phone's chat leads with its way back, and no drawer stands beside it",
  atWidth(390, async () => {
    await seedChatOfBot()
    const history = atDepth(0)
    try {
      await mount(chatAt("back-chat"), async () => {
        await until(
          async () => Boolean(document.querySelector('[data-slot="header-title"]')),
          "the chat",
        )
        assert.equal(
          findAll('[data-slot="header-leading"] button[aria-label="Back to Mainly"]').length,
          1,
          "the bar leads with the way back to the bot's list",
        )
        assert.equal(
          findAll('[data-slot="header-leading"] button[aria-label="Open conversations"]').length,
          0,
          "and the drawer stands nowhere on a bar that leads back",
        )
        assert.equal(
          findAll('[data-slot="header-actions"] button[aria-label="Back to Mainly"]').length,
          0,
          "the corner is the actions' alone",
        )
      })
    } finally {
      history.restore()
    }
  }),
)

test(
  "a chat steps onto its bot's list, rather than leaving the app",
  atWidth(390, async () => {
    await seedChatOfBot()
    const history = atDepth(0)
    try {
      await mount(chatAt("back-chat"), async () => {
        await until(
          async () => Boolean(document.querySelector('[data-slot="header-title"]')),
          "the chat",
        )
        assert.equal(
          pressBack(),
          "screen",
          "the screen takes the press rather than the app leaving",
        )
        assert.deepEqual(history.backs, [], "with no step to take: the list takes the chat's entry")
        await until(
          async () => path() === `/b/${BOT}/sidechats`,
          "the bot's list in the chat's place",
        )
        assert.ok(find("[data-bot-list]"), "the list the conversation stands one rung above")
      })
    } finally {
      history.restore()
    }
  }),
)

test(
  "the press at the root draws the drawer the shell registered",
  atWidth(390, async () => {
    await seedMainOfBot()
    const history = atDepth(0)
    try {
      await mount(mainAt(), async () => {
        await until(
          async () => Boolean(document.querySelector('[data-slot="header-title"]')),
          "the bot's Main",
        )
        await act(async () => {
          assert.equal(answerBackPress(), "armed", "the press at the root arms the exit")
        })
        await until(async () => find(DRAWER_DIALOG) !== null, "the drawer's dialog over Main")
        assert.equal(
          find(DRAWER_DIALOG)?.textContent,
          "Conversations",
          "the app's own menu, drawn by the shell",
        )
        assert.equal(answerBackPress(), "leave", "and the press the toast promised leaves")
      })
    } finally {
      history.restore()
    }
  }),
)

test(
  "a bot's list answers the platform's press with Main, never with the app's exit",
  atWidth(390, async () => {
    await seedMainOfBot()
    await db.conversations.put({
      id: "back-side",
      profileId: BOT,
      title: "A side chat",
      hermesSessionId: "gots-back-side",
      createdAt: 3,
      updatedAt: 4,
      changedAt: 4,
    })
    const history = atDepth(0)
    try {
      await mount(sideListAt(), async () => {
        await until(
          async () => Boolean(document.querySelector('[data-slot="header-title"]')),
          "the bot's list",
        )
        // The list is a screen of the bot's, not the app's edge: the press is Main, one rung up.
        assert.equal(
          pressBack(),
          "screen",
          "the list takes the press rather than the app leaving it",
        )
        await until(async () => Boolean(find("[data-bot-main]")), "Main in the list's place")
        assert.equal(path(), `/b/${BOT}`, "the bot's entry, which is where Main stands")
      })
    } finally {
      history.restore()
    }
  }),
)

test("Main is the app's edge: the press there arms the exit and then leaves", async () => {
  await seedMainOfBot()
  try {
    await mount(chatAt(MAIN), async () => {
      await until(
        async () => Boolean(document.querySelector('[data-slot="header-title"]')),
        "the bot's Main",
      )
      assert.equal(pressBack(), "app", "nothing stands behind Main, so no screen takes it")
      assert.equal(answerBackPress(), "armed", "the app's own toast, the press after it leaving")
      assert.equal(answerBackPress(), "leave", "and the press the toast promised leaves")
    })
  } finally {
    disarm()
  }
})
