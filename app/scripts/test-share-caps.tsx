/**
 * The share screen's caps: what another app shared arrives as the message's attachments under the
 * same rule as a pick, and anything over it is refused in a toast naming the limit rather than
 * vanishing. The chain that puts a file here (Android's plugin, the PWA's service worker) cannot
 * run in this process, so what arrives is what this test hands it.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter, Route, Routes } from "react-router"
import { toast } from "sonner"

import { MAX_ATTACHMENTS, MAX_FILE_BYTES } from "@/lib/attachment-caps"
import { db } from "@/lib/db"
import { clearShare, receiveShare, toShare } from "@/lib/share"
import { SharePage } from "@/routes/share"

import { botProfile, mount, seedSettings, text, until } from "./component-kit.tsx"

const screen = () => (
  <MemoryRouter initialEntries={["/share"]}>
    <Routes>
      <Route path="/share" element={<SharePage />} />
    </Routes>
  </MemoryRouter>
)

// jsdom decodes no image and makes no object URL, so a photo has to be one the browser made a
// bitmap of, and its tile needs a URL to draw: both stand in for the browser's own effect.
globalThis.createImageBitmap = (async () => ({
  width: 2,
  height: 2,
  close: () => {},
})) as unknown as typeof createImageBitmap
URL.createObjectURL = () => "blob:shared-photo"
URL.revokeObjectURL = () => {}

async function seedBot() {
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.put(botProfile("share-caps"))
}

const tiles = () =>
  [...document.querySelectorAll("[aria-label^='Remove ']")].map((button) =>
    button.getAttribute("aria-label")!.replace("Remove ", ""),
  )

/** The share screen's refusals, collected from the toasts it shows. */
async function withToasts(body: (said: string[]) => Promise<void>) {
  const said: string[] = []
  const original = toast.error
  toast.error = ((message: unknown) => {
    said.push(String(message))
  }) as typeof toast.error
  try {
    await body(said)
  } finally {
    toast.error = original
    clearShare()
  }
}

test("a shared file over nine megabytes is refused, naming the limit", async () => {
  await seedBot()
  await withToasts(async (said) => {
    receiveShare(
      toShare({
        files: [new File([new Uint8Array(MAX_FILE_BYTES + 1)], "clip.mp4", { type: "video/mp4" })],
      }),
    )
    await mount(screen(), async () => {
      await until(async () => said.length > 0, "the refusal")
      assert.deepEqual(said, ["clip.mp4 is over the 9 MB limit."])
      assert.deepEqual(tiles(), [], "it never lands on the message")
      assert.doesNotMatch(text(), /clip\.mp4/)
    })
  })
})

test("a share's files land as attachments, a photo and a document alike", async () => {
  await seedBot()
  await withToasts(async (said) => {
    receiveShare(
      toShare({
        title: "Two files",
        files: [
          new File(["png"], "cat.png", { type: "image/png" }),
          new File(["pdf"], "report.pdf", { type: "application/pdf" }),
        ],
      }),
    )
    await mount(screen(), async () => {
      await until(async () => tiles().length === 2, "both tiles")
      assert.deepEqual(tiles(), ["cat.png", "report.pdf"])
      assert.deepEqual(said, [], "nothing was refused")
    })
  })
})

test("a share of more than ten files keeps ten and names the rest", async () => {
  await seedBot()
  await withToasts(async (said) => {
    const files = Array.from(
      { length: MAX_ATTACHMENTS + 2 },
      (_, index) => new File(["x"], `note-${index}.txt`, { type: "text/plain" }),
    )
    receiveShare(toShare({ files }))
    await mount(screen(), async () => {
      await until(async () => said.length > 0, "the refusal")
      assert.deepEqual(said, ["A message can carry 10 attachments, so 2 were left out."])
      await until(async () => tiles().length === MAX_ATTACHMENTS, "the ten it keeps")
    })
  })
})

test("a photo shared to a model with no image input still reads as a photo", async () => {
  // Without the plugin a photo has no other form to reach the model in, so the screen says why it
  // can't go: the bot's own answer decides how each file is read here, not the screen.
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.put(botProfile("share-no-images", { imageInput: false, apiKey: "" }))
  await withToasts(async () => {
    receiveShare(toShare({ files: [new File(["png"], "cat.png", { type: "image/png" })] }))
    await mount(screen(), async () => {
      await until(async () => tiles().length === 1, "the photo's tile")
      assert.match(text(), /can't take images/, "the screen refuses it rather than send it")
    })
  })
})

test("a photo lands as a photo for a model that takes images, and as its file for one that doesn't", async () => {
  const thumbnail = () =>
    Boolean(document.querySelector("[aria-label^='Remove ']")?.parentElement?.querySelector("img"))
  const photo = () => new File(["png"], "cat.png", { type: "image/png", lastModified: 3 })

  await seedBot()
  await withToasts(async () => {
    receiveShare(toShare({ files: [photo()] }))
    await mount(screen(), async () => {
      await until(async () => tiles().length === 1, "the photo's tile")
      assert.equal(thumbnail(), true, "a model that takes images gets the photo itself")
    })
  })

  // The same share to a bot whose model takes no images: the plugin can still carry it as a file.
  await seedSettings({ activeProfileId: "bot-1" })
  await db.profiles.clear()
  await db.profiles.put(botProfile("share-no-images", { imageInput: false }))
  await withToasts(async () => {
    receiveShare(toShare({ files: [photo()] }))
    await mount(screen(), async () => {
      await until(async () => tiles().length === 1, "the photo's tile")
      assert.equal(thumbnail(), false, "and one that doesn't gets the file it is")
    })
  })
})
