/**
 * Settings → Charm on the web: there is no radio to reach a Gots Charm with outside the Android
 * app, so the menu offers no row, and the section, reached by its address, says where to pair one.
 * The phone's own Network section is drawn here too, over a stand-in for the radio: what a charm's
 * answer reads as, and that a passphrase is never drawn back.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { CharmNetwork, type CharmNetworkApi } from "@/components/settings/charm"
import { CHARM_SLOT_BYTES, CharmLinkState, CharmUpdateState } from "@/lib/charm-protocol"
import { db } from "@/lib/db"
import { SettingsPage } from "@/routes/settings"
import { BatteryRow, WakingGroup } from "@/components/settings/charm"
import {
  Path,
  click,
  find,
  findText,
  mount,
  seedSettings,
  settle,
  text,
  type,
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
    assert.ok(page.includes("Allow once, Deny and Show on Phone"), "the approval's buttons are named")
    assert.ok(page.includes("Show on Phone alone"), "and the question's one")
  })
})

/**
 * The Network section's radio, as the phone would answer it. Each call is one control ask over BLE;
 * this stands in for the charm, since nothing here can drive a real radio.
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
    published: async () => ({ version: "0.1.0", size: 4, sha256: "ab".repeat(32) }),
    image: async () => new Uint8Array([1, 2, 3, 4]),
    upload: async (image, _sha256Hex, onProgress) => {
      const done = { sent: image.length, total: image.length, percent: 100 }
      onProgress?.(done)
      return done
    },
    ...overrides,
  }
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
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
    assert.ok(text().includes("Not set"), "the Wi-Fi line, with nothing to say yet")
    assert.ok(!text().includes("Connected"), "and nothing it could not know")
  })
})

test("a parsed answer says the charm is connected", async () => {
  await mount(<CharmNetwork api={radio()} />, async () => {
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
  await mount(<CharmNetwork api={api} />, async () => {
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

test("the firmware row offers the published one when the charm is older", async () => {
  await mount(
    <CharmNetwork api={radio({ published: async () => PUBLISHED })} />,
    async () => {
      await settle()
      assert.ok(text().includes("Charm 0.1.0 · 0.2.0 available"), "both versions on the row")
      assert.ok(button("Update to 0.2.0"), "the newer one is offered")
      assert.ok(button("Choose a file…"), "and a file is always taken")
    },
  )
})

test("the firmware row says the charm is up to date when the versions match", async () => {
  await mount(<CharmNetwork api={radio()} />, async () => {
    await settle()
    assert.ok(text().includes("Charm 0.1.0 · up to date"))
    assert.ok(!button("Update to"), "nothing to offer")
    assert.ok(button("Choose a file…"), "but a file is still taken")
  })
})

test("a charm ahead of the package is said, and never offered a downgrade", async () => {
  const api = radio({
    version: async () => "0.3.0",
    published: async () => ({ version: "0.2.0", size: 4, sha256: "cd".repeat(32) }),
  })
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
    assert.ok(text().includes("Charm 0.3.0 · newer than 0.2.0"), "the row says the charm is ahead")
    assert.ok(!find("#charm-update-start"), "and offers no update")
  })
})

test("a charm too old to say its version is not compared with the package", async () => {
  const api = radio({
    version: async () => null,
    published: async () => PUBLISHED,
  })
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
    assert.ok(text().includes("can't say which version it runs"), "the row says what it heard")
    assert.ok(text().includes("cable"), "and how the first one gets there")
    assert.ok(!find("#charm-update-start"), "nothing is offered over the air")
    assert.ok(button("Choose a file…"), "the picker still works")
  })
})

test("a host that can't answer says it couldn't check, in its own words", async () => {
  const said = "GitHub refused this server's token for the charm firmware."
  const api = radio({
    published: async () => {
      throw new Error(said)
    },
  })
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
    assert.ok(text().includes("couldn't check for a newer one"), "the row says the check failed")
    assert.ok(text().includes(said), "with the host's own sentence")
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
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
    await pick("too-big.bin", CHARM_SLOT_BYTES + 1)
    assert.ok(text().includes("larger than a slot"), "the row refuses it in words")
    assert.deepEqual(asked, [], "and no control write reached the charm")
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
  await mount(<CharmNetwork api={api} />, async () => {
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
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
    await pick("charm.bin", 8)
    assert.ok(text().includes("The update failed: it was cancelled"))
  })
})

test("Update sends the published image and reads the version once the charm is back", async () => {
  const sent: { bytes: Uint8Array; sha256: string }[] = []
  let reads = 0
  const api = radio({
    published: async () => IMAGE_PUBLISHED,
    // The charm answers its old version until the upload lands, then the new one.
    version: async () => (++reads > 1 ? "0.2.0" : "0.1.0"),
    image: async () => IMAGE,
    upload: async (image, sha256Hex, onProgress) => {
      sent.push({ bytes: image, sha256: sha256Hex })
      const done = { sent: image.length, total: image.length, percent: 100 }
      onProgress?.(done)
      return done
    },
  })
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
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
    published: async () => IMAGE_PUBLISHED,
    // A truncated body, an error page, or a tag that moved: not the bytes the version described.
    image: async () => new Uint8Array([1, 2, 3, 4]),
    upload: async (image) => {
      uploads.push(image)
      return { sent: image.length, total: image.length, percent: 100 }
    },
  })
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
    await click(button("Update to 0.2.0"))
    await settle()
    assert.deepEqual(uploads, [], "no UpdateBegin reached the charm")
    assert.ok(text().includes("isn't the one the version names"), "the row says why")
  })
})

test("a version that moved between the reads is read again, and its image goes", async () => {
  let reads = 0
  const sent: { sha256: string }[] = []
  const api = radio({
    // The row read the old version on opening; a merge published a new one before the tap.
    published: async () => (++reads === 1 ? PUBLISHED : IMAGE_PUBLISHED),
    image: async () => IMAGE,
    upload: async (_image, sha256Hex) => {
      sent.push({ sha256: sha256Hex })
      return { sent: IMAGE.length, total: IMAGE.length, percent: 100 }
    },
  })
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
    await click(button("Update to 0.2.0"))
    await settle()
    assert.equal(sent.length, 1, "the image that arrived is sent")
    assert.equal(sent[0].sha256, IMAGE_SHA, "with the hash computed over it")
  })
})

test("a charm that cannot be reached is not a charm that didn't say", async () => {
  const api = radio({
    published: async () => PUBLISHED,
    version: async () => {
      throw new Error("The charm went out of reach")
    },
  })
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
    assert.ok(
      text().includes("0.2.0 published · couldn't reach the charm"),
      "the link's failure is its own sentence",
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
    published: async () => IMAGE_PUBLISHED,
    version: async () => (landed ? "0.2.0" : "0.1.0"),
    image: async () => IMAGE,
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
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
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
  let publishedReads = 0
  const api = radio({
    published: async () => {
      publishedReads += 1
      return IMAGE_PUBLISHED
    },
    // The charm answers the build it started on, however often it is asked.
    version: async () => "0.1.0",
    image: async () => IMAGE,
    upload: async () => ({ sent: IMAGE.length, total: IMAGE.length, percent: 100 }),
  })
  await mount(<CharmNetwork api={api} />, async () => {
    await settle()
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
    assert.ok(publishedReads >= 2, "and what is published is read again")
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
  await mount(<CharmNetwork api={api} />, async () => {
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

test("the firmware group warns once that the published image is the encrypted build", async () => {
  await mount(<CharmNetwork api={radio()} />, async () => {
    await settle()
    const warnings = (text().match(/flash-encryption key for good/g) ?? []).length
    assert.equal(warnings, 1, "said once, not beside every control")
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
    <WakingGroup
      wake={{ doubleTap: false, quietSeconds: 30 }}
      busy={false}
      onChange={() => {}}
    />,
    async () => {
      await settle()
      assert.ok(text().includes("Only the buttons wake it"))
      assert.ok(text().includes("30 seconds"))
    },
  )
})

test("the battery row says the level, the charger and how old the reading is", async () => {
  let asked = 0
  await mount(
    <BatteryRow
      reading={{ percent: 82, charging: true, at: Date.now() }}
      busy={false}
      onRefresh={() => asked++}
    />,
    async () => {
      await settle()
      assert.match(text(), /82% · Charging · just now/)
      await click(rowButton("Battery"))
      assert.equal(asked, 1)  // tapping the row asks the charm again
    },
  )

  // A reading nobody has asked for is not a battery at zero.
  await mount(<BatteryRow busy={false} onRefresh={() => {}} />, async () => {
    await settle()
    assert.ok(text().includes("Not read yet"))
  })
})
