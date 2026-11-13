/**
 * The mark a pinned canvas draws (issue #1065): the icon or the emoji its user chose, kept on the
 * canvas's own record so every device's sidebar shows the same one — and the app's frame mark where
 * nobody has chosen one, which is the row every canvas drew before a mark could be picked.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { ConversationList } from "@/components/conversation-list"
import { db } from "@/lib/db"

import { botProfile, find, json, mount, seedSettings, until } from "./component-kit.tsx"

const MARKED = {
  id: "m1",
  title: "A marked timetable",
  session_id: "gots-chat-m1",
  chat_id: "chat-m1",
  version: 1,
  pinned: true,
  archived: false,
  mark: "heart",
  mark_tint: "coral",
  at: 30,
  created_at: 1,
}

const EMOJI = {
  id: "m2",
  title: "A party plan",
  session_id: "gots-chat-m2",
  chat_id: "chat-m2",
  version: 1,
  pinned: true,
  archived: false,
  mark: "🎉",
  at: 20,
  created_at: 2,
}

const PLAIN = {
  id: "m3",
  title: "A plain timetable",
  session_id: "gots-chat-m3",
  chat_id: "chat-m3",
  version: 1,
  pinned: true,
  archived: false,
  at: 10,
  created_at: 3,
}

function serveCanvases() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.114.0", features: ["canvas"] })
    if (url.pathname.endsWith("/canvases"))
      return json({ object: "gots.canvases", canvases: [MARKED, EMOJI, PLAIN] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
}

async function seed() {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas-mark"))
}

const row = (id: string) => find(`a[data-canvas-pinned][href="/canvas/${id}"]`)
/** The row's head: the one slot the mark draws in. */
const head = (id: string) => row(id)?.firstElementChild ?? null
const classes = (id: string) => head(id)?.getAttribute("class") ?? ""

test("a pinned canvas draws the mark its user chose", async () => {
  serveCanvases()
  await seed()

  await mount(
    <MemoryRouter initialEntries={["/canvas"]}>
      <ConversationList />
    </MemoryRouter>,
    async () => {
      await until(async () => Boolean(row("m1") && row("m2") && row("m3")), "the pinned rows")

      // The icon its record names, in the colour the record names, once the icons have landed.
      await until(
        async () => head("m1")?.tagName.toLowerCase() === "svg" && classes("m1").includes("lucide-heart"),
        "the heart its record names",
      )
      assert.match(classes("m1"), /\btext-orange-500\b/, "drawn in the coral its record names")
      assert.match(classes("m1"), /\bsize-5\b/, "one 20px slot, like every row's head")

      // An emoji is a mark too, and carries its own colour: no icon, no tint.
      const emoji = head("m2")
      assert.equal(emoji?.tagName.toLowerCase(), "span", "an emoji draws as the glyph itself")
      assert.equal(emoji?.textContent, "🎉")
      assert.match(emoji?.getAttribute("class") ?? "", /\bsize-5\b/, "in the same 20px slot")

      // A canvas nobody marked is drawn exactly as it was before a mark existed: one svg and the
      // name, the frame's own mark, and no wrapper the mark's arrival added.
      assert.equal(row("m3")?.children.length, 2, "the head and the name, as before")
      assert.equal(head("m3")?.tagName.toLowerCase(), "svg")
      assert.equal(classes("m3"), "lucide lucide-frame size-5 text-muted-foreground")
      assert.equal(row("m3")?.children[1]?.textContent, PLAIN.title)
    },
  )
})
