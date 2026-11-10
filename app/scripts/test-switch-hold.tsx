import assert from "node:assert/strict"
import test from "node:test"
import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"

import { BOTS } from "@/components/bots"
import { AppShell } from "@/components/app-shell"
import { db } from "@/lib/db"
import { GREETINGS } from "@/lib/greeting"
import { forgetHeldChats } from "@/lib/chat-hold"
import { FIRST_ROWS } from "@/components/chat/first-rows"
import { ChatPage, SETUP_COPY } from "@/routes/chat"
import {
  botProfile,
  click,
  find,
  findAll,
  laptop,
  mount,
  Path,
  path,
  phone,
  seedChats,
  settle,
  SwitchTo,
  until,
} from "./component-kit.tsx"

const bot = botProfile("switch-hold", { id: "bot-1", name: "Switcher", apiKey: undefined })
const other = botProfile("switch-hold-other", { id: "bot-2", name: "Otherly" })

const PROVISIONAL = [SETUP_COPY, "New chat", ...GREETINGS, ...BOTS.flatMap((one) => one.lines)]

interface Frame {
  text: string
  holding: boolean
  composer: boolean
}

const frameNow = (): Frame => {
  const panes = [...document.querySelectorAll('[data-slot="chat-pane"]')]
  const holding = panes.filter((pane) => pane.hasAttribute("inert"))
  return {
    text: panes.map((pane) => pane.textContent ?? "").join("|"),
    holding: holding.length > 0,
    composer: holding.some((pane) => pane.querySelector('textarea[aria-label="Message"]')),
  }
}

const paneFrame = (name: string): Frame => {
  const root = find(`[data-pane="${name}"]`)
  return {
    text: root?.textContent ?? "",
    holding: Boolean(root?.hasAttribute("inert")),
    composer: Boolean(root?.querySelector('textarea[aria-label="Message"]')),
  }
}

function recordFrames(read: () => Frame) {
  const frames: Frame[] = []
  const written: string[] = []
  const look = (records: MutationRecord[]) => {
    for (const record of records) {
      if (record.type === "characterData") written.push(record.target.textContent ?? "")
      for (const node of record.addedNodes) written.push(node.textContent ?? "")
    }
    frames.push(read())
  }
  const observer = new MutationObserver(look)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return {
    frames,
    written,
    stop() {
      look(observer.takeRecords())
      observer.disconnect()
    },
  }
}

/**
 * Every frame of a switch is the chat that was there, the chat asked for, or the neutral pane drawn
 * while that chat answers — which carries nothing of the chat left (`left`: words only it held).
 */
function onlyReadyFrames(
  seen: ReturnType<typeof recordFrames>,
  before: string,
  after: string,
  left: string,
) {
  seen.stop()
  assert.ok(seen.frames.length > 0, "the switch painted something")
  assert.deepEqual(
    seen.frames
      .filter((frame) => !frame.holding)
      .map((frame) => frame.text)
      .filter((one) => one !== before && one !== after),
    [],
    "every frame carried the chat that was there or the one asked for",
  )
  assert.deepEqual(
    seen.frames.filter((frame) => frame.holding && frame.text.includes(left)),
    [],
    "and the pane that waits for the chat asked for draws nothing of the one left",
  )
  assert.ok(
    seen.frames.some((frame) => frame.holding),
    "the pane waited neutral for the chat asked for",
  )
  assert.equal(
    seen.frames.some((frame) => frame.holding && frame.composer),
    false,
    "with no composer, so a tap on send reaches no chat at all",
  )
  assert.deepEqual(
    seen.written.filter((words) => PROVISIONAL.some((copy) => words.includes(copy))),
    [],
    "no frame carried the setup copy, an untitled header or a greeting line",
  )
}

const greetingKeys = () =>
  Array.from({ length: localStorage.length }, (_, at) => localStorage.key(at) ?? "")
    .filter((key) => key === "gots:last-greeted" || key.startsWith("gots:line-turn:"))
    .sort()
    .map((key) => `${key}=${localStorage.getItem(key)}`)

