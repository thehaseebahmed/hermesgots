import { useEffect, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useNavigate, useSearchParams } from "react-router"
import { CableIcon, ExternalLinkIcon, FileUpIcon, SparklesIcon } from "lucide-react"

import { useDeveloper } from "@/components/developer-only"
import {
  ActionRow,
  Caption,
  Group,
  LinkRow,
  PickSurface,
  RowText,
  rowClass,
  SheetRow,
  ValueRow,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import {
  charmFirmwareVersion,
  charmNetwork,
  charmUpdateStatus,
  charmVoice,
  hostForActiveBot,
  PUBLISHED_FIRMWARE,
  readCharmBattery,
  startCharmFirmwareFetch,
  uploadCharmFirmware,
  usePairedCharm,
  type PairedCharm,
} from "@/lib/charm"
import {
  FirmwareRefused,
  updateFailedRefusal,
  versionAfterReboot,
  type FirmwareProgress,
  type UploadOptions,
} from "@/lib/charm-firmware"
import {
  CHARM_SLOT_BYTES,
  CharmUpdateState,
  hexOf,
  type CharmBattery,
  type CharmNetworkReport,
  type CharmUpdateStatus,
} from "@/lib/charm-protocol"
import {
  batteryWords,
  builtWords,
  CABLE_TITLE,
  CABLE_WORDS,
  CHARM_LOG,
  chargeBlocks,
  CHARGE_FIRST,
  downloadWords,
  FETCH_FALLBACK,
  fetchWords,
  FILE_TOO_BIG,
  FIRMWARE_CAPTION,
  FIRMWARE_CHECKED,
  FIRMWARE_REPO,
  firmwareDoneWords,
  FIRMWARE_LEAVE,
  FIRMWARE_NOT_BACK,
  FIRMWARE_NOT_ENDED,
  FIRMWARE_NOT_PUBLISHED,
  FIRMWARE_SENT,
  KEEP_CLOSE,
  NOTES_TITLE,
  notesSizeWords,
  offerLinkWords,
  PUBLISHED_CHANGED,
  REPO_ROW,
  STEP_STOPPED,
} from "@/lib/charm-words"
import { firmwareDoor, firmwareFetchUrl } from "@/lib/firmware-fetch"
import { getActiveProfile } from "@/lib/db"
import { openExternal } from "@/lib/native"
import { quietly } from "@/lib/report"
import { CHARM_POLL_MS } from "@/lib/freshness"
import {
  getCharmFirmware,
  getCharmFirmwareFetch,
  getCharmFirmwareImage,
  type CharmFirmware,
} from "@/lib/hermes"
import { useHostRecord } from "@/lib/host-record"
import type { PluginServer } from "@/lib/features"
import { compareVersions } from "@/lib/version-compare"
import {
  setWalk,
  useWalk,
  walk,
  type FirmwareHand,
  type StepView,
} from "@/lib/charm-update-walk"
import { spoken } from "@/lib/words"
import { cn } from "@/lib/utils"

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
  /**
   * The charm's charge, asked as the offer draws and again as a door is pressed: what the gate
   * reads. No age — a reading taken for this visit, not the record the settings page keeps.
   */
  battery(): Promise<CharmBattery | undefined>
  /** Where the charm's own fetch has got to, as the `UpdateStatus` ask answers it. */
  updateStatus(): Promise<CharmUpdateStatus>
  /** Hands the charm the image to fetch itself: the URL and the SHA-256 it must hash to. */
  update(url: string, sha256Hex: string): Promise<void>
  /**
   * One image over the charm's link, drawing where the phone has got to; `options` carries the
   * pace the charm's own build asks for.
   */
  upload(
    image: Uint8Array,
    sha256Hex: string,
    onProgress?: (progress: FirmwareProgress) => void,
    options?: UploadOptions,
  ): Promise<FirmwareProgress>
}

/** The one implementation: the phone's own functions. */
const LIVE: CharmUpdateApi = {
  version: charmFirmwareVersion,
  network: charmNetwork,
  battery: readCharmBattery,
  updateStatus: charmUpdateStatus,
  update: startCharmFirmwareFetch,
  upload: uploadCharmFirmware,
}

/**
 * The walk's own bound: the fetch token's short life (`TTL_MS` in `plugin/fetch_tokens.py`), past
 * which the door the charm was handed is shut anyway. A charm that says Downloading forever is said
 * so in the walk's own words rather than waited on without an end.
 */
const FETCH_WALK_MS = 600_000

