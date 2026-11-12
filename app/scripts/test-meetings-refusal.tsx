/**
 * A meeting's write that the host refuses says so on the screen that caused it: the sheet that added
 * the file, the question that asked to delete, and the meeting's own column where Try again stands.
 * Nothing is said in passing, so the words are still there when the reader looks back at the control.
 */
import assert from "node:assert/strict"
import { act } from "react"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"

import { MeetingPage, MeetingsPage } from "@/routes/meetings"
import { db } from "@/lib/db"

import {
  atWidth,
  botProfile,
  click,
  findAll,
  find,
  findText,
  json,
  labelled,
  mount,
  seedSettings,
  until,
  withToasts,
  wordsOf,
} from "./component-kit.tsx"

/** What the host says when it refuses a write: its own sentence, which the screen must draw. */
const SAID = "This meeting's transcript is still being written, so nothing can change it yet."

const SRT = `1
00:00:01,000 --> 00:00:04,000
Welcome to the retro.

2
00:00:05,500 --> 00:00:09,000
What went well this sprint?
`

/** A meeting as the plugin lists it, before its transcript and notes are read. */
const row = (id: string, title: string, patch: Record<string, unknown> = {}) => ({
  id,
  title,
  kind: "transcript",
  stage: "ready",
  parts: 0,
  parts_stored: 0,
  parts_done: 0,
  error: null,
  duration: 9,
  created_at: 1_000,
  updated_at: 1_000,
  ...patch,
})

/**
 * A bot's plugin with these meetings, whose writes refuse in the host's own words while `refusal`
 * stands — the host a screen has to answer for.
 */
function host(rows: Record<string, unknown>[], refusal?: string) {
  const calls: string[] = []
  let refuses = refusal
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push(`${method} ${url.pathname}`)
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", features: ["meetings"] })
    if (url.pathname.endsWith("/plugins/gots/projects")) return json({ projects: [] })
    if (refuses && method === "POST" && url.pathname.includes("/meetings"))
      return json({ error: { message: refuses } }, 400)
    if (url.pathname.endsWith("/plugins/gots/meetings") && method === "GET")
      return json({ object: "gots.meetings", meetings: rows, unavailable: null })
    const one = /\/meetings\/([^/]+)$/.exec(url.pathname)
    if (one && method === "GET") {
      const found = rows.find((meeting) => meeting.id === decodeURIComponent(one[1]))
      return found
        ? json({ meeting: { ...found, transcript: [], notes: null, chat: [] } })
        : json({ error: { message: "No such meeting." } }, 404)
    }
    return json({ error: { message: `no route for ${url.pathname}` } }, 404)
  }
  return { fetch, calls, allow: () => void (refuses = undefined) }
}

/** The one bot whose plugin these meetings live on, and the screen's way in. */
async function seed(plugin: ReturnType<typeof host>) {
  await seedSettings({ developer: true, meetings: true, activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.bulkPut([botProfile("a", { id: "bot-1", botId: "bot-1", name: "A bot" })])
  globalThis.fetch = plugin.fetch as typeof fetch
}

const screen = (at: string) => (
  <MemoryRouter initialEntries={[at]}>
    <Routes>
      <Route path="meetings" element={<MeetingsPage />} />
      <Route path="meetings/:id" element={<MeetingPage />} />
    </Routes>
  </MemoryRouter>
)

/** The refusal a screen draws: an error notice carrying the one control that takes it away. */
const notice = () =>
  findAll('[role="alert"]').find((one) => one.querySelector('button[aria-label="Dismiss"]')) ?? null
const sheet = () => find('[role="dialog"]')

test(
  "a refused add says so in the sheet",
  atWidth(390, async () => {
    const plugin = host([], SAID)
    await seed(plugin)
    await withToasts(async (said) => {
      await mount(screen("/meetings"), async () => {
        await until(async () => Boolean(findText("button", "New meeting")), "the list's button")
        await click(findText("button", "New meeting"))
        await until(async () => Boolean(find('[role="tab"]')), "the new-meeting sheet")
        await click(findText('[role="tab"]', "Upload"))
        const input = find('input[type="file"]')
        assert.ok(input, "the sheet offers a file")
        await act(async () => {
          Object.defineProperty(input, "files", {
            configurable: true,
            value: [new File([SRT], "retro.srt", { type: "application/x-subrip" })],
          })
          input.dispatchEvent(new Event("change", { bubbles: true }))
        })
        const add = findAll("button").find((one) => one.textContent?.trim() === "Add")
        await until(async () => Boolean(add) && !add.hasAttribute("disabled"), "the Add the file readies")
        // The form's own submit, since a DOM without a browser does not submit on the button's click.
        await act(async () => {
          add!.closest("form")!.dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          )
        })
        await until(async () => Boolean(notice()), "the sheet's refusal")
        assert.equal(wordsOf(notice()), SAID, "the host's own sentence")
        assert.ok(
          sheet()?.contains(notice()!),
          "drawn in the sheet that asked, not over the list behind it",
        )
        assert.deepEqual(said, [], "and nothing said in passing")
      })
    })
  }),
)

test(
  "a refused delete says so in the question",
  atWidth(390, async () => {
    const plugin = host([row("m-delete", "Weekly retro")], SAID)
    await seed(plugin)
    await withToasts(async (said) => {
      await mount(screen("/meetings/m-delete"), async () => {
        await until(async () => Boolean(labelled("button", "Meeting options")), "the meeting's menu")
        await click(labelled("button", "Meeting options"))
        await until(async () => Boolean(find('[role="menuitem"]')), "the menu open")
        await click(findAll('[role="menuitem"]').find((one) => one.textContent?.includes("Delete")))
        await until(async () => Boolean(find('[role="alertdialog"]')), "the question")
        await click(findText('[role="alertdialog"] button', "Delete"))
        await until(async () => Boolean(notice()), "the question's refusal")
        assert.equal(wordsOf(notice()), SAID, "the host's own sentence")
        assert.ok(
          find('[role="alertdialog"]')?.contains(notice()!),
          "drawn in the question that asked, which stays up",
        )
        assert.deepEqual(said, [], "and nothing said in passing")
      })
    })
  }),
)

test(
  "a refused try again says so where Try again is",
  atWidth(390, async () => {
    const plugin = host(
      [
        row("m-retry", "Standup", {
          kind: "audio",
          stage: "transcribing",
          parts: 3,
          parts_stored: 3,
          parts_done: 1,
          error: "The host couldn't transcribe part 2 of 3.",
        }),
      ],
      SAID,
    )
    await seed(plugin)
    await withToasts(async (said) => {
      await mount(screen("/meetings/m-retry"), async () => {
        await until(async () => Boolean(findText("button", "Try again")), "Try again")
        const button = findText("button", "Try again")!
        await click(button)
        await until(async () => Boolean(notice()), "the column's refusal")
        assert.equal(wordsOf(notice()), SAID, "the host's own sentence")
        assert.ok(
          notice()!.compareDocumentPosition(findText("button", "Try again")!) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          "drawn in the meeting's own column, above the control that was refused",
        )
        assert.deepEqual(said, [], "and nothing said in passing")
      })
    })
  }),
)
