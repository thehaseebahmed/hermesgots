/**
 * Settings → Charm's update screen: the steps a firmware update walks, drawn over a stand-in
 * for the radio and a faked host, because a browser has neither. The row's send-flow guarantees
 * moved here with the flow itself — the published image is checked against the version the screen
 * read, a moved tag is re-read, a file over the slot never goes, a failed upload is drawn in the
 * charm's own words, and a charm that does not come back is said — beside the walk's own: the
 * steps in order, each bar moving, and the failure's words with what to do.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { type ComponentProps, type ReactElement, act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { CharmUpdateScreen } from "@/components/charm-update"
import { CharmNetwork, type CharmNetworkApi } from "@/components/settings/charm"
import { useCharmReport } from "@/lib/charm"
import { CHARM_SLOT_BYTES, CharmLinkState, CharmUpdateState } from "@/lib/charm-protocol"
import { db } from "@/lib/db"
import type { CharmFirmware } from "@/lib/hermes"
import {
  click,
  connection,
  findAll,
  find,
  findText,
  json,
  mount,
  seedSettings,
  settle,
  text,
  until,
} from "./component-kit.tsx"

test.beforeEach(async () => {
  await db.delete()
  await db.open()
  await seedSettings()
})

/** The screen as its route mounts it: the URL carries the mode, as the row's buttons write it. */
const at = (entry: string, screen: ReactElement) => (
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/settings/charm-firmware" element={screen} />
    </Routes>
  </MemoryRouter>
)

/** The screen's own asks of the charm, as the phone's radio would answer them. */
function radio(overrides: Partial<ComponentProps<typeof CharmUpdateScreen>["api"]> = {}) {
  let reads = 0
  return {
    version: async () => (++reads > 1 ? "0.2.0" : "0.1.0"),
    upload: async (
      image: Uint8Array,
      _sha256Hex: string,
      onProgress?: (progress: { sent: number; total: number; percent?: number }) => void,
    ) => {
      const done = { sent: image.length, total: image.length, percent: 100 }
      onProgress?.(done)
      return done
    },
    ...overrides,
  }
}

/** Every bar on screen, in the DOM's order: the value each was last drawn at. */
const bars = () =>
  findAll('[role="progressbar"]').map((bar) => Number(bar.getAttribute("aria-valuenow")))

/** The first button on screen with these words. */
const button = (label: string) => findText("button", label)

/** Hands the screen a file the way the WebView hands it one: the input's change, with the file on it. */
async function pick(name: string, size: number) {
  const input = find("#charm-update-file") as HTMLInputElement | null
  assert.ok(input, "the file picker is on screen")
  const file = new File([new Uint8Array(size)], name, { type: "application/octet-stream" })
  Object.defineProperty(input, "files", { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle()
}

/** A stream's second half, held until the test lets it land. */
function gate() {
  let release: (() => void) | undefined
  const hold = new Promise<void>((done) => (release = done))
  return { hold, release: () => release?.() }
}

const PUBLISHED = { version: "0.2.0", size: 4, sha256: "cd".repeat(32) }

/** An image the screen can publish, and the hash of its bytes as this phone computes it. */
const IMAGE = new Uint8Array([9, 9, 9, 9])
const IMAGE_SHA = createHash("sha256").update(IMAGE).digest("hex")
const IMAGE_PUBLISHED = { version: "0.2.0", size: IMAGE.length, sha256: IMAGE_SHA }

/**
 * A bot's host, as the app's own reader asks it for a charm's firmware: the plugin's feature list,
 * the tag's answer, and the image's bytes. `published` is that answer — a package, or the sentence
 * the host refuses with — and a function is asked once per read, so a tag that moved is one test's
 * own. The image answers with its length named and, where a gate is given, in halves the test
 * releases, so the Downloading bar can be watched moving rather than assumed.
 */
function serveFirmware(
  name: string,
  published: CharmFirmware | string | ((reads: number) => CharmFirmware | string),
  image = new Uint8Array(),
  stream?: { hold: Promise<void>; release: () => void },
) {
  const profile = connection(name)
  let reads = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", version: "1.0.0", features: ["charm_firmware"] })
    if (url.pathname.endsWith("/charm/firmware/image")) {
      if (!stream)
        return new Response(image, { headers: { "Content-Length": String(image.length) } })
      const held = stream
      const half = Math.ceil(image.length / 2)
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(image.subarray(0, half))
          await held.hold
          controller.enqueue(image.subarray(half))
          controller.close()
        },
      })
      return new Response(body, { headers: { "Content-Length": String(image.length) } })
    }
    if (url.pathname.endsWith("/charm/firmware")) {
      reads += 1
      const answer = typeof published === "function" ? published(reads) : published
      if (typeof answer === "string") return json({ error: { message: answer } }, 403)
      return json(answer)
    }
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
  return { profile, reads: () => reads }
}