/**
 * The first build whose Busy notice names the fill it waits at (the plan's step 2). Against it the
 * paced gap buys nothing — the notice re-anchors the send wherever the charm has got to — while it
 * costs the image its idle minutes (five for a megabyte and a half); anything older, or a
 * charm that cannot say, keeps the paced fallback, the only defence a notice that names no fill has.
 */
const SPEAKS_FILL = "0.2.1-beta"

/** The upload's own knob, from the build the charm runs: no wait for one that names its fill. */
const uploadPace = (version: string | null): UploadOptions =>
  version !== null && (compareVersions(version, SPEAKS_FILL) ?? -1) >= 0
    ? { pace: async () => {} }
    : {}

/**
 * The charm's own percent, followed to the end of its fetch. Each answer's percent is drawn before
 * its state is read — the one answer that carries percent 100 is the slot written and the reboot a
 * moment away, and it is still the bar's own last word; `Failed` is the charm's own reason, in the
 * same words an upload's refusal wears — so the failure path is the same either way.
 */
async function watchCharmFetch(
  ask: () => Promise<CharmUpdateStatus>,
  onProgress?: (update: CharmUpdateStatus) => void,
): Promise<void> {
  const until = Date.now() + FETCH_WALK_MS
  for (;;) {
    const update = await ask()
    if (update.state === CharmUpdateState.Failed) throw updateFailedRefusal(update)
    onProgress?.(update)
    if (update.state === CharmUpdateState.Ready) return
    if (Date.now() > until) throw new Error(FIRMWARE_NOT_ENDED)
    await new Promise((done) => setTimeout(done, CHARM_POLL_MS))
  }
}

/** What each step is called, in the reader's words and the order they walk in. */
const STEP_TITLES: Record<StepView["name"], string> = {
  download: "Downloading",
  transfer: "Transferring",
  restart: "Restarting",
}