const paneText = (name = "route") => find(`[data-pane="${name}"]`)?.textContent ?? ""
const paneTitle = () =>
  find('[data-pane="route"] [data-slot="header-title"]')?.textContent?.trim() ?? ""

test("a chat switched to in place draws nothing of the one it left while its own answers come in", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seedChats(
    [
      { id: "c-a", title: "Alpha", messages: ["alpha one"] },
      { id: "c-b", title: "Beta", messages: ["beta one"] },
    ],
    { bots: [bot, other], active: bot.id },
  )
  await mount(phone("/c/c-a", "/c/c-b"), async () => {
    await until(async () => paneText().includes("alpha one"), "the chat on screen")
    const before = paneText()
    const greeting = greetingKeys()
    const seen = recordFrames(frameNow)

    await click(find("[data-switch]"))
    await until(async () => paneText().includes("beta one"), "the chat asked for")
    await settle()

    onlyReadyFrames(seen, before, paneText(), "alpha one")
    assert.equal(
      seen.frames.at(-1)?.holding,
      false,
      "and the pane answers the reader once it lands",
    )
    assert.deepEqual(greetingKeys(), greeting, "the switch wrote nothing of the greeting")
  })
})

test(
  "a chat opened beside the bot's list draws nothing of the chat it replaced while its answers come in",
  laptop(async () => {
    localStorage.clear()
    forgetHeldChats()
    await seedChats(
      [
        { id: "t-a", title: "Thread t-a", messages: ["alpha one"] },
        { id: "t-b", title: "Thread t-b", messages: ["beta one"] },
      ],
      { bots: [bot, other], active: bot.id },
    )
    await mount(phone("/c/t-a", "/c/t-b"), async () => {
      await until(async () => paneText().includes("alpha one"), "the chat beside the list")
      await until(
        async () => Boolean(find('[data-slot="list-lane"] ul a[href="/c/t-b"]')),
        "the other chat's row",
      )
      const before = paneFrame("route").text
      const greeting = greetingKeys()
      const seen = recordFrames(() => paneFrame("route"))

      await click(find('[data-slot="list-lane"] ul a[href="/c/t-b"]'))
      await until(async () => paneFrame("route").text.includes("beta one"), "the chat asked for")
      await settle()

      onlyReadyFrames(seen, before, paneFrame("route").text, "alpha one")
      assert.deepEqual(greetingKeys(), greeting, "the switch wrote nothing of the greeting")
    })
  }),
)

