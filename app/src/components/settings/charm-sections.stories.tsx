/**
 * The charm's own page, drawn from fixtures alone: the sections take every fact they draw as a
 * prop, so a story needs no radio and no store — a paired charm, its report, what the page read of
 * the firmware, two bots and the labels this phone calls them. Two stories, because the one thing a reader
 * checks at a glance is whether the Firmware row offers a build: tagged **Update** when it does,
 * and untagged when the charm is already on it.
 *
 * The mode comes from the toolbar's own switch (`preview.tsx` toggles `dark` on the document), and
 * the width from the viewport — this page is a phone's, so the frame is one phone's measure.
 */
import type { Meta, StoryObj } from "@storybook/react-vite"
import { MemoryRouter } from "react-router"

import { CharmSections } from "@/components/settings/charm"
import type { CharmFirmwareFacts, PairedCharm } from "@/lib/charm"
import { CharmLinkState, CharmUpdateState, type CharmNetworkReport } from "@/lib/charm-protocol"
import type { Profile } from "@/lib/db"
import { bot } from "@/stories/device"

const meta = { title: "UI/Charm page" } satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** The charm this phone paired, with the charge and the network it last gave. */
const CHARM: PairedCharm = {
  deviceId: "charm-1",
  name: "Desk charm",
  syncedAt: Date.now() - 60_000,
  syncedBots: 2,
  pet: { enabled: true, botId: "bot-pocket" },
  wifi: { ssid: "Home", saved: true },
  tailnet: true,
  talk: "https://bots.example/api/plugins/gots",
  voice: "https",
  wake: { doubleTap: true, quietSeconds: 15 },
  battery: { percent: 64, charging: false, at: Date.now() - 120_000 },
}

/** The charm's own answer about its two links: up on the network it joined, its tunnel down. */
const ONLINE: CharmNetworkReport = {
  wifi: { state: CharmLinkState.Online, reason: 0, ip: "192.168.1.20", ssid: "Home" },
  tailnet: { state: CharmLinkState.Off, ip: "" },
}

/** Two bots the charm can be sent, so the pet's row has a name to say. */
const BOTS: Profile[] = [
  bot({ id: "bot-pocket", name: "Pocket", botId: "bot-pocket" }),
  bot({ id: "bot-desk", name: "Desk", botId: "bot-desk" }),
]

/** What this phone calls each bot, against every other one. */
const LABELS = new Map([
  ["bot-pocket", "Pocket"],
  ["bot-desk", "Desk"],
])

/** The firmware's four facts: the build the charm runs, and the one its host publishes. */
const firmwareFacts = (published: string, running = "0.2.0"): CharmFirmwareFacts => ({
  running: { state: "says", version: running },
  published,
  answered: true,
  checkSaid: null,
  update: { state: "read", value: { state: CharmUpdateState.Idle, percent: 0, reason: 0 } },
  read: async () => undefined,
})

const nothing = () => {}

/** The page as the phone draws it, its whole frame a phone's own measure. */
function Page({ firmware }: { firmware: CharmFirmwareFacts }) {
  return (
    <MemoryRouter>
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <CharmSections
          charm={CHARM}
          report={{ read: { state: "read", value: ONLINE }, refresh: async () => {} }}
          firmware={firmware}
          sources={BOTS}
          botsRead
          labels={LABELS}
          busy={null}
          progress={null}
          wake={{ doubleTap: true, quietSeconds: 15 }}
          scheme="https"
          held="https://bots.example/api/plugins/gots"
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
        />
      </div>
    </MemoryRouter>
  )
}

/** A build ahead of the charm's: the Device card's Firmware row carries the **Update** tag. */
export const OffersAnUpdate: Story = {
  render: () => <Page firmware={firmwareFacts("0.2.1", "0.2.0")} />,
}

/** The charm already on what is published: the same row, and nothing to offer. */
export const UpToDate: Story = {
  render: () => <Page firmware={firmwareFacts("0.2.0", "0.2.0")} />,
}
