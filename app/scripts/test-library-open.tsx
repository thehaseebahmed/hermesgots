/**
 * A library's files open the way the app opens any file it holds (ADR 0071, ADR 0111, ADR 0134): a
 * photo, a clip, a recording or a page in the app's own Previewer from a URL the bot signs, and
 * anything else handed to the platform, which shows or saves it. Nothing is fetched into this app as
 * bytes first, and no object URL of this device's making is drawn from.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { act } from "react"

import { LibraryTree, SessionLibrary } from "@/components/library"
import type { HermesConfig, LibraryFolder } from "@/lib/hermes"

import {
  click,
  findText,
  json,
  labelled,
  mediaHost,
  mediaReads,
  missing,
  mount,
  spyOpen,
  text,
  until,
} from "./component-kit.tsx"

const config: HermesConfig = { baseUrl: "http://bot.test", apiKey: "key" }

/**
 * A bot of a case's own: the URL this page holds for a path is remembered for the page's life and
 * keyed by the bot's address, so two cases that open the same path would share what the first minted.
 */
const botFor = (name: string): HermesConfig => ({ ...config, baseUrl: `http://${name}.test` })

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

/**
 * A folder of several files that the Previewer draws, written here in an order the tree does not
 * draw them in: the list the Previewer opens on has to come from the tree's own sort, and a note and
 * a phone's HEIC sit among them so stepping skips what the platform takes.
 */
