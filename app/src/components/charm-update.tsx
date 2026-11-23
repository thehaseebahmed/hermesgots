import { useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useSearchParams } from "react-router"
import { FileUpIcon } from "lucide-react"

import { Caption, Group, RowText } from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import {
  charmFirmwareVersion,
  hostForActiveBot,
  PUBLISHED_FIRMWARE,
  uploadCharmFirmware,
} from "@/lib/charm"
import { versionAfterReboot, type FirmwareProgress } from "@/lib/charm-firmware"
import { hexOf, CHARM_SLOT_BYTES } from "@/lib/charm-protocol"
import {
  downloadWords,
  FILE_TOO_BIG,
  firmwareDoneWords,
  FIRMWARE_CABLE,
  FIRMWARE_NOT_BACK,
  FIRMWARE_NOT_PUBLISHED,
  FIRMWARE_SENT,
  PUBLISHED_CHANGED,
} from "@/lib/charm-words"
import { getActiveProfile } from "@/lib/db"
import { getCharmFirmwareImage, type CharmFirmware } from "@/lib/hermes"
import { useHostRecord } from "@/lib/host-record"
import type { PluginServer } from "@/lib/features"

const message = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Something went wrong"

/** The SHA-256 of bytes this phone holds, as the lowercase hex the link takes. */
const sha256Of = async (image: Uint8Array) =>
  hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", image as unknown as BufferSource)))

/**
 * What the update screen needs of the charm, as the phone's radio answers it. A page mounted in a
 * test is handed a stand-in, as the network section's is; the screen asks nothing on a timer of its
 * own — the upload reports where it has got to, and the reboot window is a fixed number of asks.
 */
export interface CharmUpdateApi {
  /** Which build the charm runs; null for a firmware too old to have the ask. */
  version(): Promise<string | null>
  /** One image over the charm's link, drawing where the phone has got to. */
  upload(
    image: Uint8Array,
    sha256Hex: string,
    onProgress?: (progress: FirmwareProgress) => void,
  ): Promise<FirmwareProgress>
}

/** The one implementation: the phone's own functions. */
const LIVE: CharmUpdateApi = { version: charmFirmwareVersion, upload: uploadCharmFirmware }

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
 * Downloading while the phone fetches the image, Transferring with the bar the upload reports,
 * Restarting over the reboot window, and the end: the version the charm came back on, or the
 * failure with its reason and what to do — try again, and, when the charm keeps cancelling, flash
 * it by cable, which always works. The Firmware row's Update button opens it straight into the
 * published image; its picker opens it ready for a file, which walks the same steps minus the
 * download. The reader can step back at any point — the transfer is driven by its own promise,
 * not by the screen, so leaving changes nothing about what the charm takes.
 */
export function CharmUpdateScreen({
  api = LIVE,
  profile: given,
}: {
  /** The charm, or a stand-in under test. */
  api?: CharmUpdateApi
  /** The bot whose host publishes the firmware; the active bot when none is handed in. */
  profile?: PluginServer
}) {
  const active = useLiveQuery(getActiveProfile, [])
  const profile = given ?? active
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
  /** The last load that ran, in the words it ran under: what a failure's Try again re-runs. */
  const again = useRef<{
    load: () => Promise<{ image: Uint8Array; sha256Hex: string }>
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
   * One image through the whole walk, however the phone came by it. `load` is where the bytes and
   * the hash come from — the host's package, streamed, or a file the reader picked — and it can
   * draw a Downloading step of its own on the way in.
   */
  const send = async (
    load: () => Promise<{ image: Uint8Array; sha256Hex: string }>,
    heading: string,
  ) => {
    if (sending.current) return
    again.current = { load, title: heading }
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
      const { image, sha256Hex } = await load()
      show("transfer", { percent: 0 })
      await api.upload(image, sha256Hex, (progress) => {
        const percent =
          progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0
        show("transfer", { percent })
      })
      show("transfer", { percent: 100 })
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
   * The published image, checked against the version this screen read: the bytes and their hash are
   * what the link would send, so a package that moved between the two reads is refused here rather
   * than by the charm after the whole image — unless the re-read names these bytes, when they are
   * exactly the image to send.
   */
  const runPublished = (record: CharmFirmware) =>
    send(async () => {
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
        return { image, sha256Hex }
      const fresh = await firmware.reload()
      const again = fresh?.state === "published" ? fresh.firmware : undefined
      if (again && again.size === image.length && again.sha256 === sha256Hex)
        return { image, sha256Hex }
      throw new Error(PUBLISHED_CHANGED)
    }, `Updating to ${record.version}`)

  /**
   * A file from the phone: its bytes, and the SHA-256 computed here over them — that hash is the
   * whole trust anchor, so what the charm checks is what this phone read. A file too big for a slot
   * is refused before a byte goes over the link: the slot the host publishes where it names one,
   * this phone's own constant otherwise.
   */
  const sendFile = (chosen: File) => {
    if (chosen.size > (published?.slot ?? CHARM_SLOT_BYTES)) {
      setNote(FILE_TOO_BIG)
      return
    }
    void send(async () => {
      const image = new Uint8Array(await chosen.arrayBuffer())
      return { image, sha256Hex: await sha256Of(image) }
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

  /** What a failure's way forward re-runs: the same image, fetched or read again. */
  const retry = () => {
    const last = again.current
    if (sending.current || !last) return
    void send(last.load, last.title)
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