test("a cold start paints an empty header over a blank pane, never the setup copy", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seedChats([{ id: "c-a", title: "Alpha", messages: ["alpha one"] }], {
    bots: [bot, other],
    active: bot.id,
  })
  const container = document.createElement("div")
  document.body.append(container)
  const seen = recordFrames(() => {
    const chat = find('[data-pane="route"]')
    if (!chat) return { text: "nothing", holding: false, composer: false }
    const title = [...chat.querySelectorAll('[data-slot="header-title"]')]
      .map((node) => node.textContent)
      .join("|")
    return {
      text: `${title}|${chat.textContent ?? ""}`,
      holding: chat.hasAttribute("inert"),
      composer: false,
    }
  })
  const root = createRoot(container)
  try {
    await act(async () => root.render(phone("/c/c-a", "/c/c-b")))
    await settle()
    seen.stop()
    const painted = seen.frames.map((frame) => frame.text).filter((one) => one !== "nothing")
    assert.ok(painted.length > 0, "the pane painted something")
    assert.equal(
      painted[0],
      "|",
      `the first frame is an empty header over a blank pane: ${painted[0]}`,
    )
    assert.ok(!painted[0].includes(SETUP_COPY), "the setup copy is never a loading state")
    const last = painted.at(-1) ?? ""
    assert.equal(last.includes("alpha one"), true, "and the first ready frame is the chat itself")
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

/**
 * Switches from a chat to one that answers gone, and checks what the pane does with it: it lands in
 * the place it was asked for, under an empty header — a gone chat is never drawn as a new one, and
 * nothing but its own record can title it — drawing no greeting and burning no line turn.
 */
async function switchToGone() {
  localStorage.clear()
  forgetHeldChats()
  await seedChats(
    [
      { id: "c-a", title: "Alpha", messages: ["alpha one"] },
      { id: "c-b", title: "Beta", messages: ["beta one"] },
    ],
    { bots: [bot, other], active: bot.id },
  )
  const read = db.conversations.get.bind(db.conversations)
  // The chat's own conversation answers gone, as one opened after another device deleted it does.
  db.conversations.get = (async (key: string) =>
    key === "c-b" ? undefined : read(key)) as typeof db.conversations.get
  try {
    await mount(phone("/c/c-a", "/c/c-b"), async () => {
      await until(async () => paneText().includes("alpha one"), "the chat on screen")
      const greeting = greetingKeys()
      // The transcript and the row are not this device's any more.
      await db.messages.where("conversationId").equals("c-b").delete()
      await db.conversations.delete("c-b")
      await settle()

      await click(find("[data-switch]"))
      await until(
        async () => !paneFrame("route").holding && !paneText().includes("alpha one"),
        "the chat that answered gone to land",
      )
      await settle()

      assert.equal(path(), "/c/c-b", "the chat keeps the place it was asked for")
      assert.ok(!paneText().includes("beta one"), "nothing of the chat this device no longer has")
      assert.ok(!paneText().includes(SETUP_COPY), "and never the setup copy")
      await until(async () => paneTitle() === "", "an empty header")
      assert.ok(!paneText().includes("New chat"), "and a gone chat is never drawn as a new one")
      assert.deepEqual(
        PROVISIONAL.filter((copy) => paneText().includes(copy)),
        [],
        "its empty state draws no greeting and no bot line: the ready line mounts on no gone chat",
      )
      assert.equal(
        paneFrame("route").holding,
        false,
        "and it is ready: the pane answers the reader rather than waiting",
      )
      assert.deepEqual(
        greetingKeys(),
        greeting,
        "a chat that answered gone consumes no line turn and swallows no greeting",
      )
    })
  } finally {
    db.conversations.get = read
  }
}

test('a gone thread draws an empty header, never "New chat"', () => switchToGone())

/**
 * A device read of one chat, held open, so a test can look at a pane while that chat's answers are
 * still on their way: `release()` answers every read from then on. The rest of the table is answered
 * as it always was, so only the chat the test names is slow.
 */
function holdRead(id: string) {
  const get = db.conversations.get.bind(db.conversations)
  let release = () => {}
  const held = new Promise<void>((done) => {
    release = done
  })
  db.conversations.get = (async (key: string) => {
    if (key !== id) return get(key)
    await held
    return get(key)
  }) as typeof db.conversations.get
  return {
    release,
    restore() {
      db.conversations.get = get
    },
  }
}

/** The shell with a button per chat it can be sent to, so a test can switch twice in a row. */
const switchable = (entry: string, ...to: string[]) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    {to.map((one) => (
      <SwitchTo key={one} to={one} />
    ))}
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<ChatPage slot="route" />} />
        <Route path="c/:id" element={<ChatPage slot="route" />} />
      </Route>
    </Routes>
  </MemoryRouter>
)

test("a switch away from a reply still streaming leaves none of its words on screen", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seedChats(
    [
      { id: "c-a", title: "Alpha", messages: [{ role: "assistant", content: "alpha one" }] },
      { id: "c-b", title: "Beta", messages: ["beta one"] },
    ],
    { bots: [bot, other], active: bot.id },
  )
  // The turn is still being written when the user leaves the chat.
  await db.messages.update("c-a-0", { status: "streaming" })
  const read = holdRead("c-b")
  try {
    await mount(phone("/c/c-a", "/c/c-b"), async () => {
      await until(async () => paneText().includes("alpha one"), "the chat on screen")
      const greeting = greetingKeys()

      await click(find("[data-switch]"))
      await until(async () => paneFrame("route").holding, "the pane to wait for the chat asked for")
      // The turn keeps writing to the chat the pane has left.
      await db.messages.update("c-a-0", { content: "alpha one, and then some" })
      await settle()

      assert.ok(!paneText().includes("alpha one"), "nothing of the chat left is drawn")
      assert.ok(!paneText().includes("and then some"), "and none of the words that came after it")
      assert.deepEqual(greetingKeys(), greeting, "the wait wrote nothing of the greeting")

      read.release()
      await until(async () => paneText().includes("beta one"), "the chat asked for")
      await settle()
      assert.equal(
        paneFrame("route").holding,
        false,
        "and it lands in one commit once its answers are in",
      )
      assert.deepEqual(greetingKeys(), greeting, "with the greeting untouched either way")
    })
  } finally {
    read.restore()
  }
})