const several: LibraryFolder[] = [
  {
    name: "library-tab",
    files: [
      {
        name: "notes.md",
        path: "/home/h/.hermes/library/library-tab/notes.md",
        folder: "library-tab",
        worktree: "a-session",
        size: 300,
        at: 5,
      },
      {
        name: "chart.png",
        path: "/home/h/.hermes/library/library-tab/chart.png",
        folder: "library-tab",
        worktree: "a-session",
        size: 2048,
        at: 3,
      },
      {
        name: "sketch.png",
        path: "/home/h/.hermes/library/library-tab/sketch.png",
        folder: "library-tab",
        worktree: "a-session",
        size: 1024,
        at: 4,
      },
      {
        name: "clip.mp4",
        path: "/home/h/.hermes/library/library-tab/clip.mp4",
        folder: "library-tab",
        worktree: "a-session",
        size: 9000,
        at: 2,
      },
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

/** A folder whose second file the host serves as a type no browser draws, though its name says photo. */
const undrawable: LibraryFolder[] = [
  {
    name: "library-tab",
    files: [
      {
        name: "chart.png",
        path: "/home/h/.hermes/library/library-tab/chart.png",
        folder: "library-tab",
        worktree: "a-session",
        size: 2048,
        at: 2,
      },
      {
        name: "snap.png",
        path: "/home/h/.hermes/library/library-tab/snap.png",
        folder: "library-tab",
        worktree: "a-session",
        size: 4096,
        at: 1,
      },
    ],
  },
]

/** A page an agent left in the library: the Previewer draws it, the platform never gets it. */
const page: LibraryFolder[] = [
  {
    name: "library-tab",
    files: [
      {
        name: "report.html",
        path: "/home/h/.hermes/library/library-tab/report.html",
        folder: "library-tab",
        worktree: "a-session",
        size: 512,
        at: 1,
      },
    ],
  },
]

/** The tree as a project's Library tab draws it: the tree brings the Previewer its rows tap into. */
const screen = () => (
  <LibraryTree config={config} folders={folders} order={{ key: "date", dir: "desc" }} />
)

/** The same tree over a folder of several files the Previewer draws, on a bot of its own. */
const severalScreen = (name: string) => (
  <LibraryTree config={botFor(name)} folders={several} order={{ key: "date", dir: "desc" }} />
)

/** A file's row in the tree, by the name it wears. */
const row = (name: string) => findText("button", name)

/** The Previewer's own pane, and its words with the gaps collapsed. */
const panel = () => document.querySelector('[role="dialog"]')
const panelText = () => (panel()?.textContent ?? "").replace(/\s+/g, " ")

/** Whether the Previewer is drawing this file, and saying where it sits among the folder's files. */
const viewing = (name: string, place: string) =>
  panelText().includes(name) && panelText().includes(place)

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
      assert.equal(
        missing('[role="dialog"] [aria-label="Next"]'),
        true,
        "one drawable file in the folder is one file to step through: no chevrons",
      )
      assert.equal(
        panelText().includes("1 of 1"),
        false,
        "and no count either, since a count of one says nothing",
      )

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
      assert.ok(missing("img[alt='photo.heic']"), "no Previewer on a photo the browser can't draw")

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

test("Library opens an .html in the Previewer, not the platform", async () => {
  const asked = mediaHost()
  const browser = spyOpen()
  try {
    await mount(
      <LibraryTree config={config} folders={page} order={{ key: "date", dir: "desc" }} />,
      async () => {
        await click(row("library-tab"))
        await until(async () => row("report.html") !== null, "the folder's files")
        await click(row("report.html"))
        await until(
          async () => document.querySelector('[role="dialog"] iframe') !== null,
          "the page in the Previewer",
        )
        const frame = document.querySelector<HTMLIFrameElement>('[role="dialog"] iframe')!
        assert.equal(frame.getAttribute("sandbox"), "allow-scripts", "drawn in the sandbox")
        assert.equal(browser.opened.length, 0, "a page stays in the app")
        assert.deepEqual(
          mediaReads(asked).map((path) => path.split("/").pop()),
          ["report.html"],
          "the page's URL is signed, as for any file the Library opens",
        )
      },
    )
  } finally {
    browser.restore()
  }
})

test("a folder's second file opens at its own place among the folder's files", async () => {
  const asked = mediaHost()
  try {
    await mount(severalScreen("several"), async () => {
      await click(row("library-tab"))
      await until(async () => row("chart.png") !== null, "the folder's files")

      // The second of the three files the Previewer draws: the note above it and the HEIC below it are
      // the platform's, so they are not stepped over — they are not in the list at all.
      await click(row("chart.png"))
      await until(
        async () => document.querySelector("img[alt='chart.png']") !== null,
        "the photo in the Previewer",
      )
      assert.equal(
        text().includes("2 of 3"),
        true,
        "the Previewer says where the reader is among the folder's files",
      )
      assert.deepEqual(
        mediaReads(asked).map((path) => path.split("/").pop()),
        ["chart.png"],
        "the tap signs the file tapped, and nothing else",
      )
    })
  } finally {
    mediaHost()
  }
})

test("a session's own tree opens its folder the same way", async () => {
  const asked = mediaHost()
  const inner = globalThis.fetch
  // `SessionLibrary` reads the session's own route for its tree, so the fake answers that and leaves
  // every other read to the host this file already faked.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost")
    if (/\/sessions\/[^/]+\/library$/.test(url.pathname))
      return json({ worktree: "a-session", folders: several })
    return inner(input as RequestInfo, init)
  }) as typeof fetch
  try {
    await mount(<SessionLibrary config={botFor("session")} sessionId="s-1" active />, async () => {
      await click(row("library-tab"))
      await until(async () => row("sketch.png") !== null, "the session's files")
      await click(row("sketch.png"))
      await until(
        async () => document.querySelector("img[alt='sketch.png']") !== null,
        "the photo in the Previewer",
      )
      assert.equal(
        text().includes("1 of 3"),
        true,
        "a session's tree steps through its folder too, newest first as it draws it",
      )
      assert.deepEqual(
        mediaReads(asked).map((path) => path.split("/").pop()),
        ["sketch.png"],
        "and signs only the file it was asked for",
      )
    })
  } finally {
    globalThis.fetch = inner
  }
})

test("stepping signs the file now shown, and a step back onto the tapped file mints nothing", async () => {
  const asked = mediaHost()
  try {
    await mount(severalScreen("stepping"), async () => {
      await click(row("library-tab"))
      await until(async () => row("chart.png") !== null, "the folder's files")
      await click(row("chart.png"))
      await until(async () => viewing("chart.png", "2 of 3"), "the tapped file, second of three")

      // The tree draws them newest first: sketch.png, then chart.png, then clip.mp4.
      await click(labelled("button", "Next"))
      await until(async () => viewing("clip.mp4", "3 of 3"), "the next file, signed as it arrives")
      assert.equal(
        document.querySelector('[role="dialog"] video')?.getAttribute("src")?.includes("token="),
        true,
        "the clip is drawn from the URL minted as it arrived, not a placeholder",
      )
      await click(labelled("button", "Next"))
      await until(
        async () => viewing("sketch.png", "1 of 3"),
        "the last step, wrapping to the first",
      )
      assert.equal(
        document.querySelector("img[alt='sketch.png']")?.getAttribute("src")?.includes("token="),
        true,
        "and the photo the wrap landed on, the same way",
      )
      assert.deepEqual(
        mediaReads(asked).map((path) => path.split("/").pop()),
        ["chart.png", "clip.mp4", "sketch.png"],
        "one mint a step, each for the file now shown, in the order the tree draws them",
      )

      // Back onto a file this page already signed: nothing is minted again.
      await click(labelled("button", "Previous"))
      await until(async () => viewing("clip.mp4", "3 of 3"), "the file stepped back onto")
      assert.deepEqual(
        mediaReads(asked).map((path) => path.split("/").pop()),
        ["chart.png", "clip.mp4", "sketch.png"],
        "a URL this page still holds is drawn from, not asked for again",
      )
    })
  } finally {
    mediaHost()
  }
})

test("a step onto a file the host refuses says so, and Try again signs it", async () => {
  // Two hosts, one log: the first refuses the clip, the second answers for it once the reader asks
  // again, which is what the retry is for.
  const asked = mediaHost({ fail: ["clip.mp4"] })
  const refusing = globalThis.fetch
  mediaHost({ asked })
  const answering = globalThis.fetch
  let refusingNow = true
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    refusingNow
      ? refusing(input as RequestInfo, init)
      : answering(input as RequestInfo, init)) as typeof fetch
  try {
    await mount(severalScreen("refused"), async () => {
      await click(row("library-tab"))
      await until(async () => row("chart.png") !== null, "the folder's files")
      await click(row("chart.png"))
      await until(async () => viewing("chart.png", "2 of 3"), "the tapped file")

      await click(labelled("button", "Next"))
      await until(
        async () => panelText().includes("The bot has no clip.mp4."),
        "the host's own sentence for the file it has no copy of",
      )
      assert.equal(
        missing('[role="dialog"] video'),
        true,
        "no player for a file that never arrived",
      )

      refusingNow = false
      await click(findText("button", "Try again"))
      await until(
        async () =>
          document
            .querySelector('[role="dialog"] video')
            ?.getAttribute("src")
            ?.includes("token=") === true,
        "the clip drawn from the URL the host signed when it was asked again",
      )
      assert.equal(
        panelText().includes("The bot has no clip.mp4."),
        false,
        "the sentence goes with the failure it belonged to",
      )
    })
  } finally {
    mediaHost()
  }
})

