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
import { resetCharmUpdateWalk } from "@/lib/charm-update-walk"
import { type PairedCharm } from "@/lib/charm"
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
  FIRMWARE_FETCH_PATH,
  FIRMWARE_FETCH_TOKEN,
  mount,
  seedSettings,
  serveFirmware,
  settle,
  start,
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
    // A charge well over the gate's 20%, off the charger: the offer's doors are open unless a case
    // says otherwise.
    battery: async () => ({ percent: 80, charging: false }),
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

test("the screen opens on the offer, asks the battery once, and sends nothing until Install", async () => {
  let batteries = 0
  let uploads = 0
  const api = radio({
    battery: async () => {
      batteries += 1
      return { percent: 64, charging: false }
    },
    // A link the charm reports up, so the instruction row's words are its own and not the link's.
    network: async () => ONLINE_WIFI,
    upload: async (image: Uint8Array) => {
      uploads += 1
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  const host = serveFirmware("update-offer", IMAGE_PUBLISHED, IMAGE)
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      await until(async () => Boolean(find("#charm-update-install")), "the offer")
      await until(async () => batteries === 1, "the one battery ask")
      await settle()

      assert.equal(batteries, 1, "the battery was asked once, when the offer drew")
      assert.ok(text().includes("64%"), "the charm's charge, in the offer")
      assert.ok(text().includes("Wi-Fi up"), "the charm's link, as it reported it")
      assert.ok(text().includes("Keep the phone near the charm"), "and the instruction the link needs")
      assert.equal(
        find("#charm-update-install")?.textContent,
        "Install 0.2.0",
        "the published build is named on the door",
      )
      assert.deepEqual(
        [uploads, host.imageReads(), host.mints()],
        [0, 0, 0],
        "nothing left the phone before a tap",
      )
      assert.ok(!text().includes("Downloading"), "no walk drew its steps before the tap")

      await click(find("#charm-update-install"))
      await until(async () => text().includes("The charm runs 0.2.0"), "the walk the tap began")
      assert.equal(uploads, 1, "the tap is what sent the image")
      assert.equal(batteries, 1, "the walk asked the battery no second time")
    },
  )
})

/**
 * The gate's own cases, from SwitchBot's rule: under 20% and off the charger shuts both doors, and
 * nothing else does — charging passes at the same 12%, a charm that answered -1 never read its own
 * charge, and an ask that did not land is no fact at all.
 */
const GATE_CASES = [
  { said: "12% not charging", battery: { percent: 12, charging: false }, shut: true },
  { said: "12% charging", battery: { percent: 12, charging: true }, shut: false },
  { said: "−1, the charge unknown", battery: { percent: -1, charging: false }, shut: false },
  { said: "an ask the charm refused", battery: null, shut: false },
] as const

/** Every case's doors, drawn once at `entry`: the published offer's, or the file door alone. */
async function gateDoors(entry: string) {
  for (const [index, gateCase] of GATE_CASES.entries()) {
    let asked = 0
    const api = radio({
      battery: async () => {
        asked += 1
        if (!gateCase.battery) throw new Error("the charm didn't answer")
        return gateCase.battery
      },
    })
    const host = serveFirmware(`update-gate-${index}`, IMAGE_PUBLISHED, IMAGE)
    await mount(
      at(entry, <CharmUpdateScreen api={api} profile={host.profile} />),
      async () => {
        await until(async () => Boolean(find("#charm-update-choose")), "the offer")
        await until(async () => asked === 1, "the one battery ask")
        await settle()
        const install = find("#charm-update-install") as HTMLButtonElement | null
        const choose = find("#charm-update-choose") as HTMLButtonElement
        assert.equal(choose.disabled, gateCase.shut, `${gateCase.said}: the file door`)
        if (entry.includes("file=1")) {
          assert.equal(install, null, `${gateCase.said}: the file door draws no Install`)
        } else {
          assert.ok(install, `${gateCase.said}: Install is drawn`)
          assert.equal(install.disabled, gateCase.shut, `${gateCase.said}: Install`)
        }
        assert.equal(
          text().includes("Charge the charm above 20% before updating."),
          gateCase.shut,
          `${gateCase.said}: the line under the group says to charge it`,
        )
        assert.equal(asked, 1, `${gateCase.said}: the battery was asked once`)
      },
    )
  }
}

test("the 20% gate shuts the published offer's doors, and only under 20% off the charger", async () => {
  await gateDoors("/settings/charm-firmware")
})

test("the 20% gate shuts the file door the same way, and the file door offers no Install", async () => {
  await gateDoors("/settings/charm-firmware?file=1")
})

test("a returning visit joins the running walk and draws no offer", async () => {
  let releaseUpload: (() => void) | undefined
  let uploads = 0
  let batteries = 0
  const api = radio({
    battery: async () => {
      batteries += 1
      return { percent: 80, charging: false }
    },
    upload: async (image: Uint8Array) => {
      uploads += 1
      await new Promise<void>((done) => (releaseUpload = done))
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  const host = serveFirmware("update-offer-join", IMAGE_PUBLISHED, IMAGE)
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      await start()
      await until(async () => text().includes("Transferring"), "the walk started", 10_000)
    },
  )
  // The reader comes back while the upload is still held: the walk is the screen, not an offer.
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} />),
    async () => {
      assert.ok(text().includes("Transferring"), "the walk in flight is drawn")
      assert.equal(find("#charm-update-install"), null, "and no offer is drawn over it")
      await act(async () => {
        await new Promise((done) => setTimeout(done, 300))
      })
      assert.equal(batteries, 1, "the return asks the battery nothing: there is no offer to draw")
      assert.equal(uploads, 1, "no second send")
      releaseUpload?.()
      await until(async () => text().includes("The charm runs 0.2.0"), "the one walk's end", 10_000)
    },
  )
})

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
      await start()
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
      await start()
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
        `https://update-fetch.test/api/plugins/gots${FIRMWARE_FETCH_PATH}?token=${FIRMWARE_FETCH_TOKEN}`,
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
      await start()
      await until(async () => text().includes("The charm runs 0.2.2-beta"), "the end of the walk")
      assert.equal(handed.length, 1, "one Update op went")
      assert.equal(
        handed[0].url,
        `http://100.64.0.9:8642/api/plugins/gots${FIRMWARE_FETCH_PATH}?token=${FIRMWARE_FETCH_TOKEN}`,
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
      await start()
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
      await start()
      await until(async () => text().includes("The charm runs 0.2.0"), "the transfer's end", 10_000)
      assert.deepEqual(handed, [], "no Update op went")
      assert.equal(uploads.length, 1, "the image went over the link this phone drives")
      assert.equal(host.imageReads(), 1, "and it came to the phone first")
      assert.ok(text().includes("Transferring"), "the transfer's own steps drawn, not a dead end")
      assert.ok(!text().includes("Try again"), "no failure to offer again")
    },
  )
})

