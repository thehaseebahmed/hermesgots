/**
 * The picture a canvas's list draws, chosen from the canvas's own options (issue #1074).
 *
 * The picker a canvas's face comes from opened with icons and emojis — one `mark` each, kept on the
 * record — and a canvas's picture is a field of the same record that nothing in the app ever wrote:
 * `image`, one inline data URL, which the list's tile prefers over the mark. So the picker gained a
 * tab of its own for it, and what a reader chooses there is read on the device, capped at the host's
 * own limit, and posted as the record's `image` — the host's answer is what the tab and the tile
 * then draw.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { act } from "react"
import { MemoryRouter } from "react-router"

import { CanvasOptions } from "@/components/canvas-consent"
import { cachedCanvas } from "@/lib/canvas-cache"
import { refreshCanvas, updateCanvas } from "@/lib/canvases"
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
  settle,
  until,
  wordsOf,
} from "./component-kit.tsx"

/** A 1×1 PNG: a picture the host takes whole, which is what a screenshot of a page often is not. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (one) => one.charCodeAt(0),
)

/** The record's own picture, as the host hands one back: one inline image, never a URL. */
const PICTURE = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`

const PLAIN = {
  id: "p1",
  title: "A pictured timetable",
  session_id: "gots-chat-p1",
  chat_id: "chat-p1",
  version: 1,
  pinned: true,
  archived: false,
  at: 30,
  created_at: 1,
}

const PICTURED = { ...PLAIN, id: "p2", image: PICTURE }

const options = (
  onUpdate: (changes: Record<string, unknown>) => Promise<void>,
  canvas: typeof PLAIN & { image?: string; mark?: string } = PLAIN,
  markable = true,
) => (
  <MemoryRouter initialEntries={["/canvas"]}>
    <CanvasOptions
      open
      onOpenChange={() => {}}
      canvas={canvas}
      vaultable={false}
      markable={markable}
      onGrant={async () => true}
      onUpdate={onUpdate}
      onDelete={async () => {}}
    />
  </MemoryRouter>
)

/** The picker, opened from the mark's own box, standing on its Picture tab. */
const openPictureTab = async () => {
  await until(async () => find("[data-canvas-options]") !== null, "the options")
  await click(find("[data-canvas-mark-open]"))
  await until(async () => find("[data-slot='tabs-trigger']") !== null, "the picker")
  await click(findText("[data-slot='tabs-trigger']", "Thumbnail"))
  await until(async () => find("[data-canvas-thumbnail]") !== null, "the thumbnail tab")
}

/** A width, drawn: `atWidth` hands back the test a width's own body, which a case inside a case runs. */
const at = (width: number, body: () => Promise<void>) => atWidth(width, body)()

/** A file chosen in the tab's own field, the way the browser hands one over. */
async function pick(file: File) {
  const field = find('input[type="file"]') as HTMLInputElement | null
  assert.ok(field, "the thumbnail tab offers a file to choose")
  Object.defineProperty(field, "files", { configurable: true, value: [file] })
  await act(async () => {
    field.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}

test("the picker's Thumbnail tab posts the chosen picture as the record's image", async () => {
  const changes: Record<string, unknown>[] = []
  await at(390, async () => {
    await mount(
      options(async (next) => void changes.push(next)),
      async () => {
        await openPictureTab()

        // A canvas with no picture says so, offers the one control that gives it one, and has
        // nothing to remove; the mark search stands down, since a picture is no set to narrow.
        assert.equal(
          find("[data-canvas-thumbnail]")?.getAttribute("data-canvas-thumbnail"),
          "none",
          "the tab draws the record's picture, and there is none",
        )
        assert.match(wordsOf(find("[data-canvas-thumbnail]")), /No thumbnail yet/)
        assert.equal(missing("[data-canvas-thumbnail-unset]"), true, "nothing to remove yet")
        assert.equal(
          missing('input[aria-label="Search icons"]'),
          true,
          "the icon search stands down",
        )
        assert.equal(
          missing('input[aria-label="Search emojis"]'),
          true,
          "and so does the emoji one",
        )
        assert.ok(find("[data-canvas-thumbnail-choose]"), "the way to give it one")

        await pick(new File([PNG], "tile.png", { type: "image/png" }))
        await until(async () => changes.length === 1, "the picture to be posted")
        assert.deepEqual(
          changes[0],
          { image: PICTURE },
          "one inline image on the record's own field, the file's bytes as they are",
        )
      },
    )
  })
})

test("the tab draws the picture the record holds, and its Remove clears the field", async () => {
  const changes: Record<string, unknown>[] = []
  await mount(
    options(async (next) => void changes.push(next), PICTURED),
    async () => {
      await openPictureTab()

      const preview = find("[data-canvas-thumbnail]")
      assert.equal(
        preview?.getAttribute("data-canvas-thumbnail"),
        "thumbnail",
        "the record's own thumbnail",
      )
      assert.equal(
        preview?.querySelector("img")?.getAttribute("src"),
        PICTURE,
        "drawn as the image itself, which is what the tile draws",
      )
      const remove = find("[data-canvas-thumbnail-unset]")
      assert.ok(remove, "a picture already there has a way off")
      assert.equal(remove?.textContent?.trim(), "Remove picture", "and says what it does")

      // The pair is one column of the app's actions: the same width, and the same thumb's height.
      // A DOM without layout can't measure the boxes, so it holds the classes a browser reads them by.
      const choose = find("[data-canvas-thumbnail-choose]")
      assert.equal(choose?.classList.contains("w-full"), true, "the way on spans the card")
      assert.equal(remove?.classList.contains("w-full"), true, "and so does the way off")
      assert.match(choose?.className ?? "", /\bh-11\b/, "both at the app's action height")
      assert.match(remove?.className ?? "", /\bh-11\b/, "the one the other wears")

      await click(remove)
      await until(async () => changes.length === 1, "the clear to be posted")
      assert.deepEqual(changes[0], { image: "" }, "an empty string, which is the host's own clear")
    },
  )
})

test("a file that isn't a picture is refused on its own tab, and nothing is posted", async () => {
  const changes: Record<string, unknown>[] = []
  await mount(
    options(async (next) => void changes.push(next)),
    async () => {
      await openPictureTab()
      await pick(new File(["not a picture"], "notes.txt", { type: "text/plain" }))

      const said = find("[data-canvas-thumbnail-said]")
      assert.ok(said, "the tab says what the file can't be")
      assert.match(wordsOf(said), /image file/, "in the words the encoder refused it with")
      assert.equal(changes.length, 0, "and the record is never posted a file it can't keep")
    },
  )
})

test("a phone and a desktop draw the same two tabs and the same thumbnail tab", async () => {
  const changes: Record<string, unknown>[] = []
  const draw = async (width: number) =>
    at(width, async () => {
      await mount(
        options(async (next) => void changes.push(next), PICTURED),
        async () => {
          await openPictureTab()
          const tabs = [...document.querySelectorAll("[data-slot='tabs-trigger']")].map((one) =>
            one.textContent?.trim(),
          )
          assert.deepEqual(tabs, ["Icon", "Thumbnail"], `${width}px draws the two ways`)
          assert.equal(
            find("[data-canvas-thumbnail] img")?.getAttribute("src"),
            PICTURE,
            `${width}px draws the record's picture`,
          )
          assert.equal(
            find("[data-canvas-thumbnail-choose]")?.textContent?.trim(),
            "Choose picture",
            `${width}px offers the same control in the same words`,
          )
        },
      )
    })
  await draw(390)
  await draw(1440)
})

