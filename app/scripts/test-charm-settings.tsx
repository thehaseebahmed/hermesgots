/**
 * Settings → Charm on the web: there is no radio to reach a Gots Charm with outside the Android
 * app, so the menu offers no row, and the section, reached by its address, says where to pair one.
 * The phone's own Network section is drawn here too, over a stand-in for the radio: what a charm's
 * answer reads as, and that a passphrase is never drawn back. The paired page is mounted from facts
 * alone, so its cards and the Firmware row inside them are read without a radio at all.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { type ComponentProps, act, useState } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import {
  CharmNetwork,
  CharmSections,
  CharmVoiceHeld,
  CharmVoiceScheme,
  FirmwareRow,
  type CharmNetworkApi,
} from "@/components/settings/charm"
import {
  useCharmFirmware,
  useCharmReport,
  useReturnSync,
  type CharmFirmwareFacts,
} from "@/lib/charm"
import { CharmLinkState, CharmTailnetReason, CharmUpdateState } from "@/lib/charm-protocol"
import { db } from "@/lib/db"
import { SettingsPage } from "@/routes/settings"
import { BatteryRow, CharmStatusRow, WakingGroup } from "@/components/settings/charm"
import { report } from "./fixtures/charm-report.ts"
import {
  PHONE_AND_TABLET_IN_BOTH_MODES,
  Nav,
  Path,
  atMode,
  botProfile,
  click,
  findAll,
  find,
  findText,
  labelled,
  missing,
  mount,
  nav,
  seedSettings,
  serveFirmware,
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
 * about the published firmware is not the charm's: the page's facts carry it, drawn from
 * `firmwareFacts` below.
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
    ...overrides,
  }
}

/**
 * The Network section as the page draws it: the page's own read is made once, above the section, and
 * handed down — the one ask the status row and the two link lines both read. The router is here
 * because the section's buttons open the update's own screen, which the route beneath them holds.
 */
