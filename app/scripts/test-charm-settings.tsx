/**
 * Settings → Charm on the web: there is no radio to reach a Gots Charm with outside the Android
 * app, so the menu offers no row, and the section, reached by its address, says where to pair one.
 * The phone's own Network section is drawn here too, over a stand-in for the radio: what a charm's
 * answer reads as, and that a passphrase is never drawn back.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { type ComponentProps, act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import {
  CharmNetwork,
  CharmVoice,
  type CharmNetworkApi,
  type CharmVoiceApi,
} from "@/components/settings/charm"
import { useCharmReport } from "@/lib/charm"
import {
  CHARM_SLOT_BYTES,
  CharmCode,
  CharmLinkState,
  CharmUpdateState,
  codeWords,
} from "@/lib/charm-protocol"
import { db } from "@/lib/db"
import type { CharmFirmware } from "@/lib/hermes"
import { SettingsPage } from "@/routes/settings"
import { BatteryRow, CharmStatusRow, WakingGroup } from "@/components/settings/charm"
import { report } from "./fixtures/charm-report.ts"
import {
  Path,
  click,
  connection,
  findAll,
  find,
  findText,
  json,
  labelled,
  missing,
  mount,
  seedSettings,
  settle,
  text,
  type,
  until,
} from "./component-kit.tsx"

const at = (entry: string) => (
  <MemoryRouter initialEntries={[entry]}>
    <Path />
    <Routes>
      <Route path="/settings/:section?/:botId?/:tab?/:sub?" element={<SettingsPage />} />
    </Routes>
  </MemoryRouter>
)

test.beforeEach(async () => {
  await db.delete()
  await db.open()
  await seedSettings()
})

test("the web's menu offers no charm row", async () => {
  await mount(at("/settings"), async () => {
    await settle()
    assert.ok(text().includes("Appearance"), "the menu drew")
    assert.ok(!text().includes("Not paired"), "no charm row on the web")
  })
})

test("the charm section on the web says to pair from the phone", async () => {
  await mount(at("/settings/charm"), async () => {
    await settle()
    assert.ok(text().includes("pairs with the Android app"))
    assert.ok(!text().includes("Pair a charm"))
  })
})

test("the web offers no test alert, since only the phone can write one", async () => {
  await mount(at("/settings/charm"), async () => {
    await settle()
    assert.ok(!text().includes("Send a test alert"), "the row is the phone's")
    assert.ok(!text().includes("Buzzes your charm"), "and its line is drawn nowhere beside it")
  })
})

test("Developer ends with a Charm tests group holding one row per moment", async () => {
  await seedSettings({ developer: true })
  await mount(at("/settings/developer"), async () => {
    await settle()
    const page = text()
    assert.ok(page.includes("Charm tests"), "the group is named")
    assert.ok(page.includes("Test Approval Alert"), "an approval can be drawn on demand")
    assert.ok(page.includes("Test Question Alert"), "and so can a question")
    // Each row says what the charm will draw, so the developer knows which card is coming: the
    // approval's pair and the handoff, or the handoff alone.
    assert.ok(
      page.includes("Allow once, Deny and Show on Phone"),
      "the approval's buttons are named",
    )
    assert.ok(page.includes("Show on Phone alone"), "and the question's one")
  })
})

/**
 * The Network section's own link, as the phone would answer it. Each call is one control ask over
 * BLE; this stands in for the charm, since nothing here can drive a real radio. What the host says
 * about the published firmware is not the charm's: that is `serveFirmware` below.
 */
function radio(overrides: Partial<CharmNetworkApi> = {}): CharmNetworkApi {
  return {
    status: async () => ({
      wifi: { state: CharmLinkState.Online, reason: 0, ip: "192.168.1.20", ssid: "Home" },
      tailnet: { state: CharmLinkState.Off, ip: "" },
    }),
    saveWifi: async () => 0,
    forget: async () => 0,
    saveTailnet: async () => 0,
    updateStatus: async () => ({ state: 0, percent: 0, reason: 0 }),
    version: async () => "0.1.0",
    upload: async (image, _sha256Hex, onProgress) => {
      const done = { sent: image.length, total: image.length, percent: 100 }
      onProgress?.(done)
      return done
    },
    ...overrides,
  }
}

/**
 * The Network section as the page draws it: the page's own read is made once, above the section, and
 * handed down — the one ask the status row and the two link lines both read.
 */
function Network({
  api,
  ...rest
}: { api?: CharmNetworkApi } & Omit<
  ComponentProps<typeof CharmNetwork>,
  "api" | "read" | "refresh"
>) {
  const { read, refresh } = useCharmReport(api)
  return <CharmNetwork api={api} read={read} refresh={refresh} {...rest} />
}

/** The form's own submit: a DOM without a browser does not submit on the button's click. */
async function submit(field: Element | null) {
  const form = field?.closest("form")
  assert.ok(form, "the field stands in a form")
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
  await settle()
}

