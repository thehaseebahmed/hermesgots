/**
 * Settings → Charm on the web: there is no radio to reach a Gots Charm with outside the Android
 * app, so the menu offers no row, and the section, reached by its address, says where to pair one.
 * The phone's own Network section is drawn here too, over a stand-in for the radio: what a charm's
 * answer reads as, and that a passphrase is never drawn back. The send flow's assertions moved
 * with the flow itself — `test-charm-update.tsx` holds them, beside the screen that runs them.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { type ComponentProps, act } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import {
  CharmNetwork,
  CharmVoiceHeld,
  CharmVoiceScheme,
  type CharmNetworkApi,
} from "@/components/settings/charm"
import { useCharmReport } from "@/lib/charm"
import { CharmLinkState, CharmUpdateState } from "@/lib/charm-protocol"
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

const PUBLISHED = { version: "0.2.0", size: 4, sha256: "cd".repeat(32) }

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
