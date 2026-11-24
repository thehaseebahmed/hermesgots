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

import { CharmUpdateScreen, type CharmUpdateApi } from "@/components/charm-update"
import { resetCharmUpdateWalk } from "@/lib/charm-update-walk"
import { CharmNetwork, type CharmNetworkApi } from "@/components/settings/charm"
import { useCharmReport, type PairedCharm } from "@/lib/charm"
import {
  CHARM_SLOT_BYTES,
  CharmLinkState,
  CharmUpdateReason,
  CharmUpdateState,
} from "@/lib/charm-protocol"
import { db } from "@/lib/db"
import {
  click,
  findAll,
  find,
  findText,
  FIRMWARE_FETCH_TOKEN,
  mount,
  seedSettings,
  serveFirmware,
  settle,
  text,
  until,
} from "./component-kit.tsx"

test.beforeEach(async () => {
  // The walk outlives a screen, so each test's screens start where a fresh load would.
  resetCharmUpdateWalk()
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

/**
 * The screen's own asks of the charm, as the phone's radio would answer them. The build the charm
 * runs is modelled as the charm itself keeps it: 0.1.0 until a walk's own reboot lands it on
 * 0.2.0 — the flip is the reboot a SUCCEEDED walk produces, an upload the charm took or the
 * fetch watch's own Ready, never a failed one. A charm that refused never reboots, so a retry's
 * own re-read still finds the build it started on.
 */
function radio(overrides: Partial<ComponentProps<typeof CharmUpdateScreen>["api"]> = {}) {
  let rebooted = false
  const { upload, updateStatus, ...rest } = overrides
  return {
    version: async () => (rebooted ? "0.2.0" : "0.1.0"),
    // A report with both links down, so no door is open: the walk the tests around here pin is the
    // transfer's, and the fetch walks name the report of their own.
    network: async () => ({
      wifi: { state: CharmLinkState.Off, reason: 0, ip: "", ssid: "" },
      tailnet: { state: CharmLinkState.Off, ip: "" },
    }),
    updateStatus: async () => {
      const answer = await (updateStatus
        ? updateStatus()
        : { state: CharmUpdateState.Idle, percent: 0, reason: 0 })
      if (answer.state === CharmUpdateState.Ready) rebooted = true
      return answer
    },
    // The Update op the fetch walk hands the charm: unused unless a test stands one up.
    update: async () => {},
    upload: async (
      image: Uint8Array,
      _sha256Hex: string,
      onProgress?: (progress: { sent: number; total: number; percent?: number }) => void,
    ) => {
      const done = upload
        ? await upload(image, _sha256Hex, onProgress)
        : (() => {
            const landed = { sent: image.length, total: image.length, percent: 100 }
            onProgress?.(landed)
            return landed
          })()
      rebooted = true
      return done
    },
    ...rest,
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
 * A paired charm holding a voice hand-over: the address the last sync wrote it, on the scheme the
 * reader had picked — the two facts the door is picked from.
 */
const charmedOver = (talk: string, voice: "http" | "https"): PairedCharm => ({
  deviceId: "dev-1",
  name: "Charm",
  talk,
  voice,
})

/** The charm's report when it is online on the Wi-Fi it joined, its tunnel down. */
const ONLINE_WIFI = {
  wifi: { state: CharmLinkState.Online, reason: 0, ip: "192.168.1.20", ssid: "Home" },
  tailnet: { state: CharmLinkState.Off, ip: "" },
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
    { stream },
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

test("a charm online on Wi-Fi fetches the image itself, its own percent on the Downloading bar", async () => {
  const handed: { url: string; sha256Hex: string }[] = []
  let asks = 0
  const api = radio({
    network: async () => ONLINE_WIFI,
    // The charm's own walk: 40%, then 71%, then the slot ready and the reboot a moment away.
    updateStatus: async () => {
      asks += 1
      if (asks === 1) return { state: CharmUpdateState.Downloading, percent: 40, reason: 0 }
      if (asks === 2) return { state: CharmUpdateState.Downloading, percent: 71, reason: 0 }
      return { state: CharmUpdateState.Ready, percent: 100, reason: 0 }
    },
    update: async (url: string, sha256Hex: string) => {
      handed.push({ url, sha256Hex })
    },
    upload: async () => {
      throw new Error("the BLE transfer ran")
    },
  })
  const host = serveFirmware("update-fetch", IMAGE_PUBLISHED, IMAGE, { fetchToken: true })
  const charm = charmedOver("https://update-fetch.test/api/plugins/gots", "https")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await until(async () => bars().includes(40), "the charm's own first percent on the bar")
      assert.ok(
        text().includes("The charm is fetching it itself over Wi-Fi"),
        "the door it picked, in the reader's words",
      )
      await until(async () => bars().includes(71), "the charm's percent moving on its own")
      await until(async () => text().includes("The charm runs 0.2.0"), "the end of the walk")

      assert.equal(handed.length, 1, "one Update op went")
      assert.equal(
        handed[0].url,
        `https://update-fetch.test/api/plugins/gots/charm/firmware/image/fetch?token=${FIRMWARE_FETCH_TOKEN}`,
        "the host the voice hand-over kept, the image route's tokened variant, the token",
      )
      assert.equal(handed[0].sha256Hex, IMAGE_PUBLISHED.sha256, "the published SHA-256, as the record's hex")
      assert.equal(host.mints(), 1, "the token was minted, and only once")
      assert.equal(host.imageReads(), 0, "no image came to the phone: the charm fetches it itself")
      assert.ok(!text().includes("Transferring"), "the link never carried the image")
    },
  )
})

test("a charm online on its tailnet fetches over the http door it was handed", async () => {
  // A charm whose own build takes the http door — 0.2.1-beta is the first that does — updating
  // to the build after it: exactly the charm the http door was written for.
  let booted = false
  const handed: { url: string }[] = []
  const api = radio({
    version: async () => (booted ? "0.2.2-beta" : "0.2.1-beta"),
    network: async () => ({
      wifi: { state: CharmLinkState.Off, reason: 0, ip: "", ssid: "" },
      tailnet: { state: CharmLinkState.Online, ip: "100.64.0.9" },
    }),
    updateStatus: async () => {
      booted = true
      return { state: CharmUpdateState.Ready, percent: 100, reason: 0 }
    },
    update: async (url: string) => {
      handed.push({ url })
    },
    upload: async () => {
      throw new Error("the BLE transfer ran")
    },
  })
  const host = serveFirmware(
    "update-tailnet",
    { ...IMAGE_PUBLISHED, version: "0.2.2-beta" },
    IMAGE,
    { fetchToken: true },
  )
  const charm = charmedOver("http://100.64.0.9:8642/api/plugins/gots", "http")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await until(async () => text().includes("The charm runs 0.2.2-beta"), "the end of the walk")
      assert.equal(handed.length, 1, "one Update op went")
      assert.equal(
        handed[0].url,
        `http://100.64.0.9:8642/api/plugins/gots/charm/firmware/image/fetch?token=${FIRMWARE_FETCH_TOKEN}`,
        "plain http, over the charm's tailnet",
      )
      assert.ok(
        text().includes("The charm is fetching it itself over your tailnet"),
        "the door it picked says the tailnet",
      )
    },
  )
})

test("a door that is shut runs the transfer this phone drives, and mints nothing", async () => {
  const handed: unknown[] = []
  const uploads: Uint8Array[] = []
  const api = radio({
    update: async () => {
      handed.push(1)
    },
    upload: async (image: Uint8Array) => {
      uploads.push(image)
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  const host = serveFirmware("update-shut", IMAGE_PUBLISHED, IMAGE)
  const charm = charmedOver("https://update-shut.test/api/plugins/gots", "https")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await until(async () => text().includes("The charm runs 0.2.0"), "the end of the walk")
      assert.deepEqual(handed, [], "no Update op went: no door is open")
      assert.equal(host.mints(), 0, "no token was minted for a door that is shut")
      assert.equal(uploads.length, 1, "the image went over the link this phone drives")
      assert.equal(host.imageReads(), 1, "and it came to the phone first")
      assert.ok(text().includes("Downloading"), "the phone's own download is the bar")
    },
  )
})

test("a host that cannot mint the door's token is no door: the transfer runs instead", async () => {
  // A host one release behind this app: it serves the record and the image but has no fetch
  // route, so the mint 404s exactly when the walk has already picked the door. The mint's
  // failure means no door, not a dead end — the transfer this phone always drives runs, with
  // its own steps drawn.
  const handed: unknown[] = []
  const uploads: Uint8Array[] = []
  const api = radio({
    network: async () => ONLINE_WIFI,
    update: async () => {
      handed.push(1)
      throw new Error("the fetch door was walked")
    },
    upload: async (image: Uint8Array) => {
      uploads.push(image)
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  // fetchToken left off: the host predates the mint route, as a host one release behind does.
  const host = serveFirmware("update-old-host", IMAGE_PUBLISHED, IMAGE)
  const charm = charmedOver("https://update-old-host.test/api/plugins/gots", "https")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await until(async () => text().includes("The charm runs 0.2.0"), "the transfer's end", 10_000)
      assert.deepEqual(handed, [], "no Update op went")
      assert.equal(uploads.length, 1, "the image went over the link this phone drives")
      assert.equal(host.imageReads(), 1, "and it came to the phone first")
      assert.ok(text().includes("Transferring"), "the transfer's own steps drawn, not a dead end")
      assert.ok(!text().includes("Try again"), "no failure to offer again")
    },
  )
})

test("a kept address whose fetch URL cannot fit opens no door, and the transfer runs", async () => {
  // 93 bytes: inside the voice row's own 180-byte rule, but the fetch URL adds the image route
  // and the host's 64-hex token on top of it — no room, so the charm could never dial the door
  // the rule would otherwise pick.
  const handed: unknown[] = []
  const uploads: Uint8Array[] = []
  const api = radio({
    network: async () => ONLINE_WIFI,
    update: async () => {
      handed.push(1)
    },
    upload: async (image: Uint8Array) => {
      uploads.push(image)
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  const host = serveFirmware("update-long-address", IMAGE_PUBLISHED, IMAGE, { fetchToken: true })
  const charm = charmedOver(`https://${"h".repeat(60)}.example/api/plugins/gots`, "https")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await until(async () => text().includes("The charm runs 0.2.0"), "the transfer's end", 10_000)
      assert.deepEqual(handed, [], "no Update op went: the URL could never fit")
      assert.equal(host.mints(), 0, "nothing was minted for a door that cannot open")
      assert.equal(uploads.length, 1, "the image went over the link instead")
    },
  )
})

test("a kept address with an upper-case scheme is handed to the charm lower-cased", async () => {
  // The voice row keeps the case the reader typed and the charm's own talk door folds it, but
  // its update door reads the scheme case-exactly — so the URL the walk builds carries the
  // scheme lower-cased, the one spelling both doors take.
  const handed: { url: string }[] = []
  const api = radio({
    network: async () => ONLINE_WIFI,
    updateStatus: async () => ({ state: CharmUpdateState.Ready, percent: 100, reason: 0 }),
    update: async (url: string) => {
      handed.push({ url })
    },
    upload: async () => {
      throw new Error("the BLE transfer ran")
    },
  })
  const host = serveFirmware("update-case-door", IMAGE_PUBLISHED, IMAGE, { fetchToken: true })
  const charm = charmedOver("HTTPS://update-case-door.test/api/plugins/gots", "https")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await until(async () => text().includes("The charm runs 0.2.0"), "the walk's end", 10_000)
      assert.equal(handed.length, 1, "one Update op went")
      assert.equal(
        handed[0].url,
        `https://update-case-door.test/api/plugins/gots/charm/firmware/image/fetch?token=${FIRMWARE_FETCH_TOKEN}`,
        "the scheme lower-cased, everything else as kept",
      )
    },
  )
})

test("a build too old for the http door is walked through the transfer instead", async () => {
  // The http update door is new on the charm side — first in 0.2.1-beta — while a build from
  // before it can hold an http voice address over its tailnet, a state this app's own Voice
  // switch writes. Handing that build the http URL is a BadMessage on the wire; the door rule
  // reads the build the charm answered and answers the transfer, the one door it always takes.
  const handed: unknown[] = []
  const uploads: Uint8Array[] = []
  const api = radio({
    network: async () => ({
      wifi: { state: CharmLinkState.Off, reason: 0, ip: "", ssid: "" },
      tailnet: { state: CharmLinkState.Online, ip: "100.64.0.9" },
    }),
    update: async () => {
      handed.push(1)
    },
    upload: async (image: Uint8Array) => {
      uploads.push(image)
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  const host = serveFirmware("update-old-http", IMAGE_PUBLISHED, IMAGE, { fetchToken: true })
  const charm = charmedOver("http://100.64.0.9:8642/api/plugins/gots", "http")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await until(async () => text().includes("The charm runs 0.2.0"), "the transfer's end", 10_000)
      assert.deepEqual(handed, [], "no Update op went to a build that would refuse it")
      assert.equal(host.mints(), 0, "no token minted for a door the build cannot take")
      assert.equal(uploads.length, 1, "the transfer is the one door an older build always takes")
    },
  )
})

test("the fetch hand reads the record again, so a tag that moved is walked against what the host serves now", async () => {
  // The screen opened on the stale record; a merge published the fresh one before the charm
  // fetched. The charm fetches the bytes the host serves NOW, so the hash it is handed is the
  // one that names those bytes — the hand reads the record again every time it runs, which is
  // what a failure's Try again re-runs.
  const handed: { sha256Hex: string }[] = []
  const api = radio({
    network: async () => ONLINE_WIFI,
    // The charm's own gate: the bytes it fetched match the hash it was handed, or they do not.
    updateStatus: async () =>
      handed.at(-1)?.sha256Hex === IMAGE_SHA
        ? { state: CharmUpdateState.Ready, percent: 100, reason: 0 }
        : { state: CharmUpdateState.Failed, percent: 0, reason: CharmUpdateReason.BadHash },
    update: async (_url: string, sha256Hex: string) => {
      handed.push({ sha256Hex })
    },
    upload: async () => {
      throw new Error("the BLE transfer ran")
    },
  })
  const host = serveFirmware(
    "update-tag-moved",
    (reads) => (reads === 1 ? { ...PUBLISHED, version: "0.1.9" } : IMAGE_PUBLISHED),
    IMAGE,
    { fetchToken: true },
  )
  const charm = charmedOver("https://update-tag-moved.test/api/plugins/gots", "https")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await until(async () => text().includes("The charm runs 0.2.0"), "the walk against the fresh record", 10_000)
      assert.equal(handed.length, 1, "one hand, already the right one")
      assert.equal(handed[0].sha256Hex, IMAGE_SHA, "the hash the host's own bytes answer to now")
      assert.ok(host.reads() >= 2, "the record was read again before the charm was handed anything")
    },
  )
})

test("a poll that meets the charm rebooting is the reboot's own shape, and the walk ends Done", async () => {
  // The charm holds its Ready for 1500 ms before it reboots (src/update_board.cpp in the
  // firmware repo) and the watch polls every 2000: on unlucky phases no poll sees Ready, the
  // next ask meets the link gone, and the charm is already coming back on the new build. A
  // thrown poll is the reboot's own shape — the walk falls into the reboot window the transfer
  // uses, and the read-back decides, not the failure block.
  let asks = 0
  let booted = false
  const api = radio({
    version: async () => (booted ? "0.2.1-beta" : "0.2.0-beta"),
    network: async () => ONLINE_WIFI,
    update: async () => {},
    updateStatus: async () => {
      asks += 1
      if (asks <= 2)
        return { state: CharmUpdateState.Downloading, percent: asks === 1 ? 40 : 71, reason: 0 }
      // Ready came and went between polls; the link is gone and the new build is up.
      booted = true
      throw new Error("The charm went out of reach")
    },
    upload: async () => {
      throw new Error("the BLE transfer ran")
    },
  })
  const host = serveFirmware(
    "update-ready-window",
    { ...IMAGE_PUBLISHED, version: "0.2.1-beta" },
    IMAGE,
    { fetchToken: true },
  )
  const charm = charmedOver("https://update-ready-window.test/api/plugins/gots", "https")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await until(async () => text().includes("The charm runs 0.2.1-beta"), "the read-back of the new build", 10_000)
      assert.ok(!text().includes("went out of reach"), "the reboot is not drawn as a failure")
      assert.ok(!text().includes("Try again"), "and there is nothing to try again")
    },
  )
})