test("the steps appear in the order they walk, each bar moving, and the image that went is the host's", async () => {
  const sent: { bytes: Uint8Array; sha256: string }[] = []
  let releaseUpload: (() => void) | undefined
  const api = radio({
    upload: async (image: Uint8Array, sha256: string, onProgress) => {
      sent.push({ bytes: image, sha256 })
      onProgress?.({ sent: 4, total: 8, percent: 50 })
      await new Promise<void>((done) => (releaseUpload = done))
      onProgress?.({ sent: 8, total: 8, percent: 100 })
      return { sent: 8, total: 8, percent: 100 }
    },
  })
  const stream = gate()
  const image = new Uint8Array(8).fill(9)
  const sha256 = createHash("sha256").update(image).digest("hex")
  const host = serveFirmware(
    "update-walk",
    { version: "0.2.0", size: image.length, sha256 },
    image,
    stream,
  )
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      // The first half of the image has landed: the download's bar is half way, and nothing is
      // transferring yet.
      await until(async () => text().includes("50% of 8 B"), "the download's first half")
      assert.deepEqual(bars(), [50], "the download's bar, at the bytes that have landed")
      stream.release()
      await until(async () => text().includes("Transferring"), "the transfer's start")
      assert.deepEqual(bars(), [100, 50], "the download full, the transfer half way")
      releaseUpload?.()
      await until(async () => text().includes("Restarting"), "the reboot window")
      await until(async () => text().includes("The charm runs 0.2.0"), "the version read back")

      const page = text()
      assert.ok(
        page.indexOf("Downloading") < page.indexOf("Transferring") &&
          page.indexOf("Transferring") < page.indexOf("Restarting") &&
          page.indexOf("Restarting") < page.indexOf("The charm runs 0.2.0"),
        "the steps in the order they walked",
      )
      assert.equal(sent.length, 1, "one image went")
      assert.deepEqual([...sent[0].bytes], [...image], "the bytes the host served")
      assert.equal(sent[0].sha256, sha256, "the hash the charm is told is the one over those bytes")
    },
  )
})

test("a picked file skips the download and walks the rest, with the hash the phone computes", async () => {
  const sent: { sha256: string }[] = []
  const api = radio({
    upload: async (_image: Uint8Array, sha256: string) => {
      sent.push({ sha256 })
      return { sent: 8, total: 8, percent: 100 }
    },
  })
  await mount(at("/settings/charm-firmware?file=1", <CharmUpdateScreen api={api} />), async () => {
    await until(async () => Boolean(find("#charm-update-choose")), "the screen's picker")
    await pick("charm.bin", 8)
    await until(async () => text().includes("The charm runs 0.2.0"), "the end of the walk")
    assert.ok(!text().includes("Downloading"), "a file the phone already holds is not downloaded")
    assert.equal(sent.length, 1, "one image went")
    // The hash of eight zero bytes, computed here rather than trusted from the picker.
    assert.equal(
      sent[0].sha256,
      "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      "the SHA-256 of the file itself",
    )
  })
})

test("an image that is not the one the version names is refused before it goes", async () => {
  const uploads: Uint8Array[] = []
  const api = radio({
    upload: async (image: Uint8Array) => {
      uploads.push(image)
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  // A truncated body, an error page, or a tag that moved: not the bytes the version described.
  const host = serveFirmware("update-mismatch", IMAGE_PUBLISHED, new Uint8Array([1, 2, 3, 4]))
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      await until(async () => text().includes("isn't the one the version names"), "the screen says why")
      assert.deepEqual(uploads, [], "no UpdateBegin reached the charm")
      assert.ok(text().includes("Try again"), "the way to try again")
      assert.ok(text().includes("cable"), "and the sure path beside it")
    },
  )
})

test("a version that moved between the read and the image is read again, and its image goes", async () => {
  const sent: { sha256: string }[] = []
  const api = radio({
    upload: async (_image: Uint8Array, sha256: string) => {
      sent.push({ sha256 })
      return { sent: IMAGE.length, total: IMAGE.length, percent: 100 }
    },
  })
  // The screen read the old version on opening; a merge published a new one before its fetch.
  const host = serveFirmware(
    "update-moved",
    (reads) => (reads === 1 ? PUBLISHED : IMAGE_PUBLISHED),
    IMAGE,
  )
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      await until(async () => sent.length === 1, "the image that arrived")
      assert.equal(sent[0].sha256, IMAGE_SHA, "with the hash computed over it")
      assert.ok(host.reads() >= 2, "the tag was read again before it went")
    },
  )
})

