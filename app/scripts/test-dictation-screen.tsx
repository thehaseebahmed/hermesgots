/**
 * Settings › Dictation over a seeded mirror and faked hosts, as ADR 0060 draws it: three tabs in one
 * screen, History first; its rows newest first, a card of them under each month's caption, each row
 * the words over the bot and the count; a page drawn at a time and more appended at its end; a row
 * opening its sheet with the whole dictation, a Copy
 * that copies it and a Delete that takes it off its host; every bot listed in the list's own order,
 * the ones whose host can't dictate disabled with the host's reason; the totals pooled over the bots
 * that reported; and opening the screen reconciling a bot whose host has more than the mirror holds,
 * while a host without the routes leaves the mirror and its cached totals alone.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"
import { act } from "react"

import { DictationSettings, PAGE_ROWS } from "@/components/settings/dictation"
import { Screen } from "@/components/settings-chrome"
import { connectionKey } from "@/lib/connection"
import { spelledCount, monthLabel } from "@/lib/dictation-log"
import { db } from "@/lib/db"
import { botProfile, click, find, findAll, json, mount, seedSettings, text, until } from "./component-kit.tsx"

const at = (year: number, month: number, day: number, hour = 9) =>
  new Date(year, month - 1, day, hour).getTime()

/** The browser's observer, stood in for: it records what it watches and the test fires it. */
const watched: (() => void)[] = []
class Watched {
  private readonly fire: (entries: { isIntersecting: boolean }[]) => void
  constructor(fire: (entries: { isIntersecting: boolean }[]) => void) {
    this.fire = fire
  }
  observe() {
    watched.push(() => this.fire([{ isIntersecting: true }]))
  }
  disconnect() {}
}
;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Watched

/** A row as a host answers for it; `seenAt` is when that host heard it, and defaults to `at`. */
type Hosted = {
  id: string
  text: string
  words: number
  ms: number
  at: number
  seenAt?: number
}

/** When a host heard a row: its own stamp, or the take's where the fixture does not set one. */
const seen = (row: Hosted) => row.seenAt ?? row.at

/** One bot as its host answers for it: what it advertises, and what its log holds. */
type Bot = {
  name: string
  label?: string
  features?: string[]
  rows?: Hosted[]
  /** The clear stamp the host reports, for a log cleared from another device. */
  clearedAt?: number
  /** What the host says about dictating at all: the reason it can't, where it can't. */
  dictation?: { ready: boolean; reason: string | null }
  /** The speech model its host reports, read by the bots tab's own refresh. */
  model?: string
  /** The model already on the bot, as an earlier read left it. */
  known?: string
  /** A host that never answers, so the row is caught mid-read. */
  stalls?: boolean
  /** A host whose speech read comes back a failure. */
  fails?: boolean
}

/** What a host says about its own log: the totals and the fingerprint beside them. */
function statsOf(bot: Bot) {
  const rows = [...(bot.rows ?? [])].sort((one, two) => seen(two) - seen(one))
  return {
    words: rows.reduce((total, row) => total + row.words, 0),
    ms: rows.reduce((total, row) => total + row.ms, 0),
    count: rows.length,
    newest: rows[0] ? seen(rows[0]) : null,
    oldest: rows.at(-1) ? seen(rows.at(-1)) : null,
    clearedAt: bot.clearedAt ?? 0,
  }
}

const pluginPath = "/api/plugins/memento"

