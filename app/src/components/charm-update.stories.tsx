/**
 * Charm Settings' update screen, at the three moments a reader meets it: the offer of the published
 * build, a download on its way, and a failure that marks the step it stopped at and points at the
 * cable. The screen takes the charm as a stand-in `api`, so no story here drives a radio; it reads
 * the release from the bot's host rather than taking it as a prop, so this file answers that host's
 * two routes itself — the plugin's feature list and the tag's own record — and hands every other
 * request to the browser's own `fetch`, exactly as it would have gone.
 *
 * The mode is the toolbar's (`preview.tsx` toggles `dark` on the document) and the width the
 * viewport's; the frame is a phone's measure, since the screen is a phone's.
 */
import type { Meta, StoryObj } from "@storybook/react-vite"
import { type ReactNode, useRef } from "react"
import { MemoryRouter, Route, Routes } from "react-router"

import { CharmUpdateScreen, type CharmUpdateApi } from "@/components/charm-update"
import { resetCharmUpdateWalk, setWalk } from "@/lib/charm-update-walk"
import { FIRMWARE_NOT_BACK, FIRMWARE_SENT } from "@/lib/charm-words"
import type { PairedCharm } from "@/lib/charm"
import { CharmLinkState, CharmUpdateState } from "@/lib/charm-protocol"
import type { CharmFirmware } from "@/lib/hermes"

const meta = { title: "UI/Charm update" } satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** One walk's state, as a story seeds it: the shapes `setWalk` takes, and nothing the screen owns. */
type Seeded = Parameters<typeof setWalk>[0]

/** The release the stand-in host publishes: a megabyte and a half, with notes and a build date. */
const PUBLISHED: CharmFirmware = {
  version: "0.2.1",
  size: 1_572_864,
  sha256: "cd".repeat(32),
  notes: "The pet blinks again, and the clock keeps time.",
  built: "2026-03-03T09:30:00Z",
}

/** The browser's own `fetch`, for every request that is not the two routes below. */
const browserFetch = globalThis.fetch.bind(globalThis)

/** The bot whose host publishes the firmware, as a connection names itself. */
const HOST = { baseUrl: "https://bots.example/api", apiKey: "story" }

/** The charm this phone paired: the address the door is picked from, and the build it runs. */
const CHARM: PairedCharm = {
  deviceId: "charm-1",
  name: "Desk charm",
  talk: "https://bots.example/api/plugins/gots",
  voice: "https",
  wifi: { ssid: "Home", saved: true },
  tailnet: true,
}

const answered = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })

// Installed once for this file's stories: the plugin's own two answers, and every other request
// left to the browser.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input))
  if (url.pathname.endsWith("/plugins/gots/info"))
    return answered({ name: "gots", version: "0.43.0", features: ["charm_firmware"] })
  if (url.pathname.endsWith("/charm/firmware")) return answered(PUBLISHED)
  return browserFetch(input, init)
}) as typeof fetch

/** The charm's own answers, as the phone's radio would give them: no radio is asked here. */
const standIn = (percent: number): CharmUpdateApi => ({
  version: async () => "0.2.0",
  network: async () => ({
    wifi: { state: CharmLinkState.Online, reason: 0, ip: "192.168.1.20", ssid: "Home" },
    tailnet: { state: CharmLinkState.Off, ip: "" },
  }),
  battery: async () => ({ percent, charging: false }),
  updateStatus: async () => ({ state: CharmUpdateState.Idle, percent: 0, reason: 0 }),
  update: async () => {},
  upload: async () => ({ sent: 0, total: 0, percent: 0 }),
})

/**
 * The shared walk, seeded before the screen draws it — a story has no send to run — and reset first,
 * since it outlives a screen and the story before this one.
 */
function Seeded({ walk, children }: { walk: Seeded; children: ReactNode }) {
  const seeded = useRef(false)
  if (!seeded.current) {
    seeded.current = true
    resetCharmUpdateWalk()
    setWalk(walk)
  }
  return <>{children}</>
}

/** The screen as its route mounts it, in a phone's own frame. */
function Screen({ walk }: { walk: Seeded }) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <Seeded walk={walk}>
        <MemoryRouter initialEntries={["/settings/charm-firmware"]}>
          <Routes>
            <Route
              path="/settings/charm-firmware"
              element={<CharmUpdateScreen api={standIn(38)} profile={HOST} charm={CHARM} />}
            />
          </Routes>
        </MemoryRouter>
      </Seeded>
    </div>
  )
}

/** Nothing running: the offer of 0.2.1, with the charge the gate reads and both doors open. */
export const Offer: Story = {
  render: () => <Screen walk={{}} />,
}

/** The transfer on its way: the steps walked so far, each with the bar it reports. */
export const DownloadRunning: Story = {
  render: () => (
    <Screen
      walk={{
        running: true,
        title: "Updating to 0.2.1",
        steps: [
          { name: "download", subtitle: "72% of 1.5 MB", percent: 72 },
          { name: "transfer", percent: 41 },
        ],
      }}
    />
  ),
}

/** A failure at the transfer: the step it stopped at is marked, and the cable is offered beside it. */
export const Failed: Story = {
  render: () => (
    <Screen
      walk={{
        running: false,
        title: "Updating to 0.2.1",
        steps: [
          { name: "download", subtitle: "100% of 1.5 MB", percent: 100 },
          { name: "transfer", subtitle: FIRMWARE_SENT, percent: 41 },
        ],
        end: { kind: "failed", said: FIRMWARE_NOT_BACK, step: "transfer" },
      }}
    />
  ),
}