test("a file over the slot the host publishes is refused before a byte goes; under it goes", async () => {
  // The package names its own partition, which is smaller than this phone's constant: what the
  // host says wins, since the slot is the board's and only its build knows it.
  const asked: number[] = []
  const api = radio({
    upload: async (image: Uint8Array) => {
      asked.push(image.length)
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  const host = serveFirmware("update-slot", { ...PUBLISHED, version: "0.1.0", slot: 8 })
  await mount(
    at("/settings/charm-firmware?file=1", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      await until(async () => Boolean(find("#charm-update-choose")), "the screen's picker")
      await pick("over-slot.bin", 9)
      assert.ok(text().includes("larger than a slot"), "a byte over the published slot is refused")
      assert.deepEqual(asked, [], "and nothing went over the link")
      await pick("fits.bin", 8)
      assert.deepEqual(asked, [8], "the file the slot holds is sent")
    },
  )
})

test("the phone's own slot bound holds where the host names none", async () => {
  const asked: number[] = []
  const api = radio({
    upload: async (image: Uint8Array) => {
      asked.push(image.length)
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  // A package from before the slot annotation names none: the phone's own constant is the bound.
  const host = serveFirmware("update-no-slot", PUBLISHED)
  await mount(
    at("/settings/charm-firmware?file=1", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      await until(async () => Boolean(find("#charm-update-choose")), "the screen's picker")
      await pick("too-big.bin", CHARM_SLOT_BYTES + 1)
      assert.ok(text().includes("larger than a slot"), "the row refuses it in words")
      assert.deepEqual(asked, [], "and no control write reached the charm")
    },
  )
})

test("the same file can be picked again after a failed upload", async () => {
  let uploads = 0
  const api = radio({
    version: async () => "0.1.0",
    upload: async () => {
      uploads += 1
      throw new Error("The update failed: it was cancelled")
    },
  })
  await mount(at("/settings/charm-firmware?file=1", <CharmUpdateScreen api={api} />), async () => {
    await until(async () => Boolean(find("#charm-update-choose")), "the screen's picker")
    await pick("charm.bin", 8)
    assert.equal(uploads, 1)
    const input = find("#charm-update-file") as HTMLInputElement | null
    assert.equal(input?.value, "", "the field is cleared, so the same file fires change again")
    await until(async () => text().includes("The update failed: it was cancelled"), "the failure's words")
    await pick("charm.bin", 8)
    assert.equal(uploads, 2, "the second try at a failed upload is exactly what a cleared field is for")
  })
})

test("a failed upload is drawn with the reason the charm gave, the cable sentence and a retry", async () => {
  let uploads = 0
  const api = radio({
    version: async () => "0.1.0",
    upload: async () => {
      uploads += 1
      throw new Error("The update failed: it was cancelled")
    },
  })
  const host = serveFirmware("update-failed", IMAGE_PUBLISHED, IMAGE)
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      await until(
        async () => text().includes("The update failed: it was cancelled"),
        "the reason the charm gave",
      )
      assert.ok(text().includes("flash it by cable"), "the sure path is said beside it")
      await click(find("#charm-update-retry"))
      await until(async () => uploads === 2, "the retry re-ran the send")
    },
  )
})

test("an image the charm refuses for its build is drawn in the charm's own reason", async () => {
  // 7 on the wire is the charm's `WrongScheme`: the image was built for the other kind of board, so
  // the screen draws that reason rather than "the charm didn't say why".
  const api = radio({
    version: async () => "0.1.0",
    upload: async () => {
      throw new Error("The update failed: that image was built for a different kind of charm")
    },
  })
  const host = serveFirmware("update-wrong-kind", IMAGE_PUBLISHED, IMAGE)
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      await until(
        async () => text().includes("The update failed: that image was built for a different kind of charm"),
        "the charm's reason in words",
      )
      assert.ok(!text().includes("didn't say why"), "the reason is named, not left unnamed")
    },
  )
})

test("a charm that does not come back on the new build is said, and what is published is read again", async () => {
  const api = radio({
    // The charm answers the build it started on, however often it is asked.
    version: async () => "0.1.0",
    upload: async () => ({ sent: IMAGE.length, total: IMAGE.length, percent: 100 }),
  })
  const host = serveFirmware("update-not-back", IMAGE_PUBLISHED, IMAGE)
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      // The screen's four asks, 3 s apart: the charm never answers on the new build.
      await act(async () => {
        await new Promise((done) => setTimeout(done, 12_500))
      })
      await settle()
      assert.ok(
        text().includes("didn't come back on the new build"),
        "the success sentence is revised rather than left standing",
      )
      assert.ok(text().includes("cable"), "and what to do instead is said beside it")
      assert.ok(host.reads() >= 2, "and what is published is read again")
    },
  )
})