/**
 * Settings → Charm's update screen: the offer of the published build, the steps a send walks, and
 * the end it reads back — a sync owed, or the failure with its marked step and the cable path.
 * Nothing is read, minted or written before the reader taps, and the send is driven by its own
 * promise, so stepping back leaves the walk running rather than ending it.
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
  const developer = useDeveloper()
  const profile = given ?? active
  const paired = usePairedCharm()
  const charm = givenCharm ?? paired
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const pickMode = params.get("file") === "1"

  const firmware = useHostRecord(profile, PUBLISHED_FIRMWARE, undefined)
  const seen = firmware.value
  const published = seen?.state === "published" ? seen.firmware : undefined
  const checkSaid = seen?.state === "refused" ? seen.said : null

  const { running: busy, steps, title, note, end } = useWalk()
  const file = useRef<HTMLInputElement | null>(null)

  /**
   * One step drawn or moved: a step appears where it starts and stays for the rest of the walk. The
   * list is append-only, so the step a failure stopped at is its last one — no counter beside it
   * has to be kept in step with what the reader sees.
   */
  const show = (name: StepView["name"], patch: Partial<StepView>) => {
    const at = walk.steps.findIndex((step) => step.name === name)
    setWalk({
      steps:
        at === -1
          ? [...walk.steps, { name, ...patch }]
          : walk.steps.map((step, i) => (i === at ? { ...step, ...patch } : step)),
    })
  }

  /**
   * One image through the whole walk, however it goes on. `hand` is handed the build the charm
   * answered before anything goes, and is where the image and its hash come from — the host's
   * package streamed to this phone, a file the reader picked, or a door the charm walks itself —
   * and it can draw a Downloading step of its own on the way in.
   */
  const send = async (hand: (was: string | null) => Promise<FirmwareHand>, heading: string) => {
    if (walk.running) return
    setWalk({
      again: { hand, title: heading },
      running: true,
      end: null,
      note: null,
      title: heading,
      steps: [],
    })
    // A poll that throws while the fetch watch runs: the link going down under it, which is the
    // reboot's own shape — the charm holds its Ready only briefly before it reboots, so on an
    // unlucky phase the next ask meets a charm already restarting. Held here and thrown again
    // only when the read-back below says the walk did not land.
    let dropped: unknown = null
    try {
      // The build the charm runs now, read before anything goes: the answer the reboot's read is
      // compared against, so a charm that could not say before is one whose any answer is the
      // change — and the one fact the door rule needs of the build the charm runs. A charm that
      // will not answer is no build, and the walk goes on without it.
      const was = (await api.version().catch(quietly("reading the charm's version"))) ?? null
      const next = await hand(was)
      if (next.kind === "fetch") {
        show("download", { subtitle: fetchWords(next.scheme), percent: 0 })
        // A refusal here is the charm's own answer to the hand, drawn as the failure it is.
        await api.update(next.url, next.sha256Hex)
        try {
          await watchCharmFetch(
            () => api.updateStatus(),
            (update) => show("download", { percent: update.percent }),
          )
        } catch (error) {
          // The charm's own Failed reason is an answer, not a reboot: drawn now, in its words.
          if (error instanceof FirmwareRefused) throw error
          dropped = error
        }
      } else {
        show("transfer", { percent: 0 })
        await api.upload(
          next.image,
          next.sha256Hex,
          (progress) => {
            const percent =
              progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0
            show("transfer", { percent })
          },
          uploadPace(was),
        )
        show("transfer", { percent: 100 })
      }
      // The end is a yes only once the slot is bootable: the charm reboots a moment later, and the
      // window is the phone's own asks for the version the new build answers with.
      show("restart", { subtitle: FIRMWARE_SENT })
      const { changed, version, answered } = await versionAfterReboot(() => api.version(), was)
      if (changed && version !== null) {
        setWalk({ end: { kind: "done", version, was } })
        return
      }
      // The build the charm answered is the one it was sent, which is the walk landing even where
      // the version never moved: a re-flash of the build the charm already runs is the fix-a-sick-
      // charm move, not a failure. A hand that names no build — the reader's own file — is landed on
      // by any answer; a published one names the build it sent, so an answer of another build, or
      // none at all, is the charm not coming back on it.
      if (typeof answered === "string" && (next.sends === null || answered === next.sends)) {
        setWalk({ end: { kind: "done", version: answered, was } })
        return
      }
      if (dropped !== null) throw dropped
      // The charm never answered on the new build: what is published is read again too, since a
      // merge may have moved the tag while this one was being tried.
      await firmware.reload()
      setWalk({
        end: { kind: "failed", said: FIRMWARE_NOT_BACK, step: walk.steps.at(-1)?.name },
      })
    } catch (error) {
      setWalk({
        end: {
          kind: "failed",
          said: spoken(error, "Something went wrong"),
          step: walk.steps.at(-1)?.name,
        },
      })
    } finally {
      // A walk that landed keeps no hand to run again — and a file walk's hand closes over the
      // `File` the reader picked, so holding it would pin up to a slot of bytes for as long as the
      // app runs. A failure keeps its hand: `Try again` is what that hand is for.
      const landed = walk.end?.kind === "done"
      setWalk(landed ? { running: false, again: null } : { running: false })
    }
  }

  /**
   * The published image, however the charm takes it: its own fetch where the charm's links allow
   * one, this phone's streamed copy otherwise. The hand reads the record again on every run, since
   * the charm fetches what the host serves now — and the SHA-256 it is handed, not the URL, is what
   * pins the bytes.
   */
  const runPublished = async (record: CharmFirmware) => {
    if (walk.running) return
    // The tap's own reading of the charge, before this visit is marked as begun: a refusal leaves
    // the offer standing, so a reader who charges the charm can press the same door again.
    if (!(await chargeHoldsAtTap())) return
    // This visit's walk began for this build: a visit that returns joins it rather than offering
    // the same build a second time.
    setWalk({ started: record.version })
    await send(async (was: string | null) => {
      const scheme = charmVoice(charm)
      const address = typeof charm?.talk === "string" ? charm.talk : undefined
      const report = (await api.network().catch(quietly("reading the charm's links"))) ?? null
      if (report && address && firmwareDoor(report, scheme, address, was) === "fetch") {
        // The record as the host answers it now: a read that fails or names no image is no fetch
        // to send the charm walking on — the transfer's own words say it better below.
        const served = await getCharmFirmware(hostForActiveBot(profile)).catch(
          quietly("reading the firmware the host serves"),
        )
        // The one answer in which this phone ever sees the token and the route it walks: they ride
        // the URL it builds, and the image's bytes stay pinned by the SHA-256 of the record — the
        // charm checks it before it writes the slot, so a tag that moved is refused by the hash,
        // not trusted by the URL.
        const mint = served
          ? await getCharmFirmwareFetch(hostForActiveBot(profile)).catch(
              quietly("minting the fetch door"),
            )
          : null
        if (served && mint) {
          try {
            return {
              kind: "fetch",
              url: firmwareFetchUrl(address, mint),
              sha256Hex: served.sha256,
              scheme,
              sends: record.version,
            }
          } catch (error) {
            // The URL could not fit the frame after all: the builder's bound is the backstop, and
            // the transfer below is the walk that cannot be refused on the wire.
            quietly("building the charm's fetch URL")(error)
          }
        }
        // The door was open and could not be walked: the image goes over this phone's link now,
        // and the walk says so — the reader is about to watch a longer bar than the one promised.
        setWalk({ note: FETCH_FALLBACK })
      }
      // The step is drawn as the read begins rather than with its first bytes: a host that refuses
      // the image outright still leaves the reader one row saying where the walk stopped.
      show("download", { percent: 0 })
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
        return { kind: "transfer", image, sha256Hex, sends: record.version }
      const fresh = await firmware.reload()
      const again = fresh?.state === "published" ? fresh.firmware : undefined
      if (again && again.size === image.length && again.sha256 === sha256Hex)
        return { kind: "transfer", image, sha256Hex, sends: record.version }
      throw new Error(PUBLISHED_CHANGED)
    }, `Updating to ${record.version}`)
  }

  /**
   * A file from the phone: its bytes, and the SHA-256 computed here over them — that hash is the
   * whole trust anchor, so what the charm checks is what this phone read. A file too big for a slot
   * is refused before a byte goes over the link: the slot the host publishes where it names one,
   * this phone's own constant otherwise. A file has no door to walk, whatever the charm's links: it
   * is this phone's bytes, so this phone sends them.
   */
  const sendFile = (chosen: File) => {
    if (chosen.size > (published?.slot ?? CHARM_SLOT_BYTES)) {
      setWalk({ note: FILE_TOO_BIG })
      return
    }
    void (async () => {
      // The same rule the published door wears, on the pick: a file the phone holds is not a way
      // round a charm that cannot take it.
      if (!(await chargeHoldsAtTap())) return
      await send(
        async () => {
          // The transfer is drawn as the file is read, so a read that fails leaves the row it was in.
          show("transfer", { percent: 0 })
          const image = new Uint8Array(await chosen.arrayBuffer())
          return { kind: "transfer", image, sha256Hex: await sha256Of(image), sends: null }
        },
        `Sending ${chosen.name}`,
      )
    })()
  }

  const [battery, setBattery] = useState<CharmBattery | undefined>(undefined)
  const [link, setLink] = useState<CharmNetworkReport | undefined>(undefined)
  const [shutAtTap, setShutAtTap] = useState(false)
  const asked = useRef(false)

  /**
   * The charge read again as a door is pressed. The offer drew on a reading taken when it opened,
   * and a charm's charge falls: the rule is asked once more at the tap rather than trusted to a row
   * drawn minutes ago. It is a confirmation and not a replacement — the offer keeps the reading it
   * drew — and a refused ask is no fact, so only an answer that says no shuts the tap.
   */
  const chargeHoldsAtTap = async () => {
    const now = await api.battery().catch(quietly("reading the charm's charge"))
    if (!chargeBlocks(now)) {
      setShutAtTap(false)
      return true
    }
    setShutAtTap(true)
    return false
  }

  /**
   * Whether this visit draws the offer: nothing is running, nothing has ended, and this visit has
   * not already begun a walk for the build that is published. A file screen offers at once — it has
   * no build to name — while the published offer waits for the host's read, so `Install` names the
   * build it will send.
   */
  const offering =
    !busy &&
    !end &&
    walk.started !== published?.version &&
    (pickMode || (firmware.settled && Boolean(published)))

  /**
   * The offer's two asks, made once as this visit can draw a door: the charge the gate reads and the
   * link it says. They are the charm's answers, so they are asked the moment a door could be drawn
   * rather than when the host's read lands — a registry slow to answer would otherwise leave the
   * charge row blank, and the gate late, this side of it. Only `Install`'s label waits on what is
   * published. A failed ask is no fact, so it is held as no answer rather than drawn as a fault.
   */
  const drawing = !busy && !end
  useEffect(() => {
    if (!drawing || asked.current) return
    asked.current = true
    void api.battery().then(setBattery).catch(quietly("reading the charm's charge"))
    void api.network().then(setLink).catch(quietly("reading the charm's links"))
  }, [api, drawing])

  /** The gate's answer, for the one door drawn outside the offer: a file under a host with nothing. */
  const blocked = chargeBlocks(battery)

  /**
   * What a failure's way forward re-runs: the same hand — the bytes read again, or the door asked
   * again — and the charge asked again with it, since this is a tap that starts a send like any
   * other.
   */
  const retry = () => {
    const last = walk.again
    if (walk.running || !last) return
    void (async () => {
      if (!(await chargeHoldsAtTap())) return
      await send(last.hand, last.title)
    })()
  }

  /** The step a failure stopped at, if it named one: the one row the walk marks. */
  const stopped = end?.kind === "failed" ? end.step : undefined

  return (
    <>
      {title && <Caption>{title}</Caption>}
      {busy && <Caption>{FIRMWARE_LEAVE}</Caption>}
      {steps.length > 0 && (
        <Group>
          {steps.map((step) => (
            <StepRow
              key={step.name}
              title={STEP_TITLES[step.name]}
              subtitle={step.subtitle}
              percent={step.percent}
              stopped={step.name === stopped}
            />
          ))}
        </Group>
      )}
      {end?.kind === "done" && (
        <Group>
          <div className={rowClass}>
            <RowText title="Done" subtitle={firmwareDoneWords(end.was, end.version)} />
          </div>
          {/* The end's own next step: a new build usually wants the bots, the pet and the voice
              hand-over again, and the page it leaves for runs that sync once on its return. */}
          <div className={rowClass}>
            <Button
              id="charm-update-sync"
              type="button"
              onClick={() => navigate("/settings/charm?sync=1")}
            >
              Sync your bots
            </Button>
          </div>
        </Group>
      )}
      {end?.kind === "failed" && (
        <Group>
          <div className={rowClass}>
            <p className="text-sm">{end.said}</p>
          </div>
          <div className={rowClass}>
            <Button id="charm-update-retry" type="button" disabled={busy} onClick={retry}>
              Try again
            </Button>
          </div>
          {/* The sure path, as a door rather than a sentence: the sheet says what a cable needs
              and hands the reader to the firmware's repository, where the flasher and its steps
              live. */}
          <SheetRow
            icon={CableIcon}
            title={CABLE_TITLE}
            sheet={({ open, onOpenChange }) => (
              <PickSurface open={open} onOpenChange={onOpenChange} title={CABLE_TITLE}>
                {CABLE_WORDS.map((said) => (
                  <p key={said} className="py-2 text-sm text-muted-foreground">
                    {said}
                  </p>
                ))}
                <Group>
                  <ActionRow
                    icon={ExternalLinkIcon}
                    title={REPO_ROW}
                    onClick={() => openExternal(FIRMWARE_REPO)}
                  />
                </Group>
              </PickSurface>
            )}
          />
          {/* The route behind this row is `DeveloperOnly`: drawn without the switch, it would
              bounce the reader back to the menu, so it waits for the settings to say it is on. */}
          {developer && <LinkRow to="/settings/debug-charm" title={CHARM_LOG} />}
        </Group>
      )}
      {note && <Caption>{note}</Caption>}
      {offering && (
        <Offer
          battery={battery}
          link={link}
          record={pickMode ? undefined : published}
          install={
            !pickMode && published
              ? { version: published.version, onInstall: () => void runPublished(published) }
              : undefined
          }
          onPick={sendFile}
          fileRef={file}
        />
      )}
      {pickMode && !offering && (
        <>
          <FileDoor alone disabled={busy || blocked} onPick={sendFile} fileRef={file} />
          {/* The third way this door is drawn, and the same rule on it: a door shut with no word
              beside it is a door a reader presses and cannot understand. */}
          {blocked && <Caption>{CHARGE_FIRST}</Caption>}
        </>
      )}
      {!pickMode && firmware.settled && !published && !end && !busy && (
        <>
          {checkSaid && <Caption>{checkSaid}</Caption>}
          <Caption>{FIRMWARE_NOT_PUBLISHED}</Caption>
          {/* The same gate, and the same line: a file door shut with no word beside it is a door a
              reader presses and cannot understand. */}
          <FileDoor alone disabled={busy || blocked} onPick={sendFile} fileRef={file} />
          {blocked && <Caption>{CHARGE_FIRST}</Caption>}
        </>
      )}
      {/* The tap's own reading, under whichever door was pressed: the offer stands, and the line
          that says what opens it is the only thing the refusal adds. */}
      {shutAtTap && <Caption>{CHARGE_FIRST}</Caption>}
    </>
  )
}