test("the network section says Not set before the charm answers", async () => {
  const api = radio({
    status: async () => {
      throw new Error("No charm paired")
    },
    updateStatus: async () => {
      throw new Error("No charm paired")
    },
  })
  await mount(<Network api={api} />, async () => {
    await settle()
    assert.ok(text().includes("Not set"), "the Wi-Fi line, with nothing to say yet")
    assert.ok(!text().includes("Connected"), "and nothing it could not know")
  })
})

test("a parsed answer says the charm is connected", async () => {
  await mount(<Network api={radio()} />, async () => {
    await settle()
    assert.ok(text().includes("Connected to Home"), "the Wi-Fi line, from the charm's own answer")
  })
})

test("a passphrase is sent once and never drawn as a label", async () => {
  const wrote: string[][] = []
  const api = radio({
    saveWifi: async (ssid: string, pass: string) => {
      wrote.push([ssid, pass])
      return 0
    },
  })
  await mount(<Network api={api} />, async () => {
    await type(find("#charm-wifi-ssid"), "Home")
    await type(find("#charm-wifi-pass"), "correct horse battery")
    assert.ok(!text().includes("correct horse battery"), "the field holds it; no label draws it")
    await submit(find("#charm-wifi-pass"))
    assert.deepEqual(wrote, [["Home", "correct horse battery"]], "the write carried it")
    assert.equal(
      (find("#charm-wifi-pass") as HTMLInputElement | null)?.value,
      "",
      "and the field is empty afterwards",
    )
    assert.ok(!text().includes("correct horse battery"), "nothing draws it, then or later")
  })
})

test("a charm that kept the secret readable says so, in its own words", async () => {
  // 11 on the wire: the charm kept the network and warns that the chip gives it away.
  const api = radio({ saveWifi: async () => 11 })
  await mount(<Network api={api} />, async () => {
    await type(find("#charm-wifi-ssid"), "Home")
    await type(find("#charm-wifi-pass"), "correct horse battery")
    await submit(find("#charm-wifi-pass"))
    assert.ok(
      text().includes("The charm kept it, but anyone holding the charm can read it off the chip"),
      "the row says the secret is readable, not that the charm will forget it",
    )
    assert.ok(!text().includes("will forget this"), "no promise a reboot wipes it")
  })
})

/** The first button on screen with these words: the row's own control. */
const button = (label: string) => findText("button", label)

/** Hands the row a file the way the WebView hands it one: the input's change, with the file on it. */
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

const PUBLISHED = { version: "0.2.0", size: 4, sha256: "cd".repeat(32) }

/** An image the row can publish, and the hash of its bytes as this phone computes it. */
const IMAGE = new Uint8Array([9, 9, 9, 9])
const IMAGE_SHA = createHash("sha256").update(IMAGE).digest("hex")
const IMAGE_PUBLISHED = { version: "0.2.0", size: IMAGE.length, sha256: IMAGE_SHA }

/**
 * A bot's host, as the app's own reader asks it for a charm's firmware: the plugin's feature list,
 * the tag's answer, and the image's bytes. `published` is that answer — a package, or the sentence
 * the host refuses with — and a function is asked once per read, so a tag that moved is one test's
 * own. The connection is named, since what a host answered is remembered per connection.
 */
function serveFirmware(
  name: string,
  published: CharmFirmware | string | ((reads: number) => CharmFirmware | string),
  image = new Uint8Array(),
) {
  const profile = connection(name)
  let reads = 0
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", version: "1.0.0", features: ["charm_firmware"] })
    if (url.pathname.endsWith("/charm/firmware/image")) return new Response(image)
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

test("the firmware row offers the published one when the charm is older", async () => {
  const host = serveFirmware("firmware-offered", PUBLISHED)
  await mount(<Network api={radio()} profile={host.profile} />, async () => {
    await until(async () => text().includes("Charm 0.1.0 · 0.2.0 available"), "the host's answer")
    assert.ok(button("Update to 0.2.0"), "the newer one is offered")
    assert.ok(button("Choose a file…"), "and a file is always taken")
  })
})

test("the firmware row says the charm is up to date when the versions match", async () => {
  const host = serveFirmware("firmware-current", { ...PUBLISHED, version: "0.1.0" })
  await mount(<Network api={radio()} profile={host.profile} />, async () => {
    await until(async () => text().includes("Charm 0.1.0 · up to date"), "the host's answer")
    assert.ok(!button("Update to"), "nothing to offer")
    assert.ok(button("Choose a file…"), "but a file is still taken")
  })
})

test("a charm ahead of the package is said, and never offered a downgrade", async () => {
  const api = radio({ version: async () => "0.3.0" })
  const host = serveFirmware("firmware-behind", PUBLISHED)
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await until(async () => text().includes("Charm 0.3.0 · newer than 0.2.0"), "the two versions")
    assert.ok(!find("#charm-update-start"), "and offers no update")
  })
})

test("a charm too old to say its version is not compared with the package", async () => {
  const api = radio({ version: async () => null })
  const host = serveFirmware("firmware-too-old", PUBLISHED)
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await until(async () => text().includes("can't say which version it runs"), "the row's line")
    assert.ok(text().includes("cable"), "and how the first one gets there")
    assert.ok(!find("#charm-update-start"), "nothing is offered over the air")
    assert.ok(button("Choose a file…"), "the picker still works")
  })
})

