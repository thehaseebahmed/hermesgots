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