/**
 * One step as it walks: its name, the line under it, and its bar while it has one. The step a
 * failure stopped at wears the destructive tone on its title and one line saying the walk stopped
 * there, under the line the step itself was saying — so which of the three failed is read off the
 * list without the progress that step had already reported being taken away from it.
 */
function StepRow({
  title,
  subtitle,
  percent,
  stopped,
}: {
  title: string
  subtitle?: string
  percent?: number
  /** Whether this is the step the walk stopped in: the one row a failure marks. */
  stopped?: boolean
}) {
  return (
    <div
      className={cn(rowClass, "flex-col items-start gap-2")}
      data-stopped={stopped ? "" : undefined}
    >
      <RowText
        title={<span className={stopped ? "text-destructive" : undefined}>{title}</span>}
        subtitle={subtitle}
      />
      {stopped && <p className="text-sm text-muted-foreground">{STEP_STOPPED}</p>}
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
 * The offer a fresh visit reads before anything goes: the charm's charge and link, the instruction
 * the link needs, what the release says changed, and the doors. The charge is the gate — under 20%
 * off the charger shuts both, with one line saying what opens them — and the What's-new row is
 * drawn only where the release names notes or the host refused them.
 */
function Offer({
  battery,
  link,
  install,
  record,
  onPick,
  fileRef,
}: {
  battery: CharmBattery | undefined
  link: CharmNetworkReport | undefined
  /** The published door, on the build it names; a screen opened for a file draws none. */
  install?: { version: string; onInstall: () => void }
  /** The record the offer is drawn from: its notes, its size and the date it was built. */
  record?: CharmFirmware
  onPick: (file: File) => void
  fileRef: { current: HTMLInputElement | null }
}) {
  const built = record?.built ? builtWords(record.built) : null
  /** The gate's answer, read from the charge it was drawn with: under 20% off the charger, shut. */
  const blocked = chargeBlocks(battery)
  return (
    <>
      <Group>
        <ValueRow title="Battery" value={batteryWords(battery)} muted={battery === undefined} />
        <ValueRow title="Link" value={offerLinkWords(link)} muted={link === undefined} />
        <div className={rowClass}>
          <RowText title={KEEP_CLOSE} />
        </div>
        {record && (record.notes || record.notesRefusal) && (
          <SheetRow
            icon={SparklesIcon}
            title={NOTES_TITLE}
            sheet={({ open, onOpenChange }) => (
              <PickSurface open={open} onOpenChange={onOpenChange} title={NOTES_TITLE}>
                {record.notes ? (
                  <p className="whitespace-pre-line py-2 text-sm">{record.notes}</p>
                ) : (
                  <p className="py-2 text-sm text-muted-foreground">{record.notesRefusal}</p>
                )}
                <p className="py-2 text-sm text-muted-foreground">{notesSizeWords(record.size)}</p>
                {built && <p className="py-2 text-sm text-muted-foreground">{built}</p>}
                <p className="py-2 text-sm text-muted-foreground">{FIRMWARE_CAPTION}</p>
                <p className="py-2 text-sm text-muted-foreground">{FIRMWARE_CHECKED}</p>
              </PickSurface>
            )}
          />
        )}
        <div className={cn(rowClass, "flex-wrap")}>
          {install && (
            <Button
              id="charm-update-install"
              type="button"
              disabled={blocked}
              onClick={install.onInstall}
            >
              Install {install.version}
            </Button>
          )}
          <FileDoor disabled={blocked} onPick={onPick} fileRef={fileRef} />
        </div>
      </Group>
      {blocked && <Caption>{CHARGE_FIRST}</Caption>}
    </>
  )
}

/**
 * The reader's own way onto the walk: a file the phone already holds. A web file input is the
 * whole Android picker — the WebView opens the system's own — and it is cleared after each pick,
 * so a second try at a failed upload is exactly when picking the same file again works.
 *
 * `alone` is the door drawn by itself — a screen with nothing published, or a walk already ended —
 * rather than beside the offer's `Install`. It is the same button and the same input either way:
 * one door written once, wrapped in the row it stands in when it has no row of its own.
 */
function FileDoor({
  disabled,
  onPick,
  fileRef,
  alone,
}: {
  disabled?: boolean
  onPick: (file: File) => void
  fileRef: { current: HTMLInputElement | null }
  /** Whether this is the screen's only door: it draws the group and row around itself. */
  alone?: boolean
}) {
  const door = (
    <>
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
    </>
  )
  if (!alone) return door
  return (
    <Group>
      <div className={rowClass}>{door}</div>
    </Group>
  )
}