function host(bots: Bot[]) {
  const calls: { path: string; method: string }[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    const bot = bots.find((one) => url.hostname === `${one.name}.test`)
    if (!bot) return json({}, 404)
    if (url.pathname.endsWith(`${pluginPath}/info`))
      return json({
        features:
          bot.model !== undefined || bot.stalls
            ? [...new Set([...(bot.features ?? []), "speech_model"])]
            : (bot.features ?? []),
        dictation: bot.dictation ?? { ready: true, reason: null },
      })
    if (url.pathname.endsWith(`${pluginPath}/speech`)) {
      calls.push({ path: url.pathname, method })
      if (bot.stalls) return new Promise<Response>(() => {})
      if (bot.fails) return json({ error: { message: "No speech here." } }, 500)
      return json({
        speech: {
          model: bot.model ?? "",
          models: [],
          cleanup: { model: null, allowed: false, reason: null },
        },
      })
    }
    const known = (bot.features ?? []).includes("dictations")
    if (url.pathname.endsWith(`${pluginPath}/dictations/stats`)) {
      calls.push({ path: url.pathname, method })
      if (!known) return json({}, 404)
      return json({ stats: statsOf(bot) })
    }
    if (url.pathname.endsWith(`${pluginPath}/dictations`)) {
      calls.push({ path: url.pathname, method })
      if (!known) return json({}, 404)
      if (method === "DELETE") {
        bot.rows = []
        bot.clearedAt = Date.now()
        return json({ removed: true, stats: statsOf(bot) })
      }
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Hosted
        if (!body.id) return json({ error: { message: "A dictation needs an id." } }, 400)
        const stored = { ...body, seenAt: seen(body) }
        bot.rows = [stored, ...(bot.rows ?? []).filter((row) => row.id !== body.id)]
        return json({ dictation: stored }, 201)
      }
      const before = url.searchParams.get("before")
      const beforeId = url.searchParams.get("before_id")
      const limit = Number(url.searchParams.get("limit") ?? 50)
      const rows = [...(bot.rows ?? [])]
        .sort((one, two) => seen(two) - seen(one) || (one.id < two.id ? 1 : -1))
        .filter(
          (row) =>
            before === null ||
            beforeId === null ||
            seen(row) < Number(before) ||
            (seen(row) === Number(before) && row.id < beforeId),
        )
        .slice(0, limit)
      return json({ dictations: rows })
    }
    if (url.pathname.includes(`${pluginPath}/dictations/`)) {
      calls.push({ path: url.pathname, method })
      if (!known) return json({}, 404)
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "")
      bot.rows = (bot.rows ?? []).filter((row) => row.id !== id)
      return json({ removed: true, stats: statsOf(bot) })
    }
    return json({}, 404)
  }
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

/** Each test's bots answer on their own connection, so one test's answers never reach the next. */
let connections = 0

async function seed(bots: Bot[]) {
  const apiKey = `test-key-${connections++}`
  await seedSettings()
  await db.profiles.clear()
  await db.dictationLog.clear()
  await db.dictationStats.clear()
  for (const bot of bots) {
    const profile = botProfile(bot.name, {
      id: bot.name,
      name: bot.label ?? bot.name,
      speechModel: bot.known,
      apiKey,
    })
    await db.profiles.put(profile)
    for (const row of bot.rows ?? [])
      await db.dictationLog.put({
        ...row,
        seenAt: seen(row),
        loggedAt: seen(row),
        connection: connectionKey(profile),
        posted: true,
      })
  }
  const server = host(bots)
  globalThis.fetch = server.fetch
  return server.calls
}

const screen = () => (
  <MemoryRouter>
    <Screen title="Dictation">
      <DictationSettings />
    </Screen>
  </MemoryRouter>
)

/** The sheet's heading is a bare time of day, formatted the way the screen formats it. */
const clockOf = (value: number) =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value)

const history = () => find("[data-dictation-history]")
const botsTab = () => find("[data-dictation-bots]")
const statsTab = () => find("[data-dictation-stats]")

const tab = (name: string) =>
  findAll('[role="tab"]').find((one) => one.textContent?.trim() === name) ?? null
const openTab = async (name: string) => {
  await click(tab(name))
  await until(async () => Boolean(find(`[data-dictation-${name.toLowerCase()}]`)), `the ${name} tab`)
}

/** The captions over the History tab's cards, in the order it draws them. */
const captions = () => findAll("[data-dictation-history] p").map((node) => node.textContent?.trim() ?? "")

/** The dictation rows themselves, newest first as the screen draws them. */
const rows = () => findAll("[data-dictation-history] button[data-dictation]")
const rowText = (index: number) => (rows()[index]?.textContent ?? "").trim()

const sheet = () => find("[data-dictation-text]")
const copyButton = () => find("[data-dictation-copy]")
const deleteButton = () => find("[data-dictation-delete]")
/** A button inside the destructive confirmation, never the one that opened it. */
const dialogButton = (label: string) =>
  findAll('[role="alertdialog"] button').find((one) => one.textContent?.trim() === label) ?? null

