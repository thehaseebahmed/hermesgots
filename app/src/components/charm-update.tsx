import { useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useSearchParams } from "react-router"
import { FileUpIcon } from "lucide-react"

import { Caption, Group, RowText } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import {
  charmFirmwareVersion,
  charmNetwork,
  charmUpdateStatus,
  charmVoice,
  hostForActiveBot,
  PUBLISHED_FIRMWARE,
  startCharmFirmwareFetch,
  uploadCharmFirmware,
  usePairedCharm,
  type CharmScheme,
  type PairedCharm,
} from "@/lib/charm"
import { FirmwareRefused, versionAfterReboot, type FirmwareProgress } from "@/lib/charm-firmware"
import {
  CHARM_SLOT_BYTES,
  CharmCode,
  CharmUpdateState,
  hexOf,
  type CharmNetworkReport,
  type CharmUpdateStatus,
} from "@/lib/charm-protocol"
import {
  downloadWords,
  fetchWords,
  FILE_TOO_BIG,
  firmwareDoneWords,
  FIRMWARE_CABLE,
  FIRMWARE_NOT_BACK,
  FIRMWARE_NOT_PUBLISHED,
  FIRMWARE_NOT_STARTED,
  FIRMWARE_SENT,
  PUBLISHED_CHANGED,
} from "@/lib/charm-words"
import { firmwareDoor, firmwareFetchUrl } from "@/lib/firmware-fetch"
import { getActiveProfile } from "@/lib/db"
import {
  getCharmFirmwareFetchToken,
  getCharmFirmwareImage,
  type CharmFirmware,
} from "@/lib/hermes"
import { useHostRecord } from "@/lib/host-record"
import type { PluginServer } from "@/lib/features"

const message = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Something went wrong"

/** The SHA-256 of bytes this phone holds, as the lowercase hex the link takes. */
const sha256Of = async (image: Uint8Array) =>
  hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", image as unknown as BufferSource)))

/**
 * What the update screen needs of the charm, as the phone's radio answers it. A page mounted in a
 * test is handed a stand-in, as the network section's is. The screen asks nothing on a timer of its
 * own while it drives a send — the upload reports where it has got to, and the reboot window is a
 * fixed number of asks — except the one walk it cannot drive: a charm fetching the image itself is
 * followed on the poll below, at the pace the settings row watches a download at.
 */
export interface CharmUpdateApi {
  /** Which build the charm runs; null for a firmware too old to have the ask. */
  version(): Promise<string | null>
  /** The charm's report of its two links — the ask the settings page already makes. */
  network(): Promise<CharmNetworkReport>
  /** Where the charm's own fetch has got to, as the `UpdateStatus` ask answers it. */
  updateStatus(): Promise<CharmUpdateStatus>
  /** Hands the charm the image to fetch itself: the URL and the SHA-256 it must hash to. */
  update(url: string, sha256Hex: string): Promise<void>
  /** One image over the charm's link, drawing where the phone has got to. */
  upload(
    image: Uint8Array,
    sha256Hex: string,
    onProgress?: (progress: FirmwareProgress) => void,
  ): Promise<FirmwareProgress>
}

/** The one implementation: the phone's own functions. */
const LIVE: CharmUpdateApi = {
  version: charmFirmwareVersion,
  network: charmNetwork,
  updateStatus: charmUpdateStatus,
  update: startCharmFirmwareFetch,
  upload: uploadCharmFirmware,
}

/**
 * One image's way onto the charm: the bytes this phone sends over the link, or the door the charm
 * walks itself — the URL this phone hands it, and the hash the bytes it fetches must carry.
 */
type FirmwareHand =
  | { kind: "transfer"; image: Uint8Array; sha256Hex: string }
  | { kind: "fetch"; url: string; sha256Hex: string; scheme: CharmScheme }

/** How often the charm's own percent is asked while it fetches: the settings row's watching pace. */
const FETCH_POLL_MS = 2_000

/**
 * How many asks in a row may say nothing is running before the walk calls the fetch one that never
 * started. An `Idle` answer right after the write is the fetch arming itself; a few together are a
 * charm that took the address and started nothing, which is a failure to say rather than a wait
 * without an end.
 */
const FETCH_IDLE_TRIES = 3

/**
 * The charm's own percent, followed to the end of its fetch. `Ready` is the slot written and the
 * reboot a moment away; `Failed` is the charm's own reason, in the same words an upload's refusal
 * wears — so the failure path is the same either way.
 */