test("two switches in a row draw the chat that was ready and the one asked for, never the one skipped", async () => {
  localStorage.clear()
  forgetHeldChats()
  await seedChats(
    [
      { id: "c-a", title: "Alpha", messages: ["alpha one"] },
      { id: "c-b", title: "Beta", messages: ["beta one"] },
      { id: "c-c", title: "Gamma", messages: ["gamma one"] },
    ],
    { bots: [bot, other], active: bot.id },
  )
  // The chat the user passes through never answers, so it can never be ready to draw.
  const read = holdRead("c-b")
  try {
    await mount(switchable("/c/c-a", "/c/c-b", "/c/c-c"), async () => {
      await until(async () => paneText().includes("alpha one"), "the chat on screen")
      const greeting = greetingKeys()
      const before = paneText()
      const seen = recordFrames(frameNow)
      const [through, asked] = findAll("[data-switch]")

      await click(through)
      await click(asked)
      await until(async () => paneText().includes("gamma one"), "the chat asked for second")
      await settle()

      onlyReadyFrames(seen, before, paneText(), "alpha one")
      assert.deepEqual(
        seen.frames.filter((frame) => frame.text.includes("beta one")).map((frame) => frame.text),
        [],
        "the chat the second switch skipped was never drawn",
      )
      assert.deepEqual(greetingKeys(), greeting, "and neither switch touched the greeting")
    })
  } finally {
    read.release()
    read.restore()
  }
})

test("a long chat switched to draws its last rows first, then every row", async () => {
  localStorage.clear()
  forgetHeldChats()
  const LONG = 30
  await seedChats(
    [
      { id: "c-a", title: "Alpha", messages: ["alpha one"] },
      {
        id: "c-b",
        title: "Beta",
        messages: Array.from({ length: LONG }, (_, index) => `beta row ${index}`),
      },
    ],
    { bots: [bot, other], active: bot.id },
  )
  await mount(phone("/c/c-a", "/c/c-b"), async () => {
    await until(async () => paneText().includes("alpha one"), "the chat on screen")
    const drawn: number[] = []
    const observer = new MutationObserver(() => {
      const pane = find('[data-pane="route"]')
      if (pane && !pane.hasAttribute("inert") && pane.textContent?.includes("beta row"))
        drawn.push(pane.querySelectorAll('[data-slot="message-scroller-item"]').length)
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    // Outside `act`, which would flush the rows' transition in the tap's own batch: a browser
    // paints the first commit before the transition runs.
    const actEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    try {
      find("[data-switch]")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      )
      await until(
        async () =>
          findAll('[data-pane="route"] [data-slot="message-scroller-item"]').length === LONG,
        "every row of the chat asked for",
      )
      // The reads and effects the switch set going land before `act` is back.
      await new Promise((resolve) => setTimeout(resolve, 100))
      globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment
      await settle()
    } finally {
      globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment
      observer.disconnect()
    }
    assert.ok(drawn.length > 0, "the chat asked for was drawn")
    assert.ok(
      drawn[0] <= FIRST_ROWS && drawn[0] < LONG,
      `the first frame of it holds only its last ${FIRST_ROWS} rows, not ${drawn[0]} of ${LONG}`,
    )
    assert.ok(paneText().includes(`beta row ${LONG - 1}`), "and its newest row is among them")
    assert.equal(drawn.at(-1), LONG, "and every row lands after it")
  })
})