const statValue = (name: string) => {
  const row = find(`[data-setting="${name}"]`)
  const leaves = [...(row?.querySelectorAll("span") ?? [])].filter((span) => !span.querySelector("*"))
  return leaves.at(-1)?.textContent?.trim() ?? null
}
const statTitle = (name: string) => {
  const row = find(`[data-setting="${name}"]`)
  const leaves = [...(row?.querySelectorAll("span") ?? [])].filter((span) => !span.querySelector("*"))
  return leaves[0]?.textContent?.trim() ?? null
}

const botRow = (id: string) => find(`[data-dictation-bot="${id}"]`)

let copied: string[] = []
Object.defineProperty(globalThis.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      copied.push(text)
    },
  },
})

test("the screen draws three tabs in one address, History first", async () => {
  await seed([{ name: "a", features: ["dictations"] }])
  await mount(screen(), async () => {
    assert.deepEqual(
      findAll('[role="tab"]').map((one) => one.textContent?.trim()),
      ["History", "Bots", "Stats"],
      "the three the ask names, in its order",
    )
    assert.equal(tab("History")?.getAttribute("aria-selected"), "true", "History is what opens")
    assert.ok(history(), "and its panel is the one drawn")
    assert.equal(botsTab(), null, "with the others closed")
    assert.equal(statsTab(), null, "both of them")
  })
})

test("History keeps the dictations newest first, a card of them under each month", async () => {
  await seed([
    {
      name: "a",
      label: "Aria",
      features: ["dictations"],
      rows: [
        { id: "oct-late", text: "Send the invoice to Nadia", words: 5, ms: 2_400, at: at(2026, 10, 24, 16) },
        { id: "oct-early", text: "Remind me about the car", words: 5, ms: 2_000, at: at(2026, 10, 2, 9) },
        { id: "sep", text: "Book the flights", words: 3, ms: 1_600, at: at(2026, 9, 28, 11) },
      ],
    },
  ])
  await mount(screen(), async () => {
    await until(async () => rows().length === 3, "the three dictations")
    assert.deepEqual(
      captions(),
      [monthLabel(at(2026, 10, 24)), monthLabel(at(2026, 9, 28))],
      "one caption per month, newest month first",
    )
    assert.deepEqual(
      rows().map((one) => one.getAttribute("data-dictation")),
      ["oct-late", "oct-early", "sep"],
      "within a month the newer dictation sits first",
    )
    const first = rowText(0)
    assert.match(first, /Send the invoice to Nadia/, "the words themselves lead the row")
    assert.match(first, /Aria · 5 words/, "then the bot that heard them and how many they are")
    assert.doesNotMatch(first, /\d{1,2}:\d{2}/, "with the time left to the sheet")
  })
})

test("a take is placed by when its host heard it, and shows when it was said", async () => {
  // This device's clock was a month behind when the first take was spoken; its host heard it late in
  // October, which is where the log puts it. The sheet still says when it was actually said.
  const said = at(2026, 9, 28, 11)
  await seed([
    {
      name: "a",
      label: "Aria",
      features: ["dictations"],
      rows: [
        { id: "slow-clock", text: "Said on a slow clock", words: 4, ms: 1_200, at: said, seenAt: at(2026, 10, 24, 9) },
        { id: "oct", text: "Said and heard in October", words: 4, ms: 1_100, at: at(2026, 10, 2, 9) },
      ],
    },
  ])
  await mount(screen(), async () => {
    await until(async () => rows().length === 2, "both dictations")
    assert.deepEqual(
      captions(),
      [monthLabel(at(2026, 10, 24))],
      "one card, under the month they were logged in",
    )
    assert.deepEqual(
      rows().map((one) => one.getAttribute("data-dictation")),
      ["slow-clock", "oct"],
      "the take heard last is on top, though its own clock is a month behind",
    )
    await click(rows()[0] ?? null)
    await until(async () => Boolean(sheet()), "its sheet")
    assert.ok(
      text().includes(clockOf(said)),
      "the sheet carries when the words were said, not when the host heard them",
    )
  })
})

