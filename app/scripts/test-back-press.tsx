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

/** The state the address on screen carries, as a screen a chat's way out leaves behind reads it. */
const State = () => <p data-state>{JSON.stringify(useLocation().state ?? null)}</p>
const state = () => find("[data-state]")?.textContent ?? ""

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
          await until(() => Boolean(document.querySelector('a[href="/settings/appearance"]')), "the menu")
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

const shellAt = (id: string) => (
  <MemoryRouter initialEntries={[`/c/${id}`]}>
    <Path />
    <Routes>
      <Route element={<AppShell />}>
        <Route path="c/:id" element={<ChatPage slot="route" />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

const DRAWER_DIALOG = '[role="dialog"][data-open] [data-slot="sheet-title"]'

test(
  "a tablet offers no drawer over the sidebar the press already has",
  atWidth(1024, async () => {
    await seedChatOfBot()
    const history = atDepth(0)
    try {
      await mount(shellAt("back-chat"), async () => {
        await until(
          async () => Boolean(document.querySelector('[data-slot="header-title"]')),
          "the chat",
        )
        await act(async () => {
          assert.equal(answerBackPress(), "armed", "the press still arms the exit")
        })
        absent(DRAWER_DIALOG, "and offers no drawer over the list the sidebar already draws")
      })
    } finally {
      disarm()
      history.restore()
    }
  }),
)

const chatAt = (id: string) => (
  <MemoryRouter initialEntries={[`/c/${id}`]}>
    <Path />
    <State />
    <Routes>
      <Route path="c/:id" element={<ChatPage slot="route" />} />
    </Routes>
  </MemoryRouter>
)

/** One chat of a bot this device holds, drawn by the screen every bot's chat opens on. */
async function seedChatOfBot() {
  const profile = botProfile("back-list", { id: "bot-1", name: "Mainly" })
  await seedChat({
    id: "back-chat",
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
  "a chat's bar leads with the app's menu, not its bot's list",
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
          find('[data-slot="header-row"] button')?.getAttribute("aria-label"),
          "Open conversations",
          "the bar leads with the drawer's own control",
        )
        assert.equal(
          findAll('[aria-label="Back to Mainly"]').length,
          0,
          "and nothing anywhere leads back to the bot's list",
        )
      })
    } finally {
      history.restore()
    }
  }),
)

test(
  "a chat at the app's entry leaves the press to the app",
  atWidth(390, async () => {
    await seedChatOfBot()
    const history = atDepth(0)
    try {
      await mount(chatAt("back-chat"), async () => {
        await until(
          async () => Boolean(document.querySelector('[data-slot="header-title"]')),
          "the chat",
        )
        assert.equal(pressBack(), "app", "the press is the app's, which leaves it")
        assert.deepEqual(history.backs, [], "and nothing steps")
        assert.equal(path(), "/c/back-chat", "so the chat is still what is on")
        assert.deepEqual(JSON.parse(state()), null, "with nothing written in its place")
      })
    } finally {
      history.restore()
    }
  }),
)

test(
  "the press at the root draws the drawer the shell registered",
  atWidth(390, async () => {
    await seedChatOfBot()
    const history = atDepth(0)
    try {
      await mount(shellAt("back-chat"), async () => {
        await until(
          async () => Boolean(document.querySelector('[data-slot="header-title"]')),
          "the chat",
        )
        await act(async () => {
          assert.equal(answerBackPress(), "armed", "the press at the root arms the exit")
        })
        await until(async () => find(DRAWER_DIALOG) !== null, "the drawer's dialog over the chat")
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