test("a file whose signed URL has run out is signed again", async () => {
  // Every URL this host mints is already spent: a step back onto a file the page holds one for asks
  // for another rather than drawing from the dead one.
  const asked = mediaHost({ life: 0 })
  try {
    await mount(severalScreen("spent"), async () => {
      await click(row("library-tab"))
      await until(async () => row("chart.png") !== null, "the folder's files")
      await click(row("chart.png"))
      await until(async () => viewing("chart.png", "2 of 3"), "the tapped file")

      await click(labelled("button", "Next"))
      await until(async () => viewing("clip.mp4", "3 of 3"), "the next file")
      await click(labelled("button", "Previous"))
      await until(async () => viewing("chart.png", "2 of 3"), "the file stepped back onto")

      assert.deepEqual(
        mediaReads(asked).map((path) => path.split("/").pop()),
        ["chart.png", "clip.mp4", "chart.png"],
        "the file stepped back onto is signed again, because the URL this page held had run out",
      )
    })
  } finally {
    mediaHost()
  }
})

test("a file the host serves undrawably offers the platform, not a pane that never fills", async () => {
  const asked = mediaHost({
    type: (path) => (path.endsWith("snap.png") ? "image/heic" : undefined),
  })
  const browser = spyOpen()
  try {
    await mount(
      <LibraryTree
        config={botFor("undrawable")}
        folders={undrawable}
        order={{ key: "date", dir: "desc" }}
      />,
      async () => {
        await click(row("library-tab"))
        await until(async () => row("chart.png") !== null, "the folder's files")
        await click(row("chart.png"))
        await until(async () => viewing("chart.png", "1 of 2"), "the tapped file")

        await click(labelled("button", "Next"))
        await until(async () => viewing("snap.png", "2 of 2"), "the file the host serves as a HEIC")
        // A DOM without layout loads no picture, so the failure a browser would report is what reaches
        // the card — which is the shape the reader meets when the host's type is one nothing draws.
        await act(async () => {
          document.querySelector("img[alt='snap.png']")?.dispatchEvent(new Event("error"))
        })
        await until(async () => findText("button", "Open elsewhere") !== null, "the card's way out")
        await click(findText("button", "Open elsewhere"))
        await until(async () => browser.opened.length === 1, "the file handed to the platform")
        assert.equal(
          browser.opened[0].includes("snap.png"),
          true,
          "the file the reader could not be shown, opened where it can be",
        )
        assert.deepEqual(
          mediaReads(asked).map((path) => path.split("/").pop()),
          ["chart.png", "snap.png"],
          "the step still cost one mint, and the way out cost none",
        )
      },
    )
  } finally {
    browser.restore()
  }
})

test("a file that loads badly is signed again when the reader tries again", async () => {
  const asked = mediaHost()
  try {
    await mount(severalScreen("reloads"), async () => {
      await click(row("library-tab"))
      await until(async () => row("chart.png") !== null, "the folder's files")
      await click(row("chart.png"))
      await until(async () => viewing("chart.png", "2 of 3"), "the tapped file")
      assert.deepEqual(
        mediaReads(asked).map((path) => path.split("/").pop()),
        ["chart.png"],
        "the tap minted one URL",
      )

      // A URL that loads nothing is the same failure a phone meets on a bad link: the picture is
      // handed a src the browser can't decode, which this tier reaches by dispatching its error.
      await act(async () => {
        document.querySelector("img[alt='chart.png']")?.dispatchEvent(new Event("error"))
      })
      await until(async () => findText("button", "Try again") !== null, "the card's retry")
      await click(findText("button", "Try again"))
      await until(
        async () => mediaReads(asked).length === 2,
        "another URL minted for the same file",
      )
      assert.deepEqual(
        mediaReads(asked).map((path) => path.split("/").pop()),
        ["chart.png", "chart.png"],
        "Try again mints another rather than handing back the URL that failed to load",
      )
    })
  } finally {
    mediaHost()
  }
})
