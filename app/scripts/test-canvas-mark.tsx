/**
 * The mark a pinned canvas draws (issue #1065): the icon or the emoji its user chose, kept on the
 * canvas's own record so every device's sidebar shows the same one — and the app's frame mark where
 * nobody has chosen one, which is the row every canvas drew before a mark could be picked.
 *
 * The picker opens the way the model selector does — a menu anchored to the mark's own box on a
 * laptop and up, a sheet below that — with the tabs the Outputs sheet draws, "Canvas Icon" over
 * both, and one button under the grid to remove what is there.
 *
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { CanvasOptions } from "@/components/canvas-consent"
import { ConversationList } from "@/components/conversation-list"
import { db } from "@/lib/db"

import {
  atWidth,
  botProfile,
  click,
  find,
  json,
  missing,
  mount,
  seedSettings,
  type,
  until,
} from "./component-kit.tsx"

const MARKED = {
  id: "m1",
  title: "A marked timetable",
  session_id: "gots-chat-m1",
  chat_id: "chat-m1",
  version: 1,
  pinned: true,
  archived: false,
  mark: "heart",
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

/** The canvas one screen's options are drawn over: the record, as the app holds it. */
const CANVAS = {
  id: "p1",
  profileId: "bot-1",
  title: "A pinned timetable",
  version: 1,
  pinned: true,
  archived: false,
  vault: false,
  at: 1,
  createdAt: 1,
  sessionId: "gots-chat-p1",
  chatId: "chat-p1",
  canUndo: false,
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

      // The icon its record names, once the icons have landed, in the ink every row's mark takes.
      await until(
        async () => head("m1")?.tagName.toLowerCase() === "svg" && classes("m1").includes("lucide-heart"),
        "the heart its record names",
      )
      assert.match(classes("m1"), /\btext-muted-foreground\b/, "drawn in the row's own ink")
      assert.match(classes("m1"), /\bsize-5\b/, "one 20px slot, like every row's head")

      // An emoji is a mark too: the glyph itself, in the same slot.
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

const options = (onUpdate: (changes: Record<string, unknown>) => Promise<void>, markable = true) => (
  <MemoryRouter initialEntries={["/canvas"]}>
    <CanvasOptions
      open
      onOpenChange={() => {}}
      canvas={CANVAS}
      vaultable={false}
      markable={markable}
      onGrant={async () => true}
      onUpdate={onUpdate}
      onDelete={async () => {}}
    />
  </MemoryRouter>
)

const openPicker = async () => {
  await until(async () => find("[data-canvas-options]") !== null, "the options")
  await click(find("[data-canvas-mark-open]"))
  await until(async () => find('[data-canvas-mark-grid="icons"]') !== null, "the picker")
}

test("the options pick an icon, and the app's own mark", async () => {
  const changes: Record<string, unknown>[] = []

  await atWidth(390, async () => {
    await mount(
      options(async (next) => void changes.push(next)),
      async () => {
        await openPicker()

        // A search narrows the set, and the icon it names is the mark that is posted.
        await type(find('input[aria-label="Search icons"]'), "heart")
        const heart = find('[data-canvas-mark-grid="icons"] button[aria-label="Heart"]')
        await until(async () => heart !== null, "the heart")
        await click(heart)
        await until(async () => changes.length === 1, "the mark to be posted")
        assert.deepEqual(changes[0], { mark: "heart" })

        // The two ways the card offers: the icon just picked, and the thumbnail beside it.
        await click(find("[data-canvas-mark-open]"))
        await until(async () => find('[data-slot="tabs-trigger"]') !== null, "the picker again")
        assert.deepEqual(
          [...document.querySelectorAll('[data-slot="tabs-trigger"]')].map((one) =>
            one.textContent?.trim(),
          ),
          ["Icon", "Thumbnail"],
          "an icon and a thumbnail, and no third way",
        )

        // And the one button under the grid removes the icon, back to the app's own frame mark.
        await until(async () => find("[data-canvas-mark-unset]") !== null, "the remove button")
        assert.equal(
          find("[data-canvas-mark-unset]")?.textContent?.trim(),
          "Remove Icon",
          "the way back says what it does",
        )
        await click(find("[data-canvas-mark-unset]"))
        await until(async () => changes.length === 2, "the clear to be posted")
        assert.deepEqual(changes[1], { mark: "" })
      },
    )
  })
})

test("the picker is a menu beside its box on a laptop, and a sheet below it", async () => {
  // The model selector's own rule: an anchored menu from 1024px, a sheet under the thumb below it.
  const menu = () => find('[data-popup-form="menu"] [data-slot="canvas-mark-picker"]')
  const sheet = () => find('[data-popup-form="sheet"] [data-slot="canvas-mark-picker"]')
  for (const [width, drawn] of [
    [1280, "menu"],
    [1024, "menu"],
    [768, "sheet"],
    [390, "sheet"],
  ] as const) {
    await atWidth(width, async () => {
      await mount(
        options(async () => {}),
        async () => {
          await openPicker()
          assert.equal(
            Boolean(drawn === "menu" ? menu() : sheet()),
            true,
            `${width}px draws the picker as a ${drawn}`,
          )
          // One name for the card, centred, at every width.
          assert.equal(
            find("[data-canvas-mark-picker] h2")?.textContent?.trim(),
            "Canvas Appearance",
            "the card is named Canvas Appearance",
          )
        },
      )
    })
  }
})

test("the mark's own box opens the picker, with only what the host can keep", async () => {
  const changes: Record<string, unknown>[] = []
  await atWidth(390, async () => {
    // The card at the head of the name block is the mark: with nothing chosen the unset button is
    // doing nothing, so it is off.
    await mount(options(async (next) => void changes.push(next)), async () => {
      await openPicker()
      assert.equal(
        find("[data-canvas-mark-unset]")?.hasAttribute("disabled"),
        true,
        "no icon to remove on a canvas drawn with the app's own",
      )
    })
  })

  // A host whose record keeps no mark still keeps a picture, so the box opens the picker with the
  // one tab it can honour: the marks are what that host has no field for (issue #1074).
  await atWidth(390, async () => {
    await mount(options(async () => {}, false), async () => {
      await until(async () => find("[data-canvas-options]") !== null, "the options")
      const box = find("[data-canvas-mark-open]")
      assert.ok(box, "the canvas's own box is still drawn")
      assert.equal(box.hasAttribute("disabled"), false, "and opens what the host can still keep")
      await click(box)
      await until(async () => find("[data-canvas-picture]") !== null, "the picture tab")
      assert.deepEqual(
        [...document.querySelectorAll("[data-slot='tabs-trigger']")].map((one) =>
          one.textContent?.trim(),
        ),
        ["Thumbnail"],
        "one tab, since a mark is the field it has none for",
      )
      assert.equal(missing("[data-canvas-mark-grid='icons']"), true, "and no grid of icons")
      assert.equal(missing("[data-canvas-mark-unset]"), true, "nor a mark to remove")
    })
  })
})