test("a row opens its dictation whole, a Copy that copies it", async () => {
  copied = []
  const text = "Draft the reply to Haseeb and keep it to two lines.\nThen send it."
  await seed([
    { name: "a", label: "Aria", features: ["dictations"], rows: [{ id: "one", text, words: 12, ms: 6_000, at: at(2026, 10, 24) }] },
  ])
  await mount(screen(), async () => {
    await until(async () => rows().length === 1, "the dictation")
    await click(rows()[0] ?? null)
    await until(async () => Boolean(sheet()), "the dictation's sheet")
    assert.equal(sheet()?.textContent, text, "the sheet holds every word, the line break included")
    assert.equal(
      find("[data-dictation-text]")?.nextElementSibling?.textContent?.trim(),
      "Aria · 12 words · 6.0s spoken",
      "bot, words and how long they took, with the clock in the heading and not here",
    )
    assert.ok(
      deleteButton()?.compareDocumentPosition(copyButton() ?? deleteButton()!) ===
        Node.DOCUMENT_POSITION_FOLLOWING,
      "Delete on the left, Copy on the right",
    )
    await click(copyButton())
    await until(async () => copied.length === 1, "the copy")
    assert.deepEqual(copied, [text], "the whole dictation is what went to the clipboard")
    await until(async () => (copyButton()?.textContent ?? "").includes("Copied"), "the button to say it copied")
  })
})

test("Delete in a dictation's sheet takes it off its host and out of the mirror", async () => {
  const calls = await seed([
    {
      name: "a",
      features: ["dictations"],
      rows: [
        { id: "keep", text: "Keep this one", words: 3, ms: 1_200, at: at(2026, 10, 24) },
        { id: "gone", text: "Delete this one", words: 3, ms: 1_200, at: at(2026, 10, 20) },
      ],
    },
  ])
  await mount(screen(), async () => {
    await until(async () => rows().length === 2, "both dictations")
    await click(findAll("[data-dictation-history] button[data-dictation]")[1] ?? null)
    await until(async () => Boolean(sheet()), "the sheet")
    await click(deleteButton())
    await until(async () => Boolean(find('[role="alertdialog"]')), "the confirmation")
    await click(dialogButton("Delete"))
    await until(async () => rows().length === 1, "the row to go")
    assert.ok(
      calls.some((one) => one.method === "DELETE" && one.path.endsWith("/dictations/gone")),
      "the host was asked for that one id",
    )
    assert.equal(await db.dictationLog.get("gone"), undefined, "and the mirror forgot it")
    assert.ok(await db.dictationLog.get("keep"), "the dictation beside it stays")
  })
})

test("Clear history empties every bot's log, this device's and theirs", async () => {
  const calls = await seed([
    {
      name: "a",
      features: ["dictations"],
      rows: [{ id: "a1", text: "One from A", words: 3, ms: 1_000, at: at(2026, 10, 24) }],
    },
    {
      name: "b",
      features: ["dictations"],
      rows: [{ id: "b1", text: "One from B", words: 3, ms: 1_000, at: at(2026, 10, 23) }],
    },
  ])
  await mount(screen(), async () => {
    await until(async () => rows().length === 2, "both bots' dictations")
    await click(find('[aria-label="Clear history"]'))
    await until(async () => Boolean(find('[role="alertdialog"]')), "the confirmation")
    await click(dialogButton("Clear"))
    await until(async () => rows().length === 0, "the history to empty")
    const cleared = calls.filter((one) => one.method === "DELETE" && one.path.endsWith("/dictations"))
    assert.equal(cleared.length, 2, "each bot's own log was taken away")
    assert.equal(await db.dictationLog.count(), 0, "and nothing is left on this device")
  })
})

