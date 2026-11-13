/**
 * The mark a pinned canvas draws (issue #1065): the icon or the emoji its user chose, kept on the
 * canvas's own record so every device's sidebar shows the same one — and the app's frame mark where
 * nobody has chosen one, which is the row every canvas drew before a mark could be picked.
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
  findText,
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

      // The icon its record names, in the colour the record names, once the icons have landed.
      await until(
        async () =>
          head("m1")?.tagName.toLowerCase() === "svg" && classes("m1").includes("lucide-heart"),
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

test("the options pick a mark, an emoji, and the app's own mark", async () => {
  // The picker is the options' own sheet: what it posts is the record's, so the sidebar redraws from
  // the host's answer rather than from anything this device kept.
  const changes: Record<string, unknown>[] = []

  await atWidth(390, async () => {
    await mount(
      <MemoryRouter initialEntries={["/canvas"]}>
        <CanvasOptions
          open
          onOpenChange={() => {}}
          canvas={CANVAS}
          vaultable={false}
          markable
          onGrant={async () => true}
          onUpdate={async (next) => void changes.push(next)}
          onDelete={async () => {}}
        />
      </MemoryRouter>,
      async () => {
        await until(async () => find("[data-canvas-options]") !== null, "the options")
        await click(find("[data-canvas-mark-row]"))
        await until(async () => find('[data-canvas-mark-grid="icons"]') !== null, "the icons")

        // A search narrows the set, and the icon it names is the mark that is posted.
        await type(find('input[aria-label="Search icons"]'), "heart")
        const heart = find('[data-canvas-mark-grid="icons"] button[aria-label="Heart"]')
        await until(async () => heart !== null, "the heart")
        await click(heart)
        await until(async () => changes.length === 1, "the mark to be posted")
        assert.deepEqual(changes[0], { mark: "heart", mark_tint: "" })

        // The emojis are the other tab of the same picker, and an emoji carries its own colour.
        await click(find("[data-canvas-mark-row]"))
        await click(findText('[data-slot="tabs-trigger"]', "Emojis"))
        await type(find('input[aria-label="Search emojis"]'), "party")
        const popper = find('[data-canvas-mark-grid="emojis"] button[aria-label^="Party popper"]')
        await until(async () => popper !== null, "the party popper")
        await click(popper)
        await until(async () => changes.length === 2, "the emoji to be posted")
        assert.deepEqual(changes[1], { mark: "🎉" })

        // A colour chosen before an icon is the colour that icon takes.
        await click(find("[data-canvas-mark-row]"))
        await click(find('[data-canvas-mark-tints] button[aria-label="coral"]'))
        await type(find('input[aria-label="Search icons"]'), "heart")
        const tinted = find('[data-canvas-mark-grid="icons"] button[aria-label="Heart"]')
        await until(async () => tinted !== null, "the heart again")
        await click(tinted)
        await until(async () => changes.length === 3, "the tinted mark to be posted")
        assert.deepEqual(changes[2], { mark: "heart", mark_tint: "coral" })

        // And the way back to the app's own frame mark.
        await click(find("[data-canvas-mark-row]"))
        await click(findText("button", "Use the app's own mark"))
        await until(async () => changes.length === 4, "the clear to be posted")
        assert.deepEqual(changes[3], { mark: "" })
      },
    )
  })
})

test("the picker is a floating menu on a big screen and a sheet on a phone", async () => {
  const form = () => find("[data-popup-form]")?.getAttribute("data-popup-form")
  for (const [width, expected] of [
    [1280, "menu"],
    [390, "sheet"],
  ] as const) {
    await atWidth(width, async () => {
      await mount(
        <MemoryRouter initialEntries={["/canvas"]}>
          <CanvasOptions
            open
            onOpenChange={() => {}}
            canvas={CANVAS}
            vaultable={false}
            markable
            onGrant={async () => true}
            onUpdate={async () => {}}
            onDelete={async () => {}}
          />
        </MemoryRouter>,
        async () => {
          await until(async () => find("[data-canvas-options]") !== null, "the options")
          await click(find("[data-canvas-mark-row]"))
          await until(async () => form() !== undefined, "the picker")
          assert.equal(
            form(),
            expected,
            `${width}px draws the picker as the ${expected} it is there`,
          )
        },
      )
    })
  }
})

test("a colour is written at once on an icon already chosen, and waits for one that isn't", async () => {
  const changes: Record<string, unknown>[] = []
  const open = async (canvas: typeof CANVAS) =>
    mount(
      <MemoryRouter initialEntries={["/canvas"]}>
        <CanvasOptions
          open
          onOpenChange={() => {}}
          canvas={canvas}
          vaultable={false}
          markable
          onGrant={async () => true}
          onUpdate={async (next) => void changes.push(next)}
          onDelete={async () => {}}
        />
      </MemoryRouter>,
      async () => {
        await until(async () => find("[data-canvas-options]") !== null, "the options")
        await click(find("[data-canvas-mark-row]"))
        await until(async () => find("[data-canvas-mark-tints]") !== null, "the palette")
      },
    )

  await atWidth(390, async () => {
    // An icon is wearing a colour, so a swatch is a change to the record the moment it is tapped.
    await open({ ...CANVAS, mark: "heart", markTint: "coral" })
    await click(find('[data-canvas-mark-tints] button[aria-label="blue"]'))
    await until(async () => changes.length === 1, "the colour to be posted")
    assert.deepEqual(changes[0], { mark_tint: "blue" })
    assert.equal(
      find('[data-canvas-mark-tints] button[aria-label="blue"]')?.getAttribute("aria-pressed"),
      "true",
      "the swatch reads as the one chosen",
    )

    // With no mark yet there is nothing to recolour: the swatch waits, and the icon picked next
    // takes the colour it was given.
    const before = changes.length
    await open(CANVAS)
    await click(find('[data-canvas-mark-tints] button[aria-label="green"]'))
    assert.equal(changes.length, before, "no write for a colour on a canvas with no mark")
    assert.equal(
      find('[data-canvas-mark-tints] button[aria-label="green"]')?.getAttribute("aria-pressed"),
      "true",
      "and the swatch still reads as chosen for the pick that follows",
    )
  })
})

test("a host whose record has no mark offers no mark row", async () => {
  // A picker whose writes the host would refuse is a promise it can't keep, so the row is the
  // host's to offer — the vault switch's own rule.
  await atWidth(390, async () => {
    await mount(
      <MemoryRouter initialEntries={["/canvas"]}>
        <CanvasOptions
          open
          onOpenChange={() => {}}
          canvas={CANVAS}
          vaultable={false}
          markable={false}
          onGrant={async () => true}
          onUpdate={async () => {}}
          onDelete={async () => {}}
        />
      </MemoryRouter>,
      async () => {
        await until(async () => find("[data-canvas-options]") !== null, "the options")
        assert.equal(missing("[data-canvas-mark-row]"), true, "no mark row without the host's answer")
      },
    )
  })
})