test("a screen that opens with nothing published says so, and takes a file", async () => {
  const said = "GitHub refused this server's token for the charm firmware."
  const host = serveFirmware("update-none", said)
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={radio()} profile={host.profile} />),
    async () => {
      await until(async () => text().includes(said), "the host's own sentence")
      assert.ok(Boolean(find("#charm-update-choose")), "the picker is the way through")
      assert.ok(!find("#charm-update-retry"), "nothing ran, so nothing is offered to re-run")
    },
  )
})

/**
 * The Network section as the page draws it — the row the Update button leaves — with the update
 * screen at its own address, as the settings route holds both.
 */
function Network({
  api,
  ...rest
}: { api: CharmNetworkApi } & Omit<
  ComponentProps<typeof CharmNetwork>,
  "api" | "read" | "refresh"
>) {
  const { read, refresh } = useCharmReport(api)
  return <CharmNetwork api={api} read={read} refresh={refresh} {...rest} />
}

/** The row and the screen it opens, on the addresses the settings route gives them. */
function Routed({
  api,
  profile,
}: {
  api: CharmNetworkApi
  profile: ComponentProps<typeof CharmNetwork>["profile"]
}) {
  return (
    <MemoryRouter initialEntries={["/settings/charm"]}>
      <Routes>
        <Route path="/settings/charm" element={<Network api={api} profile={profile} />} />
        <Route
          path="/settings/charm-firmware"
          element={<CharmUpdateScreen api={api} profile={profile} />}
        />
      </Routes>
    </MemoryRouter>
  )
}

test("tapping Update leaves the section, and the status poll stops while the upload holds the link", async () => {
  let polls = 0
  let landed = false
  let releaseUpload: (() => void) | undefined
  const api: CharmNetworkApi = {
    status: async () => ({
      wifi: { state: CharmLinkState.Online, reason: 0, ip: "192.168.1.20", ssid: "Home" },
      tailnet: { state: CharmLinkState.Off, ip: "" },
    }),
    saveWifi: async () => 0,
    forget: async () => 0,
    saveTailnet: async () => 0,
    // A download already running when the row opens starts the poll.
    updateStatus: async () => {
      polls += 1
      return { state: CharmUpdateState.Downloading, percent: 10, reason: 0 }
    },
    version: async () => (landed ? "0.2.0" : "0.1.0"),
    upload: async () => {
      await new Promise<void>((done) => (releaseUpload = done))
      landed = true
      return { sent: IMAGE.length, total: IMAGE.length, percent: 100 }
    },
  }
  const host = serveFirmware("update-poll", IMAGE_PUBLISHED, IMAGE)
  await mount(<Routed api={api} profile={host.profile} />, async () => {
    await until(async () => Boolean(button("Update to 0.2.0")), "the offer")
    const before = polls
    assert.ok(before >= 1, "the row's own snapshot asked")
    await click(button("Update to 0.2.0"))
    await until(async () => text().includes("Transferring"), "the upload holding the link")
    // Longer than the poll's interval: the row the poll lived in is gone, and the screen asks
    // nothing on a timer of its own, so nothing opens a link beside the upload.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 2_300))
    })
    assert.equal(polls, before, "the poll did not ask while the upload held the link")
    releaseUpload?.()
    await settle()
  })
})

test("the row's picker opens the same screen ready for a file", async () => {
  const api: CharmNetworkApi = {
    status: async () => ({
      wifi: { state: CharmLinkState.Online, reason: 0, ip: "192.168.1.20", ssid: "Home" },
      tailnet: { state: CharmLinkState.Off, ip: "" },
    }),
    saveWifi: async () => 0,
    forget: async () => 0,
    saveTailnet: async () => 0,
    updateStatus: async () => ({ state: CharmUpdateState.Idle, percent: 0, reason: 0 }),
    version: async () => "0.1.0",
    upload: async (image: Uint8Array) => ({
      sent: image.length,
      total: image.length,
      percent: 100,
    }),
  }
  const host = serveFirmware("update-pick-route", PUBLISHED)
  await mount(<Routed api={api} profile={host.profile} />, async () => {
    await until(async () => Boolean(button("Choose a file…")), "the row's picker")
    await click(button("Choose a file…"))
    await until(async () => Boolean(find("#charm-update-choose")), "the screen's own picker")
    assert.ok(!find("#charm-update-start"), "the row the reader left")
  })
})