test("a host that can't answer says it couldn't check, in its own words", async () => {
  const said = "GitHub refused this server's token for the charm firmware."
  const host = serveFirmware("firmware-refused", said)
  await mount(<Network api={radio()} profile={host.profile} />, async () => {
    await until(async () => text().includes(said), "the host's sentence")
    assert.ok(text().includes("couldn't check for a newer one"), "the row says the check failed")
    assert.ok(button("Choose a file…"), "and the picker is not held hostage to it")
  })
})

test("a picked file larger than a slot is refused before anything is written", async () => {
  const asked: number[] = []
  const api = radio({
    upload: async (image) => {
      asked.push(image.length)
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  const host = serveFirmware("firmware-no-slot", PUBLISHED)
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await settle()
    await pick("too-big.bin", CHARM_SLOT_BYTES + 1)
    assert.ok(text().includes("larger than a slot"), "the row refuses it in words")
    assert.deepEqual(asked, [], "and no control write reached the charm")
  })
})

test("a file over the slot the host publishes is refused, under it goes", async () => {
  // The package names its own partition, which is smaller than this phone's constant: what the
  // host says wins, since the slot is the board's and only its build knows it.
  const asked: number[] = []
  const api = radio({
    upload: async (image) => {
      asked.push(image.length)
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  const host = serveFirmware("firmware-slot", { ...PUBLISHED, version: "0.1.0", slot: 8 })
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await until(async () => text().includes("0.1.0 · up to date"), "the host's answer")
    await pick("over-slot.bin", 9)
    assert.ok(text().includes("larger than a slot"), "a byte over the published slot is refused")
    assert.deepEqual(asked, [], "and nothing went over the link")
    await pick("fits.bin", 8)
    assert.deepEqual(asked, [8], "the file the slot holds is sent")
  })
})

test("a picked file is sent with the hash the phone computes over it", async () => {
  const sent: { bytes: Uint8Array; sha256: string }[] = []
  const api = radio({
    upload: async (image, sha256Hex) => {
      sent.push({ bytes: image, sha256: sha256Hex })
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  const host = serveFirmware("firmware-hashed", PUBLISHED)
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await settle()
    await pick("charm.bin", 8)
    assert.equal(sent.length, 1, "one image went")
    assert.equal(sent[0].bytes.length, 8)
    // The hash of eight zero bytes, computed here rather than trusted from the picker.
    assert.equal(
      sent[0].sha256,
      "af5570f5a1810b7af78caf4bc70a660f0df51e42baf91d4de5b2328de0e83dfc",
      "the SHA-256 of the file itself",
    )
  })
})

test("a failed upload is drawn with the reason the charm gave", async () => {
  const api = radio({
    upload: async () => {
      throw new Error("The update failed: it was cancelled")
    },
  })
  const host = serveFirmware("firmware-failed", PUBLISHED)
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await settle()
    await pick("charm.bin", 8)
    assert.ok(text().includes("The update failed: it was cancelled"))
  })
})

test("an image the charm refuses for its build is drawn in the charm's own reason", async () => {
  // 7 on the wire is the charm's `WrongScheme`: the image was built for the other kind of board, so
  // the row draws that reason rather than "the charm didn't say why".
  const api = radio({
    updateStatus: async () => ({ state: CharmUpdateState.Failed, percent: 0, reason: 7 }),
  })
  await mount(<Network api={api} />, async () => {
    await until(
      async () =>
        text().includes("Update failed: that image was built for a different kind of charm"),
      "the charm's reason in words",
    )
    assert.ok(!text().includes("didn't say why"), "the reason is named, not left unnamed")
  })
})

test("Update sends the published image and reads the version once the charm is back", async () => {
  const sent: { bytes: Uint8Array; sha256: string }[] = []
  let reads = 0
  // The charm answers its old version until the upload lands, then the new one.
  const api = radio({
    version: async () => (++reads > 1 ? "0.2.0" : "0.1.0"),
    upload: async (image, sha256Hex, onProgress) => {
      sent.push({ bytes: image, sha256: sha256Hex })
      const done = { sent: image.length, total: image.length, percent: 100 }
      onProgress?.(done)
      return done
    },
  })
  const host = serveFirmware("firmware-sent", IMAGE_PUBLISHED, IMAGE)
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await until(async () => Boolean(button("Update to 0.2.0")), "the offer")
    await click(button("Update to 0.2.0"))
    await settle()
    assert.equal(sent.length, 1, "the published image went")
    assert.deepEqual([...sent[0].bytes], [...IMAGE], "the bytes the host served")
    assert.equal(
      sent[0].sha256,
      IMAGE_SHA,
      "the hash the charm is told is the one computed over those bytes",
    )
    assert.ok(text().includes("Charm 0.2.0 · up to date"), "and the charm's new version is read")
  })
})