test("Bots lists every bot as a row into its speech settings, saying what its host hears on", async () => {
  await seed([
    {
      name: "a",
      label: "Aria",
      features: ["dictation", "dictations"],
      known: "whisper-large-v3",
      model: "whisper-large-v3",
    },
    {
      name: "b",
      label: "Older",
      features: [],
      dictation: { ready: false, reason: "Speech-to-text is off in Hermes" },
      known: "",
    },
  ])
  await mount(screen(), async () => {
    await openTab("Bots")
    const aria = botRow("a")
    const older = botRow("b")
    assert.ok(aria && older, "both bots are on the tab")
    assert.deepEqual(
      [aria?.getAttribute("data-dictation-bot"), older?.getAttribute("data-dictation-bot")],
      ["a", "b"],
      "in the list's own order",
    )
    assert.equal(aria?.tagName, "A", "a bot with speech is a link")
    assert.equal(
      aria?.getAttribute("href"),
      "/settings/bots/a/speech-to-text",
      "to its own speech settings",
    )
    assert.match(aria?.textContent ?? "", /On · whisper-large-v3/, "what its host hears on")
    assert.equal(older?.tagName, "A", "a bot whose host can't dictate is a link too")
    assert.match(
      older?.textContent ?? "",
      /Speech-to-text is off in Hermes/,
      "with the host's own reason in place of the status",
    )
  })
})

test("a bot whose host reports no model says Off", async () => {
  await seed([{ name: "a", label: "Aria", features: ["dictation", "dictations"], known: "" }])
  await mount(screen(), async () => {
    await openTab("Bots")
    await until(
      async () => /Off/.test(botRow("a")?.textContent ?? ""),
      "the row saying its host hears on nothing",
    )
  })
})

test("a bot whose model is still being read says Checking…", async () => {
  await seed([{ name: "a", label: "Aria", features: ["dictation", "dictations"], stalls: true }])
  await mount(screen(), async () => {
    await openTab("Bots")
    assert.match(botRow("a")?.textContent ?? "", /Checking…/, "the line until the host answers")
  })
})

test("a bot whose speech read failed says so, not nothing", async () => {
  await seed([
    {
      name: "a",
      label: "Aria",
      features: ["dictation", "dictations"],
      model: "base.en",
      fails: true,
    },
  ])
  await mount(screen(), async () => {
    await openTab("Bots")
    await until(
      async () => /Couldn't read this bot's host/.test(botRow("a")?.textContent ?? ""),
      "the row saying the read failed",
    )
  })
})

test("opening the Bots tab fills the model its host reports onto the bot", async () => {
  await seed([{ name: "a", label: "Aria", features: ["dictation", "dictations"], model: "base.en" }])
  await mount(screen(), async () => {
    await openTab("Bots")
    await until(async () => (await db.profiles.get("a"))?.speechModel === "base.en", "the model kept")
    await until(async () => /On · base\.en/.test(botRow("a")?.textContent ?? ""), "the row's line")
  })
})

test("History draws a page at a time and appends the rest at its end", async () => {
  const takes = Array.from({ length: PAGE_ROWS + 1 }, (_, index) => ({
    id: `take-${index}`,
    text: `Take ${index}`,
    words: 1,
    ms: 1_000,
    at: at(2026, 10, 24) + index * 60_000,
  }))
  await seed([{ name: "a", label: "Aria", features: ["dictations"], rows: takes }])
  await mount(screen(), async () => {
    await until(async () => rows().length === PAGE_ROWS, "one page of them")
    await act(async () => {
      watched.pop()?.()
    })
    await until(async () => rows().length === PAGE_ROWS + 1, "the dictation past the page")
  })
})

test("Stats pools every bot's totals into one rate over the sum of the minutes", async () => {
  await seed([
    {
      name: "a",
      features: ["dictations"],
      rows: [
        { id: "a1", text: "x", words: 300, ms: 90_000, at: at(2026, 10, 24) },
        { id: "a2", text: "y", words: 100, ms: 60_000, at: at(2026, 10, 20) },
      ],
    },
    {
      name: "b",
      features: ["dictations"],
      rows: [{ id: "b1", text: "z", words: 200, ms: 150_000, at: at(2026, 10, 18) }],
    },
  ])
  await mount(screen(), async () => {
    await openTab("Stats")
    await until(async () => statValue("words-spoken") === spelledCount(600), "the pooled words")
    assert.equal(statTitle("words-spoken"), "Words spoken", "the first card row names the words")
    assert.equal(
      statValue("words-per-minute"),
      String(Math.round(600 / ((90_000 + 60_000 + 150_000) / 60_000))),
      "600 words over five minutes is 120 a minute, pooled and not averaged per take",
    )
    assert.equal(statTitle("words-per-minute"), "Words per minute", "and the second names the rate")
    assert.match(
      find('[data-setting="words-spoken"]')?.textContent ?? "",
      /Every word you've spoken so far/,
      "each row says what it counts",
    )
    assert.match(
      find('[data-setting="words-per-minute"]')?.textContent ?? "",
      /This is your pooled pace/,
      "in its own line under the title",
    )
  })
})