function Network({
  api,
  ...rest
}: { api?: CharmNetworkApi } & Omit<
  ComponentProps<typeof CharmNetwork>,
  "api" | "read" | "refresh"
>) {
  const { read, refresh } = useCharmReport(api)
  return (
    <MemoryRouter>
      <CharmNetwork api={api} read={read} refresh={refresh} {...rest} />
    </MemoryRouter>
  )
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

test("the section follows the tunnel until the charm says why it is not up", async () => {
  // A key was just saved: the charm holds it and has not started the tunnel yet, so its first answer
  // is off with no reason. It tries, fails and says which — and the row ends on that, without the
  // reader closing and reopening the section to ask again.
  let asked = 0
  const api = radio({
    status: async () => {
      asked += 1
      return {
        wifi: { state: CharmLinkState.Online, reason: 0, ip: "192.168.1.20", ssid: "Home" },
        tailnet:
          asked === 1
            ? { state: CharmLinkState.Off, ip: "" }
            : { state: CharmLinkState.Failed, ip: "", reason: CharmTailnetReason.BadKey },
      }
    },
  })
  await mount(<Network api={api} tailnet />, async () => {
    await settle()
    assert.ok(text().includes("Key saved; not joined"), "the first answer, before the charm tried")
    await until(
      async () => text().includes("The tailnet refused the key"),
      "the reason the tunnel failed",
      6000,
    )
    assert.ok(asked > 1, "the section asked again on its own")
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

/** The first button whose words contain `label`: the sheet's rows and the page's rows are buttons. */
const rowButton = (label: string) => findText("button", label)

/**
 * The page as the phone draws it, from facts alone: no radio, no store and no effect, so a case
 * reads only what the sections do with what they are handed.
 */
function sections(overrides: Partial<ComponentProps<typeof CharmSections>> = {}) {
  const nothing = () => {}
  return (
    <MemoryRouter>
      <CharmSections
        charm={{ deviceId: "charm-1", name: "Desk charm" }}
        report={{
          read: { state: "read", value: report(CharmLinkState.Online, CharmLinkState.Off) },
          refresh: async () => {},
        }}
        firmware={firmwareFacts()}
        sources={[botProfile("pocket")]}
        botsRead
        labels={new Map()}
        busy={null}
        progress={null}
        wake={{ doubleTap: true, quietSeconds: 15 }}
        scheme="https"
        held={null}
        heldFailed={false}
        onSync={nothing}
        onTest={nothing}
        onTogglePet={nothing}
        onPickPet={nothing}
        onWake={nothing}
        onScheme={nothing}
        onBattery={nothing}
        onForget={nothing}
        onOpenFirmware={nothing}
        {...overrides}
      />
    </MemoryRouter>
  )
}

/** Each card on the page, in the order the page draws it, as the words inside it. */
const cards = () => findAll("[data-settings-group]").map((card) => card.textContent ?? "")

/** The muted sentence a card does not hold: the page's caption. */
const captions = () => findAll('p[class*="text-[13px]"]')

test("the sections run Device, Bots, Waking, Voice, Wi-Fi, Tailnet, Forget, one caption", async () => {
  await mount(sections(), async () => {
    await settle()
    const drawn = cards()
    assert.equal(drawn.length, 7, "seven cards: the device first, then each thing about it")
    const [device, bots, waking, voice, wifi, tailnet, forget] = drawn
    /** A card's rows, in the order the reader meets them. */
    const rows = (card: string, ...names: string[]) => {
      let seen = -1
      for (const name of names) {
        const at = card.indexOf(name)
        assert.ok(at > seen, `"${name}" is drawn after the row before it`)
        seen = at
      }
    }
    rows(device, "Desk charm", "Battery", "Firmware")
    rows(bots, "Sync", "Pet mode", "Send a test alert")
    rows(waking, "Double tap to wake", "Stays lit for")
    rows(voice, "Voice over https", "Your charm holds")
    assert.ok(wifi.includes("Wi-Fi"), "the network's own card, after the voice")
    assert.ok(tailnet.includes("Tailnet"), "and the tailnet's")
    assert.ok(forget.includes("Forget this charm"), "the page ends on the way out")
    assert.equal(captions().length, 1, "one caption, the page's last word")
    assert.ok(captions()[0].textContent?.includes("Keep the charm close"), "which is the close one")
  })
})

test("the network section draws no Firmware group and neither caption", async () => {
  await mount(<Network api={radio()} />, async () => {
    await settle()
    assert.ok(text().includes("Tailnet"), "the two links are still the section's")
    assert.ok(!text().includes("Firmware"), "the firmware row is the device's, not the network's")
    assert.ok(!text().includes("everyday build"), "and the row's caption went with it")
    assert.ok(
      !text().includes("The image goes over the charm's own link"),
      "so did the section's own",
    )
  })
})

/**
 * Every spinner in the app stops under `prefers-reduced-motion`: `motion-safe:` is what makes the
 * arrow that says a sync is running a courtesy rather than a flicker the reader cannot switch off.
 */
test("the sync row's spinner stops for a reader who asked for less motion", async () => {
  await mount(sections({ busy: "sync" }), async () => {
    await settle()
    const moving = findAll("svg").filter(
      (one) => one.classList.contains("animate-spin") || one.classList.contains("motion-safe:animate-spin"),
    )
    assert.equal(moving.length, 1, "one mark on the page says the sync is running")
    assert.ok(
      moving[0].classList.contains("motion-safe:animate-spin"),
      "and it is drawn for a reader who did not ask for less motion",
    )
  })
})

const PUBLISHED = { version: "0.2.0", size: 4, sha256: "cd".repeat(32) }

/**
 * The facts the page hands the row: the charm's own answer, the host's record of what it publishes,
 * and where this charm's download has got to. Drawn from these alone, the row asks the charm
 * nothing, so a case states each fact it means to read.
 */
function firmwareFacts(overrides: Partial<CharmFirmwareFacts> = {}): CharmFirmwareFacts {
  return {
    running: { state: "says", version: "0.1.0" },
    published: PUBLISHED.version,
    answered: true,
    checkSaid: null,
    update: { state: "read", value: { state: CharmUpdateState.Idle, percent: 0, reason: 0 } },
    read: async () => undefined,
    ...overrides,
  }
}

/**
 * The firmware's facts are the page's one read: the risk the split carries is a row that polls
 * beside them, which would put two asks on one link. Read here as the hook a page calls, and then
 * as the row handed what it read — the hook asks each thing once, and the row asks nothing at all.
 */
test("the firmware's facts are asked once, and a row handed them asks nothing", async () => {
  let versions = 0
  let downloads = 0
  const api = radio({
    version: async () => {
      versions += 1
      return "0.1.0"
    },
    updateStatus: async () => {
      downloads += 1
      return { state: CharmUpdateState.Idle, percent: 0, reason: 0 }
    },
  })
  const host = serveFirmware("charm-firmware-once", PUBLISHED)
  let held: CharmFirmwareFacts | undefined
  function Page() {
    const facts = useCharmFirmware(api, host.profile)
    held = facts
    return <FirmwareRow facts={facts} busy={false} onOpenFirmware={() => {}} />
  }
  await mount(<Page />, async () => {
    await until(async () => text().includes("Charm 0.1.0 · 0.2.0 available"), "the row's line")
    assert.deepEqual([versions, downloads], [1, 1], "one ask of each — and not one per render")
  })

  const facts = held
  assert.ok(facts, "the hook answered the page its facts")
  await mount(<FirmwareRow facts={facts} busy={false} onOpenFirmware={() => {}} />, async () => {
    await settle()
    assert.deepEqual([versions, downloads], [1, 1], "a row handed the facts asks the charm nothing")
  })
})

test("the firmware row offers the published one when the charm is older", async () => {
  let opened = 0
  await mount(sections({ onOpenFirmware: () => opened++ }), async () => {
    await settle()
    assert.ok(text().includes("Charm 0.1.0 · 0.2.0 available"), "the host's answer, in the row")
    assert.equal(
      find('[data-tag="Update"]')?.textContent,
      "Update",
      "and the row is marked as an offer",
    )
    await click(rowButton("Firmware"))
    assert.equal(opened, 1, "the row opens the update's own screen, where a file is taken")
  })
})

test("the firmware row says the charm is up to date when the versions match", async () => {
  await mount(sections({ firmware: firmwareFacts({ published: "0.1.0" }) }), async () => {
    await settle()
    assert.ok(text().includes("Charm 0.1.0 · up to date"), "the host's answer, in the row")
    assert.ok(missing('[data-tag="Update"]'), "nothing to offer")
  })
})

test("a charm ahead of the package is said, and never offered a downgrade", async () => {
  await mount(
    sections({ firmware: firmwareFacts({ running: { state: "says", version: "0.3.0" } }) }),
    async () => {
      await settle()
      assert.ok(
        text().includes("Charm 0.3.0 · newer than 0.2.0"),
        "the two versions, in the row",
      )
      assert.ok(missing('[data-tag="Update"]'), "and offers no update")
    },
  )
})

test("a charm too old to say its version is not compared with the package", async () => {
  await mount(sections({ firmware: firmwareFacts({ running: { state: "too-old" } }) }), async () => {
    await settle()
    assert.ok(text().includes("can't say which version it runs"), "the row's line")
    assert.ok(text().includes("cable"), "and how the first one gets there")
    assert.ok(missing('[data-tag="Update"]'), "nothing is offered over the air")
  })
})

test("a host that can't answer says it couldn't check, in its own words", async () => {
  const said = "GitHub refused this server's token for the charm firmware."
  await mount(
    sections({ firmware: firmwareFacts({ published: undefined, checkSaid: said }) }),
    async () => {
      await settle()
      assert.ok(text().includes(said), "the host's sentence")
      assert.ok(text().includes("couldn't check for a newer one"), "the row says the check failed")
      assert.ok(
        text().indexOf(said) > text().indexOf("Firmware"),
        "and the sentence stands under the row it is about, not at the page's foot",
      )
    },
  )
})

test("an image the charm refuses for its build is drawn in the charm's own reason", async () => {
  // 7 on the wire is the charm's `WrongScheme`: the image was built for the other kind of board, so
  // the row draws that reason rather than "the charm didn't say why".
  const update = { state: CharmUpdateState.Failed, percent: 0, reason: 7 }
  await mount(sections({ firmware: firmwareFacts({ update: { state: "read", value: update } }) }), async () => {
    await settle()
    assert.ok(
      text().includes("Update failed: that image was built for a different kind of charm"),
      "the charm's reason in words",
    )
    assert.ok(!text().includes("didn't say why"), "the reason is named, not left unnamed")
  })
})

test("a download running is the row's own line, over the versions", async () => {
  const update = { state: CharmUpdateState.Downloading, percent: 42, reason: 0 }
  await mount(sections({ firmware: firmwareFacts({ update: { state: "read", value: update } }) }), async () => {
    await settle()
    assert.ok(text().includes("Downloading… 42%"), "where the charm's download has got to")
    assert.ok(!text().includes("0.2.0 available"), "said in place of the versions while one runs")
  })
})

test("a charm that cannot be reached is not a charm that didn't say", async () => {
  await mount(sections({ firmware: firmwareFacts({ running: { state: "unreachable" } }) }), async () => {
    await settle()
    assert.ok(
      text().includes("0.2.0 published · couldn't reach the charm"),
      "the link's own sentence",
    )
    assert.ok(!text().includes("didn't say"), "not blamed on the charm's firmware")
    assert.ok(missing('[data-tag="Update"]'), "and nothing is offered on a version nobody read")
  })
})

test("a busy page opens no screen from the firmware row", async () => {
  let opened = 0
  await mount(sections({ busy: "sync", onOpenFirmware: () => opened++ }), async () => {
    await settle()
    await click(rowButton("Firmware"))
    assert.equal(opened, 0, "a send under way is never left for the update's screen")
  })
})

/**
 * The convention `AGENTS.md` asks of every screen, read here for this page: the phone and the tablet,
 * light and dark. A DOM lays nothing out and paints nothing, so this is the page's own structure at
 * each of the four combinations — every card in its place, the Firmware row and its tag — and not
 * one pixel of it: the colour and the contrast are the stories' to show and the device's to judge.
 */
test("the sections draw at 390 and at 768, in light and in dark", async () => {
  for (const { width, dark, said } of PHONE_AND_TABLET_IN_BOTH_MODES) {
    await atMode(width, dark, async () => {
      await mount(sections(), async () => {
        await settle()
        assert.equal(
          document.documentElement.classList.contains("dark"),
          dark,
          `${said}: the mode this case reads the page under`,
        )
        const drawn = cards()
        assert.equal(drawn.length, 7, `${said}: seven cards, Device first and Forget last`)
        const [device, bots, waking, voice, wifi, tailnet, forget] = drawn
        assert.ok(device.includes("Desk charm"), `${said}: the charm, named in the Device card`)
        assert.ok(device.includes("Battery"), `${said}: its charge, the row that asks for it`)
        assert.ok(
          device.includes("Charm 0.1.0 · 0.2.0 available"),
          `${said}: the build and the one published ahead of it`,
        )
        assert.equal(
          find('[data-tag="Update"]')?.textContent,
          "Update",
          `${said}: and the row is tagged, since the host offers one`,
        )
        assert.ok(bots.includes("Sync"), `${said}: the Bots card's sync`)
        assert.ok(bots.includes("Pet mode"), `${said}: its pet switch`)
        assert.ok(bots.includes("Send a test alert"), `${said}: and the alert that proves it`)
        assert.ok(
          waking.includes("Double tap to wake") && waking.includes("Stays lit for"),
          `${said}: the Waking card`,
        )
        assert.ok(voice.includes("Voice over https"), `${said}: the Voice card`)
        assert.ok(
          wifi.includes("Network name") && wifi.includes("Passphrase"),
          `${said}: the Wi-Fi card's two fields`,
        )
        assert.ok(tailnet.includes("Auth key"), `${said}: the Tailnet card's field`)
        assert.ok(forget.includes("Forget this charm"), `${said}: the page ends on the way out`)
        assert.equal(captions().length, 1, `${said}: one caption, the page's last word`)
      })
    })
  }
})

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
      <MemoryRouter>
        <CharmStatusRow charm={{ name: "Desk charm" }} status={read} />
        <CharmNetwork read={read} refresh={refresh} />
      </MemoryRouter>
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
      <MemoryRouter>
        <CharmStatusRow charm={{ name: "Desk charm" }} status={read} />
        <CharmNetwork api={api} read={read} refresh={refresh} />
      </MemoryRouter>
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

/** The switch itself: one per row, and the only one this component draws. */
const voiceSwitch = () => find('[role="switch"]')

/**
 * The switch beside Sync: the reader's pick of the route the charm's turns take. It is kept on this
 * phone and handed over by the next sync, so moving it opens no radio and writes nothing to the charm.
 */
test("the voice switch is https by default, and its off position says what http needs", async () => {
  await mount(<CharmVoiceScheme scheme="https" onChange={() => {}} />, async () => {
    await settle()
    assert.ok(text().includes("Voice over https"), "the row names the setting")
    assert.ok(text().includes("clock"), "https says what it needs of the charm")
    assert.ok(voiceSwitch()?.hasAttribute("data-checked"), "https is where it sits by default")
  })

  await mount(<CharmVoiceScheme scheme="http" onChange={() => {}} />, async () => {
    await settle()
    assert.ok(text().includes("tailnet"), "the other position says what it needs of the tailnet")
    assert.ok(!text().includes("clock"), "and claims no clock it will not use")
    assert.ok(voiceSwitch()?.hasAttribute("data-unchecked"), "and the switch sits off")
  })
})

test("moving the voice switch keeps the pick", async () => {
  const picks: CharmScheme[] = []
  await mount(
    <CharmVoiceScheme scheme="https" onChange={(next) => picks.push(next)} />,
    async () => {
      await settle()
      await click(voiceSwitch())
      assert.deepEqual(picks, ["http"], "off is the tailnet's plain http")
    },
  )
})

test("a charm mid-sync cannot have its scheme moved under the sync", async () => {
  await mount(<CharmVoiceScheme scheme="https" disabled onChange={() => {}} />, async () => {
    await settle()
    assert.ok(voiceSwitch()?.hasAttribute("data-disabled"), "the switch is shut while the page is busy")
  })
})

test("the charm's own answer about its voice is drawn as the charm said it", async () => {
  await mount(<CharmVoiceHeld address="https://h.example/api/plugins/gots" />, async () => {
    await settle()
    assert.ok(text().includes("Your charm holds"), "the row names whose answer it is")
    assert.ok(text().includes("https://h.example/api"), "the address the charm says it kept")
  })

  await mount(<CharmVoiceHeld address={null} />, async () => {
    await settle()
    assert.ok(text().includes("Nothing yet"), "a charm holding none says so")
  })

  // A firmware older than the ask cannot answer at all, and that is not the same as an empty answer.
  await mount(<CharmVoiceHeld failed />, async () => {
    await settle()
    assert.ok(text().includes("can't say"), "the ask that did not land is the row's own word")
  })
})

/**
 * The update screen's Done hands this page a sync through the URL: `?sync=1` says a build just
 * landed and the bots, the pet and the voice hand-over are owed again. The shell cannot be mounted
 * in the web build, so this probe is the hook itself: the address it leaves, read through the kit's
 * own probe, and a redraw button — and nothing else that could sync.
 */
function ReturnProbe({
  ready,
  busy,
  onSync,
}: {
  ready: boolean
  busy?: boolean
  onSync: () => void
}) {
  useReturnSync({ ready, busy, onSync })
  const [, redraw] = useState(0)
  return (
    <>
      <Nav />
      <button type="button" data-redraw onClick={() => redraw((n) => n + 1)}>
        redraw
      </button>
    </>
  )
}

test("Sync your bots lands on /settings/charm?sync=1, syncs once, and leaves the URL without the parameter", async () => {
  /** The probe at `entry`, its `ready` flipped once it has drawn: the page's charm and bots reads. */
  async function returned(entry: string) {
    const syncs: number[] = []
    let ready: (() => void) | undefined
    function Probe() {
      const [on, setOn] = useState(false)
      ready = () => setOn(true)
      return <ReturnProbe ready={on} onSync={() => syncs.push(1)} />
    }
    let afterReady = 0
    let where = ""
    await mount(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/settings/charm" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
      async () => {
        await settle()
        assert.equal(syncs.length, 0, "nothing runs before the page is ready")
        await act(async () => ready?.())
        await settle()
        afterReady = syncs.length
        where = nav()
        await click(find("[data-redraw]"))
        await settle()
      },
    )
    return { afterReady, afterRedraw: syncs.length, where }
  }

  const asked = await returned("/settings/charm?sync=1")
  assert.equal(asked.afterReady, 1, "the parameter runs the sync once the page is ready")
  assert.equal(asked.afterRedraw, 1, "a redraw syncs nothing more: the parameter is gone")
  assert.equal(asked.where, "REPLACE:/settings/charm", "and the URL no longer carries it")

  // The page's own address may carry something else: the return clears the parameter it read and
  // leaves the rest of the URL as it found it.
  const kept = await returned("/settings/charm?sync=1&keep=1")
  assert.equal(kept.afterReady, 1, "the parameter still runs the sync")
  assert.equal(kept.where, "REPLACE:/settings/charm?keep=1", "and only the sync parameter goes")

  const plain = await returned("/settings/charm")
  assert.equal(plain.afterReady, 0, "no parameter, no sync")
})

/**
 * The page's own send is not doubled by a return: a `?sync=1` that arrives while the page is busy
 * waits, with the parameter still in the URL, for the moment the send it would have doubled is over
 * — rather than being dropped and promising a sync nobody runs.
 */
test("a returned sync waits for the page to be free instead of landing in its own send", async () => {
  const syncs: number[] = []
  let ready: (() => void) | undefined
  let free: ((busy: boolean) => void) | undefined
  function Probe() {
    const [isReady, setReady] = useState(false)
    const [busy, setBusyState] = useState(true)
    ready = () => setReady(true)
    free = setBusyState
    return <ReturnProbe ready={isReady} busy={busy} onSync={() => syncs.push(1)} />
  }
  await mount(
    <MemoryRouter initialEntries={["/settings/charm?sync=1"]}>
      <Routes>
        <Route path="/settings/charm" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
    async () => {
      await act(async () => ready?.())
      await settle()
      assert.equal(syncs.length, 0, "a page already sending takes no second send")
      assert.equal(nav(), "POP:/settings/charm?sync=1", "and keeps the parameter for when it can")

      await act(async () => free?.(false))
      await settle()
      assert.equal(syncs.length, 1, "the sync runs once the page is free")
      assert.equal(nav(), "REPLACE:/settings/charm", "and the parameter goes with it")
    },
  )
})