async function watchCharmFetch(
  ask: () => Promise<CharmUpdateStatus>,
  onProgress?: (update: CharmUpdateStatus) => void,
): Promise<void> {
  let idles = 0
  for (;;) {
    const update = await ask()
    if (update.state === CharmUpdateState.Failed)
      throw new FirmwareRefused(CharmCode.Ok, update.reason)
    if (update.state === CharmUpdateState.Ready) return
    if (update.state === CharmUpdateState.Downloading) idles = 0
    else if ((idles += 1) >= FETCH_IDLE_TRIES) throw new Error(FIRMWARE_NOT_STARTED)
    onProgress?.(update)
    await new Promise((done) => setTimeout(done, FETCH_POLL_MS))
  }
}

/** One step of the walk, as the screen holds it: its line, and its bar while it moves. */
interface StepView {
  name: "download" | "transfer" | "restart"
  subtitle?: string
  percent?: number
}

/** What each step is called, in the reader's words and the order they walk in. */
const STEP_TITLES: Record<StepView["name"], string> = {
  download: "Downloading",
  transfer: "Transferring",
  restart: "Restarting",
}

/**
 * Settings → Charm's update screen: the steps a firmware update walks, in the reader's words —
 * Downloading, whether the phone fetches the image or the charm fetches it itself through a door it
 * holds, Transferring with the bar the upload reports, Restarting over the reboot window, and the
 * end: the version the charm came back on, or the failure with its reason and what to do — try
 * again, and, when the charm keeps cancelling, flash it by cable, which always works. The Firmware
 * row's Update button opens it straight into the published image; its picker opens it ready for a
 * file, which walks the same steps minus the download — and always over the link, since a file the
 * phone holds has no door to walk. The reader can step back at any point — the send is driven by
 * its own promise, not by the screen, so leaving changes nothing about what the charm takes.
 */