test("an image that is not the one the version names is refused before it goes", async () => {
  const uploads: Uint8Array[] = []
  const api = radio({
    upload: async (image) => {
      uploads.push(image)
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  // A truncated body, an error page, or a tag that moved: not the bytes the version described.
  const host = serveFirmware("firmware-mismatch", IMAGE_PUBLISHED, new Uint8Array([1, 2, 3, 4]))
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await until(async () => Boolean(button("Update to 0.2.0")), "the offer")
    await click(button("Update to 0.2.0"))
    await settle()
    assert.deepEqual(uploads, [], "no UpdateBegin reached the charm")
    assert.ok(text().includes("isn't the one the version names"), "the row says why")
  })
})

test("a version that moved between the reads is read again, and its image goes", async () => {
  const sent: { sha256: string }[] = []
  const api = radio({
    upload: async (_image, sha256Hex) => {
      sent.push({ sha256: sha256Hex })
      return { sent: IMAGE.length, total: IMAGE.length, percent: 100 }
    },
  })
  // The row read the old version on opening; a merge published a new one before the tap.
  const host = serveFirmware(
    "firmware-moved",
    (reads) => (reads === 1 ? PUBLISHED : IMAGE_PUBLISHED),
    IMAGE,
  )
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await until(async () => Boolean(button("Update to 0.2.0")), "the offer")
    await click(button("Update to 0.2.0"))
    await settle()
    assert.equal(sent.length, 1, "the image that arrived is sent")
    assert.equal(sent[0].sha256, IMAGE_SHA, "with the hash computed over it")
  })
})

test("a charm that cannot be reached is not a charm that didn't say", async () => {
  const api = radio({
    version: async () => {
      throw new Error("The charm went out of reach")
    },
  })
  const host = serveFirmware("firmware-unreachable", PUBLISHED)
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await until(
      async () => text().includes("0.2.0 published · couldn't reach the charm"),
      "the link's own sentence",
    )
    assert.ok(!text().includes("didn't say"), "not blamed on the charm's firmware")
    assert.ok(!find("#charm-update-start"), "and nothing is offered on a version nobody read")
  })
})

test("starting an update stops the two-second status poll", async () => {
  let polls = 0
  let landed = false
  let releaseUpload: (() => void) | undefined
  const api = radio({
    version: async () => (landed ? "0.2.0" : "0.1.0"),
    // A download already running when the row opens starts the poll.
    updateStatus: async () => {
      polls += 1
      return { state: CharmUpdateState.Downloading, percent: 10, reason: 0 }
    },
    upload: async () => {
      await new Promise((done) => (releaseUpload = done))
      landed = true
      return { sent: IMAGE.length, total: IMAGE.length, percent: 100 }
    },
  })
  const host = serveFirmware("firmware-poll", IMAGE_PUBLISHED, IMAGE)
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await until(async () => Boolean(button("Update to 0.2.0")), "the offer")
    const before = polls
    assert.ok(before >= 1, "the row's own snapshot asked")
    await click(button("Update to 0.2.0"))
    // Longer than the poll's interval: a still-running poll would open a link and drop the upload.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 2_300))
    })
    assert.equal(polls, before, "the poll did not ask while the upload held the link")
    releaseUpload?.()
    await settle()
  })
})

test("a charm that does not come back on the new build is said, and the offer is read again", async () => {
  const api = radio({
    // The charm answers the build it started on, however often it is asked.
    version: async () => "0.1.0",
    upload: async () => ({ sent: IMAGE.length, total: IMAGE.length, percent: 100 }),
  })
  const host = serveFirmware("firmware-not-back", IMAGE_PUBLISHED, IMAGE)
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await until(async () => Boolean(button("Update to 0.2.0")), "the offer")
    await click(button("Update to 0.2.0"))
    // The row's four asks, 3 s apart: the charm never answers on the new build.
    await act(async () => {
      await new Promise((done) => setTimeout(done, 12_500))
    })
    await settle()
    assert.ok(
      text().includes("didn't come back on the new build"),
      "the success sentence is revised rather than left standing",
    )
    assert.ok(host.reads() >= 2, "and what is published is read again")
  })
})

