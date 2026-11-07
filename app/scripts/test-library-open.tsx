/**
 * A library's files open the way the app opens any file it holds (ADR 0071, ADR 0111): a photo, a
 * clip or a recording in the app's own Previewer from a URL the bot signs, and anything else handed
 * to the platform, which shows or saves it. Nothing is fetched into this app as bytes first, and no
 * object URL of this device's making is drawn from.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { LibraryTree } from "@/components/library"
import type { HermesConfig, LibraryFolder } from "@/lib/hermes"

import {
  click,
  findText,
  labelled,
  mediaHost,
  mediaReads,
  mount,
  spyOpen,
  text,
  until,
} from "./component-kit.tsx"

const config: HermesConfig = { baseUrl: "http://bot.test", apiKey: "key" }

const folders: LibraryFolder[] = [
  {
    name: "library-tab",
    files: [
      {
        name: "chart.png",
        path: "/home/h/.hermes/library/library-tab/chart.png",
        folder: "library-tab",
        worktree: "a-session",
        size: 2048,
        at: 3,
      },
      {
        name: "cleanup-report.md",
        path: "/home/h/.hermes/library/library-tab/cleanup-report.md",
        folder: "library-tab",
        worktree: "a-session",
        size: 900,
        at: 2,
      },
      // A phone's photo, which the route hands over as a binary: the platform's to show, never a
      // Previewer cell that can't fill.
      {
        name: "photo.heic",
        path: "/home/h/.hermes/library/library-tab/photo.heic",
        folder: "library-tab",
        worktree: "a-session",
        size: 4096,
        at: 1,
      },
    ],
  },
]

/** The tree as a project's Library tab draws it: the tree brings the Previewer its rows tap into. */
const screen = () => (
  <LibraryTree config={config} folders={folders} order={{ key: "date", dir: "desc" }} />
)

/** A file's row in the tree, by the name it wears. */
const row = (name: string) => findText("button", name)

test("a library file opens through the app's previewer, from a URL the bot signs", async () => {
  const asked = mediaHost()
  const browser = spyOpen()
  try {
    await mount(screen(), async () => {
      await click(row("library-tab"))
      await until(async () => row("chart.png") !== null, "the folder's files")

      await click(row("chart.png"))
      await until(
        async () => document.querySelector("img[alt='chart.png']") !== null,
        "the photo in the Previewer",
      )
      const photo = document.querySelector("img[alt='chart.png']")!
      assert.equal(
        photo.getAttribute("src")?.includes("token="),
        true,
        "drawn from the URL the host signed, not from bytes this device fetched",
      )
      assert.equal(browser.opened.length, 0, "a photo stays in the app")

      // A document is not a kind the Previewer draws, so the platform takes it — from the same
      // signed URL, which is what names the file as it serves it.
      await click(labelled("button", "Close"))
      await click(row("cleanup-report.md"))
      await until(async () => browser.opened.length === 1, "the document handed to the platform")
      assert.equal(
        browser.opened[0].includes("cleanup-report.md"),
        true,
        "the file's own URL, asked of the host",
      )

      // A photo the browser can't draw is the platform's too: the Previewer draws a photo from a type
      // it can, never a cell that can never fill.
      await click(row("photo.heic"))
      await until(async () => browser.opened.length === 2, "the HEIC handed to the platform")
      assert.equal(
        document.querySelector("img[alt='photo.heic']"),
        null,
        "no Previewer on a photo the browser can't draw",
      )

      assert.deepEqual(
        mediaReads(asked).map((path) => path.split("/").pop()),
        ["chart.png", "cleanup-report.md", "photo.heic"],
        "each tap signs a URL for that file, and nothing else",
      )
      // A tap is one mint and nothing more.
      const plugin = new Set(
        asked
          .map((one) => one.path)
          .filter((path) => path.includes("/plugins/gots/"))
          .map((path) => path.slice(path.indexOf("/plugins/gots/"))),
      )
      assert.deepEqual(
        [...plugin].sort(),
        ["/plugins/gots/info", "/plugins/gots/media/url"],
        "the host is asked what it offers, and to sign a URL — never for the file itself",
      )
      assert.equal(text().includes("MEDIA:"), false, "and nothing of a tag reaches the screen")
    })
  } finally {
    browser.restore()
  }
})