export function CharmUpdateScreen({
  api = LIVE,
  profile: given,
  charm: givenCharm,
}: {
  /** The charm, or a stand-in under test. */
  api?: CharmUpdateApi
  /** The bot whose host publishes the firmware; the active bot when none is handed in. */
  profile?: PluginServer
  /**
   * The paired charm — its voice scheme and the address the hand-over kept are the two facts a door
   * is picked from. The phone's own record when none is handed in, as a test hands one of its own.
   */
  charm?: PairedCharm | null
}) {
  const active = useLiveQuery(getActiveProfile, [])
  const profile = given ?? active
  const paired = usePairedCharm()
  const charm = givenCharm ?? paired
  const [params] = useSearchParams()
  const pickMode = params.get("file") === "1"

  const firmware = useHostRecord(profile, PUBLISHED_FIRMWARE, undefined)
  const seen = firmware.value
  const published = seen?.state === "published" ? seen.firmware : undefined
  const checkSaid = seen?.state === "refused" ? seen.said : null

  const [steps, setSteps] = useState<StepView[]>([])
  const [title, setTitle] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [end, setEnd] = useState<
    { kind: "done"; version: string } | { kind: "failed"; said: string } | null
  >(null)
  const [busy, setBusy] = useState(false)
  /** `busy` is a render behind, so a double tap in one tick would both reach the radio. */
  const sending = useRef(false)
  /** The last hand the charm was given, in the words it went under: what a failure's Try again re-runs. */
  const again = useRef<{
    hand: () => Promise<FirmwareHand>
    title: string
  } | null>(null)
  const started = useRef(false)
  const file = useRef<HTMLInputElement | null>(null)

  /** One step drawn or moved: a step appears where it starts and stays for the rest of the walk. */
  const show = (name: StepView["name"], patch: Partial<StepView>) =>
    setSteps((now) => {
      const at = now.findIndex((step) => step.name === name)
      if (at === -1) return [...now, { name, ...patch }]
      const next = [...now]
      next[at] = { ...next[at], ...patch }
      return next
    })

  /**
   * One image through the whole walk, however it goes on. `hand` is where the image and its hash
   * come from — the host's package streamed to this phone, a file the reader picked, or a door the
   * charm walks itself — and it can draw a Downloading step of its own on the way in.
   */
  const send = async (hand: () => Promise<FirmwareHand>, heading: string) => {
    if (sending.current) return
    again.current = { hand, title: heading }
    sending.current = true
    setBusy(true)
    setEnd(null)
    setNote(null)
    setTitle(heading)
    setSteps([])
    try {
      // The build the charm runs now, read before anything goes: the answer the reboot's read is
      // compared against, so a charm that could not say before is one whose any answer is the change.
      const was = await api.version().catch(() => null)
      const next = await hand()
      if (next.kind === "fetch") {
        // The charm fetches the image itself: this phone's whole part is the one ask that hands it
        // the address, and the charm's own percent then feeds the bar — the poll the settings row
        // runs, at the row's own pace — until the charm says its slot is ready.
        show("download", { subtitle: fetchWords(next.scheme), percent: 0 })
        await api.update(next.url, next.sha256Hex)
        await watchCharmFetch(
          () => api.updateStatus(),
          (update) => show("download", { percent: update.percent }),
        )
      } else {
        show("transfer", { percent: 0 })
        await api.upload(next.image, next.sha256Hex, (progress) => {
          const percent =
            progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0
          show("transfer", { percent })
        })
        show("transfer", { percent: 100 })
      }
      // The end is a yes only once the slot is bootable: the charm reboots a moment later, and the
      // window is the phone's own asks for the version the new build answers with.
      show("restart", { subtitle: FIRMWARE_SENT })
      const { changed, version } = await versionAfterReboot(() => api.version(), was)
      if (changed && version !== null) {
        setEnd({ kind: "done", version })
        return
      }
      // The charm never answered on the new build: what is published is read again too, since a
      // merge may have moved the tag while this one was being tried.
      await firmware.reload()
      setEnd({ kind: "failed", said: FIRMWARE_NOT_BACK })
    } catch (error) {
      setEnd({ kind: "failed", said: message(error) })
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  /**
   * The published image, however the charm takes it. The door is asked first — the charm's own
   * report of its links, against the address the voice hand-over kept — and only a door that is
   * open mints a token and hands the charm the address, so the screen never offers a walk the charm
   * cannot make; a report that could not be read is no door either, since an unread fact is not a
   * fact. No door open is the transfer: the image streamed to this phone, checked against the
   * version this screen read, so a package that moved between the two reads is refused here rather
   * than by the charm after the whole image — unless the re-read names these bytes, when they are
   * exactly the image to send.
   */
  const runPublished = (record: CharmFirmware) =>
    send(async () => {
      const scheme = charmVoice(charm)
      const address = typeof charm?.talk === "string" ? charm.talk : undefined
      const report = await api.network().catch(() => null)
      if (report && firmwareDoor(report, scheme, address) === "fetch" && address) {
        // The one answer in which this phone ever sees the token: it rides the URL it builds, and
        // the image's bytes stay pinned by the SHA-256 of the record — the charm checks it before
        // it writes the slot, so a tag that moved is refused by the hash, not trusted by the URL.
        const token = await getCharmFirmwareFetchToken(hostForActiveBot(profile))
        return {
          kind: "fetch",
          url: firmwareFetchUrl(address, token),
          sha256Hex: record.sha256,
          scheme,
        }
      }
      const image = await getCharmFirmwareImage(hostForActiveBot(profile), (progress) =>
        show("download", {
          subtitle: downloadWords(progress),
          percent:
            progress.total > 0 ? Math.round((progress.received / progress.total) * 100) : undefined,
        }),
      )
      show("download", {
        subtitle: downloadWords({ received: image.length, total: image.length }),
        percent: 100,
      })
      const sha256Hex = await sha256Of(image)
      if (image.length === record.size && sha256Hex === record.sha256)
        return { kind: "transfer", image, sha256Hex }
      const fresh = await firmware.reload()
      const again = fresh?.state === "published" ? fresh.firmware : undefined
      if (again && again.size === image.length && again.sha256 === sha256Hex)
        return { kind: "transfer", image, sha256Hex }
      throw new Error(PUBLISHED_CHANGED)
    }, `Updating to ${record.version}`)

  /**
   * A file from the phone: its bytes, and the SHA-256 computed here over them — that hash is the
   * whole trust anchor, so what the charm checks is what this phone read. A file too big for a slot
   * is refused before a byte goes over the link: the slot the host publishes where it names one,
   * this phone's own constant otherwise. A file has no door to walk, whatever the charm's links: it
   * is this phone's bytes, so this phone sends them.
   */
  const sendFile = (chosen: File) => {
    if (chosen.size > (published?.slot ?? CHARM_SLOT_BYTES)) {
      setNote(FILE_TOO_BIG)
      return
    }
    void send(async () => {
      const image = new Uint8Array(await chosen.arrayBuffer())
      return { kind: "transfer", image, sha256Hex: await sha256Of(image) }
    }, `Sending ${chosen.name}`)
  }

  // The published walk starts on its own once the host's own read is over: the bytes are checked
  // against the version that read named, and a cached copy is not this visit's answer. A screen
  // opened for a file waits for the reader to pick one.
  useEffect(() => {
    if (pickMode || started.current || !firmware.settled) return
    started.current = true
    if (published) void runPublished(published)
  }, [pickMode, firmware.settled, published])

  /** What a failure's way forward re-runs: the same hand — the bytes read again, or the door asked again. */
  const retry = () => {
    const last = again.current
    if (sending.current || !last) return
    void send(last.hand, last.title)
  }

  return (
    <>
      {title && <Caption>{title}</Caption>}
      {steps.length > 0 && (
        <Group>
          {steps.map((step) => (
            <StepRow
              key={step.name}
              title={STEP_TITLES[step.name]}
              subtitle={step.subtitle}
              percent={step.percent}
            />
          ))}
        </Group>
      )}
      {end?.kind === "done" && (
        <Group>
          <div className="bg-card px-5 py-3">
            <RowText title="Done" subtitle={firmwareDoneWords(end.version)} />
          </div>
        </Group>
      )}
      {end?.kind === "failed" && (
        <Group>
          <div className="flex flex-col gap-1 bg-card px-5 py-3">
            <p className="text-sm">{end.said}</p>
            <p className="text-[13px] text-muted-foreground">{FIRMWARE_CABLE}</p>
          </div>
          <div className="bg-card px-5 py-3">
            <Button id="charm-update-retry" type="button" disabled={busy} onClick={retry}>
              Try again
            </Button>
          </div>
        </Group>
      )}
      {note && <Caption>{note}</Caption>}
      {pickMode && <PickGroup disabled={busy} onPick={sendFile} fileRef={file} />}
      {!pickMode && firmware.settled && !published && !end && !busy && (
        <>
          {checkSaid && <Caption>{checkSaid}</Caption>}
          <Caption>{FIRMWARE_NOT_PUBLISHED}</Caption>
          <PickGroup disabled={busy} onPick={sendFile} fileRef={file} />
        </>
      )}
    </>
  )
}

/** One step as it walks: its name, the line under it, and its bar while it has one. */
function StepRow({
  title,
  subtitle,
  percent,
}: {
  title: string
  subtitle?: string
  percent?: number
}) {
  return (
    <div className="flex flex-col gap-2 bg-card px-5 py-3">
      <RowText title={title} subtitle={subtitle} />
      {percent !== undefined && <Bar value={percent} />}
    </div>
  )
}

/**
 * One step's bar, at the whole percent the step's own count says. The value rides the element as
 * `aria-valuenow`, so what the reader sees move is the same number everything else reads.
 */
function Bar({ value }: { value: number }) {
  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full rounded-full bg-primary duration-300 ease-out" style={{ width: `${value}%` }} />
    </div>
  )
}

/**
 * The reader's own way onto the walk: a file the phone already holds. A web file input is the
 * whole Android picker — the WebView opens the system's own — and it is cleared after each pick,
 * so a second try at a failed upload is exactly when picking the same file again works.
 */
function PickGroup({
  disabled,
  onPick,
  fileRef,
}: {
  disabled?: boolean
  onPick: (file: File) => void
  fileRef: { current: HTMLInputElement | null }
}) {
  return (
    <Group>
      <div className="bg-card px-5 py-3">
        <Button
          id="charm-update-choose"
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={() => fileRef.current?.click()}
        >
          <FileUpIcon />
          Choose a file…
        </Button>
        {/* A web file input is the whole Android picker: the WebView opens the system's own. */}
        <input
          ref={fileRef}
          id="charm-update-file"
          type="file"
          className="hidden"
          onChange={(event) => {
            const input = event.currentTarget
            const chosen = input.files?.[0]
            // Cleared so the same file picked again fires `change`: a second try at a failed
            // upload is exactly when a reader picks the file they just picked.
            input.value = ""
            if (chosen) onPick(chosen)
          }}
        />
      </div>
    </Group>
  )
}