test("the answer that says Ready still draws the percent it carried", async () => {
  // The one answer that carries percent 100 is the slot written and the reboot a moment away:
  // drawn before the watch returns, so a completed walk's bar is at the whole image rather
  // than frozen at the last percent the walk happened to see.
  const api = radio({
    network: async () => ONLINE_WIFI,
    updateStatus: async () => ({ state: CharmUpdateState.Ready, percent: 100, reason: 0 }),
    update: async () => {},
    upload: async () => {
      throw new Error("the BLE transfer ran")
    },
  })
  const host = serveFirmware("update-ready-percent", IMAGE_PUBLISHED, IMAGE, { fetchToken: true })
  const charm = charmedOver("https://update-ready-percent.test/api/plugins/gots", "https")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await until(async () => text().includes("The charm runs 0.2.0"), "the walk's end", 10_000)
      assert.ok(bars().includes(100), "the Downloading bar at the whole image, as the Ready answer said")
    },
  )
})

test("stepping back mid-walk and returning joins the walk already running", async () => {
  // The send is driven by its own promise, not by the screen, so leaving changes nothing — and
  // the reader who steps back mid-walk and returns finds the same walk on screen rather than
  // a second, unrequested one started beside it.
  let releaseUpload: (() => void) | undefined
  let uploads = 0
  const api = radio({
    upload: async (image: Uint8Array) => {
      uploads += 1
      await new Promise<void>((done) => (releaseUpload = done))
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  const host = serveFirmware("update-remount", IMAGE_PUBLISHED, IMAGE)
  // The reader opens the screen; the published walk starts on its own.
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      await until(async () => text().includes("Transferring"), "the walk started", 10_000)
    },
  ) // <- the screen unmounts; the send's promise stays alive
  // The reader comes back while the first upload is still held.
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      assert.ok(text().includes("Transferring"), "the returned screen shows the walk in flight")
      // Long enough for the returned screen's own reads to land: it had every chance to
      // start a walk of its own, and must not have.
      await act(async () => {
        await new Promise((done) => setTimeout(done, 300))
      })
      assert.equal(uploads, 1, "no second send was started by the return")
      releaseUpload?.()
      await until(async () => text().includes("The charm runs 0.2.0"), "the one walk's end", 10_000)
      assert.equal(uploads, 1, "one update asked for, one update run")
    },
  )
})