/**
 * The clear is a write whose answer carries no `image` at all — the host's record has no field for a
 * picture it no longer holds — so the copy this device keeps is what the clear has to reach: folded
 * over the old copy, a record that says nothing about the picture would leave it there, and a canvas
 * opened with the host away would draw a picture its reader removed.
 */
test("clearing the picture takes it off the copy this device keeps", async () => {
  let image: string | undefined = PICTURE
  const record = () => ({
    ...PLAIN,
    id: "p9",
    at: image ? 20 : 21,
    ...(image ? { image } : {}),
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith("/info")) return json({ version: "0.114.0", features: ["canvas"] })
    if (/\/canvases\/[^/]+$/.test(url.pathname)) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { image?: string }
        if (body.image === "") image = undefined
        return json({ object: "gots.canvas", canvas: record() })
      }
      return json({ object: "gots.canvas", canvas: { ...record(), html: "<h1>Deck</h1>" } })
    }
    if (url.pathname.endsWith("/canvases"))
      return json({ object: "gots.canvases", canvases: [record()] })
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch

  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.put(botProfile("canvas-picture"))
  await refreshCanvas("p9")
  const bot = (await db.profiles.get("bot-1"))!
  assert.equal(
    (await cachedCanvas(bot, "p9"))?.image,
    PICTURE,
    "the copy this device keeps holds the picture",
  )

  await updateCanvas("p9", { image: "" })
  assert.equal(
    (await cachedCanvas(bot, "p9"))?.image,
    undefined,
    "and the clear takes it off that copy, not only off the host",
  )
})

/**
 * A host from before the mark (`canvas_mark` landed in #1067, above `MIN_PLUGIN_VERSION`) still
 * keeps the record's picture: the door opens on the one tab that host can honour, so a reader there
 * can give a canvas its face rather than being offered nothing at all.
 */
test("a host that keeps no mark still offers the canvas a picture", async () => {
  const changes: Record<string, unknown>[] = []
  await mount(
    options(async (next) => void changes.push(next), PLAIN, false),
    async () => {
      await until(async () => find("[data-canvas-options]") !== null, "the options")
      const box = find("[data-canvas-mark-open]")
      assert.equal(box?.hasAttribute("disabled"), false, "the box opens for the picture")
      await click(box)
      await until(async () => find("[data-canvas-thumbnail]") !== null, "the thumbnail tab")
      assert.deepEqual(
        [...document.querySelectorAll("[data-slot='tabs-trigger']")].map((one) =>
          one.textContent?.trim(),
        ),
        ["Thumbnail"],
        "one tab: the marks are the field this host has none for",
      )

      await pick(new File([PNG], "tile.png", { type: "image/png" }))
      await until(async () => changes.length === 1, "the picture to be posted")
      assert.deepEqual(changes[0], { image: PICTURE }, "posted as the record's own picture")
    },
  )
})