test("a kept address whose fetch URL cannot fit walks the transfer after the mint", async () => {
  // 93 bytes: inside the voice row's own 180-byte rule, but the fetch URL adds the host's own
  // route and its 64-hex token on top of it — no room, so the charm could never dial the door.
  // The route arrives only with the token, so the length is unknown until after the mint.
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
      await start()
      await until(async () => text().includes("The charm runs 0.2.0"), "the transfer's end", 10_000)
      assert.deepEqual(handed, [], "no Update op went: the URL could never fit")
      assert.equal(host.mints(), 1, "the mint answered first; only then could the URL be measured")
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
      await start()
      await until(async () => text().includes("The charm runs 0.2.0"), "the walk's end", 10_000)
      assert.equal(handed.length, 1, "one Update op went")
      assert.equal(
        handed[0].url,
        `https://update-case-door.test/api/plugins/gots${FIRMWARE_FETCH_PATH}?token=${FIRMWARE_FETCH_TOKEN}`,
        "the scheme lower-cased, everything else as kept",
      )
    },
  )
})

test("the URL handed to the charm walks the path the host answered, not one the app knows", async () => {
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
  const host = serveFirmware("update-renamed-route", IMAGE_PUBLISHED, IMAGE, {
    fetchToken: true,
    fetchPath: "/charm/firmware/v2/image/fetch",
  })
  const charm = charmedOver("https://update-renamed-route.test/api/plugins/gots", "https")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await start()
      await until(async () => text().includes("The charm runs 0.2.0"), "the walk's end", 10_000)
      assert.equal(handed.length, 1, "one Update op went")
      assert.equal(
        handed[0].url,
        `https://update-renamed-route.test/api/plugins/gots/charm/firmware/v2/image/fetch?token=${FIRMWARE_FETCH_TOKEN}`,
        "the route the host named, hung off the address the voice hand-over kept",
      )
    },
  )
})

test("a host that answers no route walks the transfer, as an older host's door is shut", async () => {
  // A host from before the answer carried a route: no path to append is no door, and this app must
  // not guess one.
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
  const host = serveFirmware("update-unrouted-host", IMAGE_PUBLISHED, IMAGE, {
    fetchToken: true,
    fetchPath: false,
  })
  const charm = charmedOver("https://update-unrouted-host.test/api/plugins/gots", "https")
  await mount(
    at("/settings/charm-firmware", <CharmUpdateScreen api={api} profile={host.profile} charm={charm} />),
    async () => {
      await start()
      await until(async () => text().includes("The charm runs 0.2.0"), "the transfer's end", 10_000)
      assert.deepEqual(handed, [], "no Update op went: the host named no route to walk")
      assert.equal(uploads.length, 1, "the image went over the link instead")
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
      await start()
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
      await start()
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
      await start()
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
      await start()
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
      await start()
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
      await start()
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
      await start()
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
      await start()
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
      await start()
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
      await start()
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
      await start()
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
      await start()
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
