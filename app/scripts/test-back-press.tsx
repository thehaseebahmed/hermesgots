/**
 * Android's back press, as the screen on show answers it: the rules a screen registers, and the
 * order they are asked in — the frontmost pop-up first, then the screen, then the app's own exit.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useEffect } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { db } from "@/lib/db"
import { useNav } from "@/lib/nav"
import { pressBack, setBackGuard } from "@/lib/native"
import { SettingsPage } from "@/routes/settings"

import {
  atDepth,
  atWidth,
  botProfile,
  GENERAL,
  mediaHost,
  mount,
  seedSettings,
  until,
} from "./component-kit.tsx"

/** The guard a screen the menu and a list both open registers: `step` to the screen behind it. */
function Stepping({ to }: { to: string }) {
  const { step } = useNav()
  useEffect(() => setBackGuard(step(to)), [step, to])
  return null
}

test("a screen a list pushed steps up to the list behind it", async () => {
  const history = atDepth(1)
  try {
    await mount(
      <MemoryRouter initialEntries={["/canvas/c1"]}>
        <Stepping to="/canvas" />
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
        <Stepping to="/canvas" />
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