test("the same file can be picked again after a failed upload", async () => {
  let uploads = 0
  const api = radio({
    upload: async () => {
      uploads += 1
      throw new Error("The update failed: it was cancelled")
    },
  })
  const host = serveFirmware("firmware-again", PUBLISHED)
  await mount(<Network api={api} profile={host.profile} />, async () => {
    await settle()
    const input = find("#charm-update-file") as HTMLInputElement | null
    assert.ok(input, "the file picker is on screen")
    Object.defineProperty(input, "value", {
      value: "charm.bin",
      writable: true,
      configurable: true,
    })
    const file = new File([new Uint8Array(8)], "charm.bin", {
      type: "application/octet-stream",
    })
    Object.defineProperty(input, "files", { value: [file], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await settle()
    assert.equal(input.value, "", "the field is cleared, so the same file fires change again")
    assert.equal(uploads, 1)
  })
})

test("the firmware group says the published image is the everyday build, once", async () => {
  await mount(<Network api={radio()} />, async () => {
    await settle()
    const warnings = (text().match(/everyday build/g) ?? []).length
    assert.equal(warnings, 1, "said once, not beside every control")
    assert.ok(
      text().includes("A sealed charm refuses it"),
      "and what a sealed charm does with it is said too",
    )
  })
})

/** The first button whose words contain `label`: the sheet's rows are buttons. */
const rowButton = (label: string) => findText("button", label)

test("the waking group offers the switch, the three windows and what off leaves", async () => {
  const changes: CharmWake[] = []
  await mount(
    <WakingGroup
      wake={{ doubleTap: true, quietSeconds: 15 }}
      busy={false}
      onChange={(next) => changes.push(next)}
    />,
    async () => {
      await settle()
      assert.ok(text().includes("Double tap to wake"))
      assert.ok(text().includes("Two taps on the glass wake it"))
      assert.ok(text().includes("15 seconds"))

      // The row opens the picker, and the window the reader picks is the whole change.
      await click(rowButton("15 seconds"))
      await click(rowButton("60 seconds"))
      assert.deepEqual(changes, [{ doubleTap: true, quietSeconds: 60 }])
    },
  )

  // With the switch off the row says what is left rather than repeating the switch.
  await mount(
    <WakingGroup wake={{ doubleTap: false, quietSeconds: 30 }} busy={false} onChange={() => {}} />,
    async () => {
      await settle()
      assert.ok(text().includes("Only the buttons wake it"))
      assert.ok(text().includes("30 seconds"))
    },
  )
})

/** The marks a status row draws: one for each link that is down, wearing that link's own words. */
const marks = () => findAll('[role="img"]')

test("the page draws a mark for each link that is down and the level", async () => {
  await mount(
    <CharmStatusRow
      charm={{ name: "Desk charm" }}
      status={{ state: "read", value: report(CharmLinkState.Off, CharmLinkState.Failed) }}
      battery={{ percent: 82, charging: false, at: Date.now() }}
    />,
    async () => {
      await settle()
      assert.ok(text().includes("Desk charm"), "the charm is named")
      assert.ok(labelled('[role="img"]', "Wi-Fi is down"), "a mark for the Wi-Fi link")
      assert.ok(labelled('[role="img"]', "Tailnet is down"), "a mark for the tailnet")
      assert.ok(
        missing('[role="img"][aria-label="Bluetooth is down"]'),
        "and none for the link the report itself arrived on",
      )
      assert.match(text(), /82%/, "the level is drawn beside them")
    },
  )
})

test("a link the page has not read draws nothing, and the level is drawn all the same", async () => {
  // Nothing has answered yet: not one of the three is known to be down, and a mark for one would be
  // a guess. The glass draws nothing for a fact it has not read either.
  await mount(
    <CharmStatusRow charm={{ name: "Desk charm" }} status={{ state: "reading" }} />,
    async () => {
      await settle()
      assert.equal(marks().length, 0, "no mark for a fact nobody has read")
      assert.ok(text().includes("Not read yet"), "and the level is still drawn, saying what it is")
    },
  )
})

test("a read that failed marks Bluetooth", async () => {
  // The page's own ask did not open the link: that is the Bluetooth mark, and it is the one fact
  // here the phone learns by asking rather than by being told.
  await mount(
    <CharmStatusRow charm={{ name: "Desk charm" }} status={{ state: "failed" }} />,
    async () => {
      await settle()
      assert.equal(marks().length, 1, "one link is known to be down")
      assert.ok(labelled('[role="img"]', "Bluetooth is down"))
    },
  )
})

test("a read that failed keeps the two links the charm last named", async () => {
  // It answered once and left: the report it sent still stands, so all three are drawn — the phone's
  // link and the charm's own. Nothing is forgotten because a later ask went unanswered.
  await mount(
    <CharmStatusRow
      charm={{ name: "Desk charm" }}
      status={{ state: "failed", last: report(CharmLinkState.Off, CharmLinkState.Off) }}
    />,
    async () => {
      await settle()
      assert.equal(marks().length, 3, "every link that is down, the two it named included")
      assert.ok(labelled('[role="img"]', "Bluetooth is down"))
      assert.ok(labelled('[role="img"]', "Wi-Fi is down"))
      assert.ok(labelled('[role="img"]', "Tailnet is down"))
    },
  )
})

test("a link that is up draws no mark", async () => {
  await mount(
    <CharmStatusRow
      charm={{ name: "Desk charm" }}
      status={{ state: "read", value: report(CharmLinkState.Online, CharmLinkState.Online) }}
      battery={{ percent: 64, charging: true, at: Date.now() }}
    />,
    async () => {
      await settle()
      assert.equal(marks().length, 0, "a band with nothing in it, as the glass draws one")
      assert.match(text(), /64%/, "and the level, which a settings page always has room for")
    },
  )
})

test("a read that failed says in the console why, not only that it did", async () => {
  // Refused, disconnected and timed out all read as one "out of reach" on the page, so the reason
  // the ask gave is the one place it survives.
  const noted: unknown[][] = []
  const debug = console.debug
  console.debug = (...args: unknown[]) => noted.push(args)
  try {
    const api = radio({
      status: async () => {
        throw new Error("GATT 133: the link dropped")
      },
    })
    await mount(<Network api={api} />, async () => {
      await until(async () => noted.length > 0, "the failure noted")
    })
  } finally {
    console.debug = debug
  }
  assert.ok(
    noted.some((args) => args.some((arg) => String(arg).includes("GATT 133"))),
    "the reason the ask failed, not just the fact that it did",
  )
})

test("the page's one read fills the status row and the section below it", async () => {
  // One ask, drawn twice: the status row marks the link the report says is down, and the section's
  // Wi-Fi line is the answer that same ask carried — a page cannot disagree with itself about what
  // the charm said.
  const api = radio()
  function Page() {
    const { read, refresh } = useCharmReport(api)
    return (
      <>
        <CharmStatusRow charm={{ name: "Desk charm" }} status={read} />
        <CharmNetwork read={read} refresh={refresh} />
      </>
    )
  }
  await mount(<Page />, async () => {
    await until(async () => text().includes("Connected to Home"), "the charm's answer")
    assert.ok(
      labelled('[role="img"]', "Tailnet is down"),
      "the row marks what the same report said",
    )
    assert.ok(
      missing('[role="img"][aria-label="Wi-Fi is down"]'),
      "and nothing for a link that is up",
    )
  })
})

test("a read that failed marks the phone's link and leaves the charm's lines unread", async () => {
  // The ask never opened: that is the Bluetooth mark, and the two lines it would have filled fall
  // back to what this phone last told the charm — not to a link drawn as connected.
  const api = radio({
    status: async () => {
      throw new Error("The charm went out of reach")
    },
  })
  function Page() {
    const { read, refresh } = useCharmReport(api)
    return (
      <>
        <CharmStatusRow charm={{ name: "Desk charm" }} status={read} />
        <CharmNetwork api={api} read={read} refresh={refresh} />
      </>
    )
  }
  await mount(<Page />, async () => {
    await until(async () => marks().length > 0, "the failed read")
    assert.equal(marks().length, 1)
    assert.ok(labelled('[role="img"]', "Bluetooth is down"), "the ask that did not open")
    assert.ok(text().includes("Not set"), "and the Wi-Fi line is what the phone last knew")
    assert.ok(!text().includes("Connected"), "never an answer the charm did not give")
  })
})

test("the level is drawn once, and the battery row asks for it", async () => {
  // A reader who scrolls the paired group sees the level in one place: the status row's line. The
  // battery row is the control that asks the charm again, so it says what a tap does instead.
  const now = Date.now()
  await mount(
    <>
      <CharmStatusRow
        charm={{ name: "Desk charm" }}
        status={{ state: "read", value: report(CharmLinkState.Online, CharmLinkState.Online) }}
        battery={{ percent: 82, charging: true, at: now }}
      />
      <BatteryRow busy={false} onRefresh={() => {}} />
    </>,
    async () => {
      await settle()
      assert.equal((text().match(/82%/g) ?? []).length, 1, "the level is drawn once on the page")
      assert.ok(text().includes("Tap to ask the charm"), "and the row that asks says so")
    },
  )
})

test("the battery row asks when tapped, and draws a failed ask in the charm's words", async () => {
  let asked = 0
  await mount(<BatteryRow busy={false} onRefresh={() => asked++} />, async () => {
    await settle()
    assert.ok(text().includes("Tap to ask the charm"), "the row says what a tap does")
    assert.ok(!text().includes("%"), "and the level is the status row's to draw")
    await click(rowButton("Battery"))
    assert.equal(asked, 1) // tapping the row asks the charm again
  })

  // A failed ask is this row's own line: the battery is the one thing it is about.
  await mount(
    <BatteryRow
      note="This charm's firmware is older than the app — update it"
      busy={false}
      onRefresh={() => {}}
    />,
    async () => {
      await settle()
      assert.ok(text().includes("firmware is older than the app"), "why the ask failed")
      assert.ok(!text().includes("Tap to ask the charm"), "said over what a tap would do")
    },
  )
})

/** The token the host mints: 32 bytes, hex, as `talk_tokens.mint` answers one. */
const TOKEN = "9c".repeat(32)
/** The address a charm can call: the host on the tailnet, in the plain http its client speaks. */
const TAILNET = "http://100.64.0.2:8642/api/plugins/gots"
/** The address the host answers with: where this phone dialled it. */
const APP_HOST = "https://bot.example/api/plugins/gots"

/** The Voice row's two reaches, over a stand-in: one ask of the host, one write to the charm. */
function voice(overrides: Partial<CharmVoiceApi> = {}): CharmVoiceApi {
  return {
    offer: async () => ({ host: TAILNET, bot: "4f1c2a90", token: TOKEN }),
    send: async () => CharmCode.Ok,
    ...overrides,
  }
}

/**
 * A bot's host as the Voice row asks it: its feature list, and its one hand-over answer. Every ask
 * is recorded with the key it carried, since the hand-over is the app's key and no other.
 */
function serveTalk(name: string, features: string[], answer: unknown) {
  const profile = connection(name)
  const asked: { path: string; authorization: string | null }[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    asked.push({
      path: url.pathname + url.search,
      authorization: new Headers(init?.headers).get("Authorization"),
    })
    if (url.pathname.endsWith("/plugins/gots/info"))
      return json({ name: "gots", version: "1.0.0", features })
    if (url.pathname.endsWith("/plugins/gots/talk")) return json(answer)
    return json({ error: { message: "no route" } }, 404)
  }) as unknown as typeof fetch
  return { profile, asked: () => asked }
}

test("the voice row is offered only where the host advertises talk", async () => {
  // A host older than the route has nothing to mint, so the row is not drawn at all.
  const older = serveTalk("talk-absent", ["charm_firmware"], {})
  await mount(<CharmVoice profile={older.profile} api={voice()} />, async () => {
    await settle()
    assert.ok(!text().includes("Voice"), "no row for a host with no token to mint")
    assert.ok(!find("#charm-talk-address"), "and no address field either")
  })

  const newer = serveTalk("talk-offered", ["charm_firmware", "talk"], {})
  await mount(<CharmVoice profile={newer.profile} api={voice()} />, async () => {
    await until(
      async () => text().includes("Voice"),
      "the row, once the host says it has the route",
    )
    assert.ok(text().includes("Hold B on your charm"), "and what the setting is for")
  })
})

test("a write that never landed keeps the token, so one drop costs no second mint", async () => {
  // The link, not the address: the charm is out of reach before the write can be answered.
  const api = voice({
    offer: async () => ({ host: TAILNET, bot: "4f1c2a90", token: TOKEN }),
    send: async () => {
      throw new Error("The charm went out of reach")
    },
  })
  await mount(<CharmVoice api={api} profile={connection("talk-drop")} />, async () => {
    await until(async () => Boolean(find("#charm-talk-setup")), "the row's controls")
    await click(find("#charm-talk-setup"))
    await settle()
    await click(find("#charm-talk-send"))
    await settle()
    assert.ok(text().includes("The charm went out of reach"), "the row says why nothing landed")
    assert.equal(
      (find("#charm-talk-send") as HTMLButtonElement | null)?.disabled,
      false,
      "the token is still this phone's to hand over: setting up again would revoke the charm's",
    )
    // And a second Send is the same token, not a fresh ask of the host.
    await click(find("#charm-talk-send"))
    await settle()
    assert.ok(text().includes("The charm went out of reach"), "the same write, tried again")
  })
})

test("an answer that did not keep it leaves the token here, and the row says so", async () => {
  const cases = [
    ["busy", CharmCode.Busy],
    ["full", CharmCode.StorageFailed],
  ] as const
  for (const [why, code] of cases) {
    const wrote: string[] = []
    const api = voice({
      send: async (_address, token) => {
        wrote.push(token)
        return code
      },
    })
    await mount(<CharmVoice api={api} profile={connection(`talk-keep-${why}`)} />, async () => {
      await until(async () => Boolean(find("#charm-talk-setup")), "the row's controls")
      await click(find("#charm-talk-setup"))
      await settle()
      await click(find("#charm-talk-send"))
      await settle()
      assert.ok(text().includes(codeWords(code)), "the charm's answer is what the row draws")
      assert.ok(
        text().includes("still on this phone"),
        "and that the token is still here to send: the charm never kept it",
      )
      assert.equal(
        (find("#charm-talk-send") as HTMLButtonElement | null)?.disabled,
        false,
        "Send is not spent, since nothing was kept",
      )
      // The same token goes again rather than a new one minted over the token the charm never kept.
      await click(find("#charm-talk-send"))
      await settle()
      assert.deepEqual(wrote, [TOKEN, TOKEN], "the retry is the same token")
    })
  }
})

test("a charm already set up is offered Set up again, and told what that spends", async () => {
  await mount(
    <CharmVoice talk api={voice()} profile={connection("talk-set-up")} />,
    async () => {
      await until(async () => Boolean(find("#charm-talk-setup")), "the row's controls")
      assert.equal(
        (find("#charm-talk-setup") as HTMLElement | null)?.textContent?.trim(),
        "Set up again",
        "the charm holds a token, so the row says what the tap does to it",
      )
      assert.ok(
        text().includes("mints a new token and revokes the one your charm holds"),
        "and that setting up again spends it",
      )
    },
  )
  await mount(<CharmVoice api={voice()} profile={connection("talk-never")} />, async () => {
    await until(async () => Boolean(find("#charm-talk-setup")), "the row's controls")
    assert.equal(
      (find("#charm-talk-setup") as HTMLElement | null)?.textContent?.trim(),
      "Set up",
      "the first set-up is the plain one",
    )
    assert.ok(!text().includes("revokes"), "there is nothing of the charm's to spend yet")
  })
})

test("the voice row asks the host for the address and the token, with the app's key", async () => {
  const host = serveTalk("talk-handover", ["talk"], {
    object: "gots.talk",
    host: APP_HOST,
    bot: "4f1c2a90",
    token: TOKEN,
  })
  // The row's own reaches, not a stand-in's: this is the ask the app really makes.
  await mount(<CharmVoice profile={host.profile} />, async () => {
    await until(async () => Boolean(find("#charm-talk-setup")), "the row's controls")
    await click(find("#charm-talk-setup"))
    await settle()
    assert.equal(
      (find("#charm-talk-address") as HTMLInputElement | null)?.value,
      APP_HOST,
      "the address the host answered is filled in, and editable",
    )
    const asked = host.asked().find((one) => one.path.endsWith("/plugins/gots/talk"))
    assert.ok(asked, "the hand-over route was asked")
    assert.equal(
      asked.authorization,
      `Bearer ${host.profile.apiKey}`,
      "with the app's key, as every plugin route is",
    )
    assert.ok(!text().includes(TOKEN), "the token is held for the write, not drawn on the page")
  })
})

test("Set up fills the address in, and Send writes what the reader left", async () => {
  const wrote: [string, string][] = []
  const api = voice({
    send: async (address, token) => {
      wrote.push([address, token])
      return CharmCode.Ok
    },
  })
  await mount(<CharmVoice api={api} profile={connection("talk-writes")} />, async () => {
    await until(async () => Boolean(find("#charm-talk-setup")), "the row's controls")
    assert.equal(
      (find("#charm-talk-send") as HTMLButtonElement | null)?.disabled,
      true,
      "Send waits on the host's answer",
    )
    await click(find("#charm-talk-setup"))
    await settle()
    assert.equal((find("#charm-talk-address") as HTMLInputElement | null)?.value, TAILNET)
    await click(find("#charm-talk-send"))
    await settle()
    assert.deepEqual(wrote, [[TAILNET, TOKEN]], "the address and the minted token, as one write")
    assert.ok(text().includes("Sent to your charm."), "and the row says it went")
    assert.ok(!text().includes(TOKEN), "nothing draws it")
    assert.ok(
      !JSON.stringify({ ...localStorage }).includes(TOKEN),
      "and nothing keeps it on the phone after the write",
    )
    assert.equal(
      (find("#charm-talk-send") as HTMLButtonElement | null)?.disabled,
      true,
      "a second Send would write nothing: a new token is the host's to mint",
    )
  })
})

test("an address the charm could not call is refused in words, and nothing is written", async () => {
  const wrote: string[] = []
  const api = voice({
    offer: async () => ({ host: APP_HOST, bot: "4f1c2a90", token: TOKEN }),
    send: async (address) => {
      wrote.push(address)
      return CharmCode.Ok
    },
  })
  await mount(<CharmVoice api={api} profile={connection("talk-https")} />, async () => {
    await until(async () => Boolean(find("#charm-talk-setup")), "the row's controls")
    await click(find("#charm-talk-setup"))
    await settle()
    // The host answers the address this phone dialled: https, which the charm does not speak.
    await click(find("#charm-talk-send"))
    await settle()
    assert.deepEqual(wrote, [], "nothing went over the link")
    assert.ok(text().includes("plain http"), "the row says what the charm speaks instead")
    assert.ok(text().includes("tailnet address"), "and where to find the one it can call")
    assert.equal(
      (find("#charm-talk-send") as HTMLButtonElement | null)?.disabled,
      false,
      "the token is still held: the reader can fix the address and send again",
    )
    // Edited to the address the charm reaches the host at, the same write goes.
    await type(find("#charm-talk-address"), TAILNET)
    await click(find("#charm-talk-send"))
    await settle()
    assert.deepEqual(wrote, [TAILNET], "the address the reader left is the one written")
  })
})

test("a plaintext charm's keep is said in the charm's own words, and the token in the hint", async () => {
  // 11 on the wire: the charm kept the address and the token, and warns that the chip gives them away.
  const api = voice({ send: async () => CharmCode.KeptReadable })
  await mount(<CharmVoice api={api} profile={connection("talk-readable")} />, async () => {
    await until(async () => Boolean(find("#charm-talk-setup")), "the row's controls")
    await click(find("#charm-talk-setup"))
    await settle()
    // The row prefill is the host's answer here, so send what the charm can call.
    await type(find("#charm-talk-address"), TAILNET)
    await click(find("#charm-talk-send"))
    await settle()
    assert.ok(
      text().includes(codeWords(CharmCode.KeptReadable)),
      "code 11 is the charm's own sentence, not a second one for this row",
    )
    assert.ok(text().includes("read it off the chip"), "and it is not glossed")
    // What is *the token's* about it is the row's hint, said once for the row rather than once more
    // for one code: a charm whose flash isn't sealed lets anyone holding it read the token off it.
    assert.ok(text().includes("read the token off the chip"), "the hint names the token")
  })
})

test("a charm that does not speak the op is named, and not blamed on the sync", async () => {
  // An app may land before the firmware that speaks Talk: the row sends the reader to the update.
  const api = voice({ send: async () => CharmCode.BadMessage })
  await mount(<CharmVoice api={api} profile={connection("talk-old-firmware")} />, async () => {
    await until(async () => Boolean(find("#charm-talk-setup")), "the row's controls")
    await click(find("#charm-talk-setup"))
    await settle()
    await type(find("#charm-talk-address"), TAILNET)
    await click(find("#charm-talk-send"))
    await settle()
    assert.ok(text().includes("older than the app"), "the charm's firmware is what needs updating")
    assert.ok(!text().includes("didn't understand the sync"), "not the sync's refusal")
  })
})