test("nothing counted yet reads as no words and no rate", async () => {
  await seed([{ name: "a", features: ["dictations"] }])
  await mount(screen(), async () => {
    await openTab("Stats")
    await until(async () => statValue("words-spoken") === "0", "the empty total")
    assert.equal(statValue("words-per-minute"), "—", "a rate with nothing to divide is no rate")
    assert.equal(statsTab()?.querySelectorAll("[data-setting]").length, 2, "the two rows, and no line under them")
  })
})

test("opening the screen fills a mirror that a host has more in", async () => {
  await seed([
    {
      name: "a",
      features: ["dictations"],
      rows: [
        { id: "fresh", text: "From another device", words: 3, ms: 1_500, at: at(2026, 10, 25) },
        { id: "known", text: "This one is here", words: 4, ms: 1_800, at: at(2026, 10, 24) },
      ],
    },
  ])
  // The mirror holds the older one only: the other device's write is what a reconcile brings in.
  await db.dictationLog.clear()
  const profile = await db.profiles.get("a")
  assert.ok(profile)
  await db.dictationLog.put({
    id: "known",
    connection: connectionKey(profile),
    text: "This one is here",
    words: 4,
    ms: 1_800,
    at: at(2026, 10, 24),
    loggedAt: at(2026, 10, 24),
    posted: true,
  })
  await mount(screen(), async () => {
    await until(async () => rows().length === 2, "the host's newer dictation")
    assert.ok(await db.dictationLog.get("fresh"), "it is in the mirror now")
    const cached = await db.dictationStats.get(connectionKey(profile))
    assert.equal(cached?.count, 2, "and the totals came with it")
    assert.equal(cached?.words, 7, "the words of both")
  })
})

test("a take its host never received is kept, and posted again at the next open", async () => {
  const calls = await seed([{ name: "a", label: "Aria", features: ["dictations"] }])
  const profile = await db.profiles.get("a")
  assert.ok(profile)
  await db.dictationLog.put({
    id: "lonely",
    connection: connectionKey(profile),
    text: "Said while the host was away",
    words: 6,
    ms: 2_000,
    at: at(2026, 10, 24),
    loggedAt: at(2026, 10, 24),
    posted: false,
  })
  await mount(screen(), async () => {
    await until(async () => rows().length === 1, "the take the mirror keeps")
    await until(
      async () => calls.some((one) => one.method === "POST"),
      "the take its host never answered for, posted again",
    )
    assert.ok((await db.dictationLog.get("lonely"))?.posted, "and marked as its host's copy now")
  })
})

test("a host without the routes leaves the mirror and its cached totals alone", async () => {
  await seed([
    {
      name: "a",
      features: [],
      rows: [{ id: "old", text: "Kept from when it could", words: 5, ms: 2_000, at: at(2026, 10, 24) }],
    },
  ])
  await db.dictationLog.clear()
  const profile = await db.profiles.get("a")
  assert.ok(profile)
  const key = connectionKey(profile)
  await db.dictationLog.put({
    id: "old",
    connection: key,
    text: "Kept from when it could",
    words: 5,
    ms: 2_000,
    at: at(2026, 10, 24),
    loggedAt: at(2026, 10, 24),
    posted: true,
  })
  await db.dictationStats.put({ id: key, words: 5, ms: 2_000, count: 1, clearedAt: 0 })
  await mount(screen(), async () => {
    await until(async () => rows().length === 1, "the row it already held")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    assert.ok(await db.dictationLog.get("old"), "a 404 is not a clear: the row stays")
    assert.equal((await db.dictationStats.get(key))?.words, 5, "and the last report stands")
  })
})