test("re-flashing the build the charm already runs ends Done on the build it answered", async () => {
  // The classic fix-a-sick-charm move: the file IS the build the charm runs. The transfer
  // succeeds and the charm comes back on that same build — an unchanged version is the walk
  // landing, not failing, since a reader's file names no newer build.
  const api = radio({
    version: async () => "0.2.0",
    upload: async (image: Uint8Array) => ({ sent: image.length, total: image.length, percent: 100 }),
  })
  const host = serveFirmware("update-reflash", IMAGE_PUBLISHED, IMAGE)
  await mount(
    at("/settings/charm-firmware?file=1", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      await until(async () => Boolean(find("#charm-update-choose")), "the picker", 10_000)
      await pick("charm-0.2.0.bin", 8)
      await until(async () => text().includes("Restarting"), "the transfer taken", 10_000)
      // The reboot window is the screen's own four asks, 3 s apart.
      await act(async () => {
        await new Promise((done) => setTimeout(done, 12_500))
      })
      await settle()
      const page = text()
      assert.ok(page.includes("The charm runs 0.2.0"), "the charm came back on the build it was sent")
      assert.ok(
        !page.includes("didn't come back on the new build"),
        "a same-build re-flash is not drawn as the failure it wasn't",
      )
    },
  )
})

test("a retry whose second walk succeeds ends Done on the new build", async () => {
  // The rig's own shape: the first upload fails, the reader taps Try again, and the second
  // upload lands. A failed attempt never reboots the charm, so the retry's own re-read still
  // finds the build it started on — and its end is the change to the new one, not the failure
  // an unchanged version would draw.
  let uploads = 0
  const api = radio({
    upload: async (image: Uint8Array) => {
      uploads += 1
      if (uploads === 1) throw new Error("The update failed: it was cancelled")
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  const host = serveFirmware("update-retry-done", IMAGE_PUBLISHED, IMAGE)
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      await until(async () => text().includes("The update failed: it was cancelled"), "the first walk's failure", 10_000)
      await click(find("#charm-update-retry"))
      await until(async () => text().includes("The charm runs 0.2.0"), "the retry's end", 10_000)
      assert.equal(uploads, 2, "the retry re-ran the send")
      assert.ok(
        !text().includes("didn't come back on the new build"),
        "the charm did come back, on the new build",
      )
    },
  )
})

test("a fetch the charm fails is drawn in its own reason words, with Try again and the cable", async () => {
  let handed = 0
  const api = radio({
    network: async () => ONLINE_WIFI,
    updateStatus: async () => ({
      state: CharmUpdateState.Failed,
      percent: 0,
      reason: CharmUpdateReason.Cancelled,
    }),
    update: async () => {
      handed += 1
    },
    upload: async () => {
      throw new Error("the BLE transfer ran")
    },
  })
  const host = serveFirmware("update-fetch-failed", IMAGE_PUBLISHED, IMAGE, { fetchToken: true })
  const charm = charmedOver("https://update-fetch-failed.test/api/plugins/gots", "https")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await until(
        async () => text().includes("The update failed: it was cancelled"),
        "the charm's reason in words",
      )
      assert.ok(text().includes("flash it by cable"), "the sure path is said beside it")
      await click(find("#charm-update-retry"))
      await until(async () => handed === 2, "the retry walks the fetch again")
      assert.equal(host.mints(), 2, "a fresh token for the fresh walk")
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
  api: CharmNetworkApi & CharmUpdateApi
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
  const links = {
    wifi: { state: CharmLinkState.Online, reason: 0, ip: "192.168.1.20", ssid: "Home" },
    tailnet: { state: CharmLinkState.Off, ip: "" },
  }
  const api: CharmNetworkApi & CharmUpdateApi = {
    status: async () => links,
    network: async () => links,
    saveWifi: async () => 0,
    forget: async () => 0,
    saveTailnet: async () => 0,
    // A download already running when the row opens starts the poll.
    updateStatus: async () => {
      polls += 1
      return { state: CharmUpdateState.Downloading, percent: 10, reason: 0 }
    },
    version: async () => (landed ? "0.2.0" : "0.1.0"),
    update: async () => {},
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
  const api: CharmNetworkApi & CharmUpdateApi = {
    status: async () => ({
      wifi: { state: CharmLinkState.Online, reason: 0, ip: "192.168.1.20", ssid: "Home" },
      tailnet: { state: CharmLinkState.Off, ip: "" },
    }),
    network: async () => ({
      wifi: { state: CharmLinkState.Online, reason: 0, ip: "192.168.1.20", ssid: "Home" },
      tailnet: { state: CharmLinkState.Off, ip: "" },
    }),
    saveWifi: async () => 0,
    forget: async () => 0,
    saveTailnet: async () => 0,
    updateStatus: async () => ({ state: CharmUpdateState.Idle, percent: 0, reason: 0 }),
    version: async () => "0.1.0",
    update: async () => {},
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
