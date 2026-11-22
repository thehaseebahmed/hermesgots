/**
 * Settings → Charm: pair a Gots Charm, then send every bot to it, and decide whether one of them
 * lives there as a pet. The charm keeps them, with their pictures, after the phone has gone.
 * Android only, since only the app has the radio.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react"
import { useLiveQuery } from "dexie-react-hooks"
import {
  BatteryMediumIcon,
  BellRingIcon,
  CloudDownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FileUpIcon,
  HandIcon,
  PawPrintIcon,
  RefreshCwIcon,
  UnlinkIcon,
  WifiOffIcon,
} from "lucide-react"

import { Banner } from "@/components/banner"
import { ConfirmDestructive } from "@/components/confirm-destructive"
import {
  ActionRow,
  Caption,
  Group,
  PickList,
  PickSurface,
  RowText,
  SwitchRow,
  ValueRow,
  fieldInnerClass,
  fieldInputClass,
  fieldLabelClass,
  headerRowClass,
  rowClass,
} from "@/components/settings-chrome"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { botsByLabel, labelOf } from "@/lib/bot-name"
import {
  charmAvailable,
  charmBots,
  charmFirmwareVersion,
  charmNetwork,
  charmPoses,
  charmUpdateStatus,
  forgetCharm,
  forgetCharmWifi,
  hostForActiveBot,
  pairCharm,
  PUBLISHED_FIRMWARE,
  readCharmBattery,
  sendTestAlert,
  setCharmPet,
  setCharmTailnetKey,
  setCharmWifi,
  setCharmWake,
  syncToCharm,
  uploadCharmFirmware,
  useCharmReport,
  usePairedCharm,
} from "@/lib/charm"
import {
  CHARM_QUIET_PRESETS,
  CHARM_SLOT_BYTES,
  CharmCode,
  CharmUpdateState,
  charmKept,
  charmWakeOf,
  codeWords,
  hexOf,
  petSettingsFrom,
  type CharmBatterySeen,
  type CharmNetworkReport,
  type CharmPetChoice,
  type CharmUpdateStatus,
  type CharmWake,
  type CharmWifiRecord,
} from "@/lib/charm-protocol"
import { type FirmwareProgress, versionAfterReboot } from "@/lib/charm-firmware"
import type { SyncProgress } from "@/lib/charm-sync"
import { getActiveProfile, listProfiles } from "@/lib/db"
import type { PluginServer } from "@/lib/features"
import { getCharmFirmwareImage } from "@/lib/hermes"
import { useHostRecord } from "@/lib/host-record"
import {
  BATTERY_ASK,
  batteryWords,
  doubleTapSubtitle,
  FILE_TOO_BIG,
  FIRMWARE_CAPTION,
  FIRMWARE_NOT_BACK,
  FIRMWARE_SENT,
  firmwareOffers,
  firmwareWords,
  LINK_DOWN_WORDS,
  LINK_MARKS,
  linksDown,
  petSubtitle,
  PUBLISHED_CHANGED,
  QUIET_TITLE,
  quietWords,
  readFailed,
  readValue,
  tailnetWords,
  updateWords,
  updateProgressWords,
  wifiWords,
  type CharmLink,
  type CharmRead,
  type CharmRunning,
  type CharmSeen,
} from "@/lib/charm-words"
import { quietly } from "@/lib/report"
import { tell } from "@/lib/tell"
import { useBotLabels } from "@/lib/use-bot-labels"

const message = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Something went wrong"

/** The SHA-256 of bytes this phone holds, as the lowercase hex the link takes. */
const sha256Of = async (image: Uint8Array) =>
  hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", image as unknown as BufferSource)))

/** How often a running firmware download is asked where it has got to. */
const UPDATE_POLL_MS = 2_000

/**
 * The Network section's radio, as the page reaches it: every call is one control ask over the
 * charm's own link. It is an interface so a test can draw the section's answers without a radio.
 * What the host says about the published firmware is not the charm's answer, and is not here: it is
 * that host's own record, read by the row below.
 */
export interface CharmNetworkApi {
  status(): Promise<CharmNetworkReport>
  saveWifi(ssid: string, pass: string): Promise<number>
  forget(): Promise<number>
  saveTailnet(key: string): Promise<number>
  updateStatus(): Promise<CharmUpdateStatus>
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
const RADIO: CharmNetworkApi = {
  status: charmNetwork,
  saveWifi: setCharmWifi,
  forget: forgetCharmWifi,
  saveTailnet: setCharmTailnetKey,
  updateStatus: charmUpdateStatus,
  version: charmFirmwareVersion,
  upload: uploadCharmFirmware,
}

/** One form's body in a group: the card's own fill, under the row that heads it. */
const formRowClass = "flex flex-col gap-4 bg-card px-5 py-4"

/** A labelled field of the network forms: the label above, the filled pill below. */
function Field({
  id,
  label,
  hint,
  ...input
}: { id: string; label: string; hint?: ReactNode } & Omit<
  ComponentProps<typeof Input>,
  "id" | "className"
>) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={fieldLabelClass}>
        {label}
      </label>
      <Input id={id} className={fieldInputClass} autoComplete="off" spellCheck={false} {...input} />
      {hint && <p className="px-1 text-xs break-all text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * A field whose value is a secret: masked, with the show toggle a key field wears, so a passphrase
 * can be read back while it is being typed and never again after the write.
 */
function SecretField({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={fieldLabelClass}>
        {label}
      </label>
      <InputGroup className="h-12 rounded-full bg-muted">
        <InputGroupInput
          id={id}
          className={fieldInnerClass}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          type={shown ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-sm"
            className="mr-1 size-10 rounded-full"
            aria-label={shown ? `Hide ${label}` : `Show ${label}`}
            onClick={() => setShown((open) => !open)}
          >
            {shown ? <EyeOffIcon /> : <EyeIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

/**
 * A link's own mark at a row's size: the pair row and both link headers wear the one map the status
 * row wears, so a link cannot be a globe here and the charm's waypoints two rows down.
 */
function LinkIcon({ link }: { link: CharmLink }) {
  const Mark = LINK_MARKS[link]
  return <Mark className="size-5 shrink-0 text-muted-foreground" />
}

/**
 * Settings → Charm's network: the Wi-Fi the charm joins, the tailnet key it joins with, and the
 * firmware it runs — the version it says it has beside the one the package publishes, an update when
 * that one is newer, and a file the reader picks. Every row draws the charm's own answer rather than
 * what was sent, and a passphrase or a key clears the moment the write has gone: neither is ever
 * drawn again, and neither is kept on this phone.
 */
export function CharmNetwork({
  api = RADIO,
  profile,
  record,
  tailnet,
  read,
  refresh,
}: {
  /** The radio, or a stand-in under test. */
  api?: CharmNetworkApi
  /** The bot whose host publishes the firmware: the row's read of it is that host's record. */
  profile?: PluginServer
  /** The network this phone last told the charm to join, while the charm itself is not answering. */
  record?: CharmWifiRecord
  /** Whether a tailnet key was handed over before, while the charm itself is not answering. */
  tailnet?: boolean
  /**
   * The page's own read of the charm's links, made above this section: the same one the status row
   * draws, so the two rows cannot disagree about what the charm said.
   */
  read: CharmRead<CharmNetworkReport>
  /** Asks the charm's links again after a write: the section never makes that ask itself. */
  refresh: () => Promise<void>
}) {
  const [update, setUpdate] = useState<CharmRead<CharmUpdateStatus>>({ state: "reading" })
  const [ssid, setSsid] = useState("")
  const [pass, setPass] = useState("")
  const [key, setKey] = useState("")
  /** Which build the charm runs, as its own answer says. */
  const [running, setRunning] = useState<CharmRunning>({ state: "reading" })
  /**
   * What the host says `latest` holds, as one of its own records: read when the row opens, kept for
   * its next open, and read again when a merge may have moved the tag. A plugin older than the route
   * answers nothing, and the row says it couldn't check.
   */
  const firmware = useHostRecord(profile, PUBLISHED_FIRMWARE, undefined)
  const seen = firmware.value
  const published = seen?.state === "published" ? seen.firmware : undefined
  /** The host's own sentence where its read was refused, which is not a charmed-nothing-said. */
  const checkSaid = seen?.state === "refused" ? seen.said : null
  const [progress, setProgress] = useState<FirmwareProgress | null>(null)
  const [busy, setBusy] = useState<"wifi" | "forget" | "tailnet" | "update" | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [watching, setWatching] = useState(false)
  const file = useRef<HTMLInputElement | null>(null)

  /** The two versions the row compares: the charm's own, and the package's as its host reads it. */
  const versions = { running, published: published?.version, answered: firmware.settled }
  const offers = firmwareOffers(versions)

  /** What the charm last answered about its two links, and where its download had got to. */
  const links = readValue(read)
  const downloading = readValue(update)

  /**
   * Where the charm's download has got to, asked when the section opens and again after each write. A
   * failed ask keeps what an earlier one found — the charm is out of reach, not empty — and says why,
   * since refused, disconnected and timed out are three facts rather than one silence.
   */
  const readUpdate = useCallback(
    () =>
      api.updateStatus().then(
        (value) => {
          setUpdate({ state: "read", value })
          return value
        },
        (reason: unknown) => {
          quietly("reading the charm's download")(reason)
          setUpdate(readFailed)
          return undefined
        },
      ),
    [api],
  )

  /**
   * The charm's own version when the row opens: a version it can't say stays unsaid rather than
   * guessed, and a link that never opened is its own fact. What the package publishes is the host's
   * record above, read alongside it.
   */
  useEffect(() => {
    void api.version().then(
      (found) =>
        setRunning(found === null ? { state: "too-old" } : { state: "says", version: found }),
      () => setRunning({ state: "unreachable" }),
    )
  }, [api])

  // The download's own line: read once on opening, and again after each write.
  useEffect(() => {
    void readUpdate().then((found) => {
      // A download already running when the row opens is followed to its end, as one it started was.
      if (found?.state === CharmUpdateState.Downloading) setWatching(true)
    })
  }, [readUpdate])

  // A download that is running is asked where it has got to until it stops running.
  useEffect(() => {
    if (!watching) return
    let live = true
    const timer = setInterval(() => {
      void api
        .updateStatus()
        .then((next) => {
          if (!live) return
          setUpdate({ state: "read", value: next })
          if (next.state !== CharmUpdateState.Downloading) setWatching(false)
        })
        .catch(() => {
          if (!live) return
          // The charm stopped answering: the poll ends, and what it last said is still what it said.
          setUpdate((before) => readFailed(before))
          setWatching(false)
        })
    }, UPDATE_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [watching, api])

  /** One write, its answer said in words: null while it is refused or never lands. */
  const write = async (what: typeof busy, run: () => Promise<number>): Promise<number | null> => {
    setBusy(what)
    setSaid(null)
    try {
      const code = await run()
      // A refusal gets the code's words. A plaintext charm's 11 is a yes whose words are the warning
      // that anyone holding the charm can read the secret off the chip, so it says them too.
      setSaid(code === CharmCode.Ok ? null : codeWords(code))
      // A write the charm kept is read back: its links and its download, from the same asks as before.
      if (charmKept(code)) await Promise.all([refresh(), readUpdate()])
      return code
    } catch (error) {
      setSaid(message(error))
      return null
    } finally {
      setBusy(null)
    }
  }

  const saveWifi = async () => {
    const code = await write("wifi", () => api.saveWifi(ssid.trim(), pass))
    // The charm has the passphrase now, or refused it: either way this field never draws it again.
    if (code !== null) setPass("")
  }

  const forgetNetwork = async () => {
    const code = await write("forget", () => api.forget())
    if (code === CharmCode.Ok) setSsid("")
  }

  const saveKey = async () => {
    const code = await write("tailnet", () => api.saveTailnet(key.trim()))
    // The key is the charm's from here on, and is never drawn again.
    if (code !== null) setKey("")
  }

  /**
   * The version again once the charm is back: a change is what says the new build booted, and a
   * charm that never answered on it is the row's to say rather than a success left standing. The
   * build compared against is the one the row read: null where it read none, so any answer is the
   * change — a charm that could not say its build before is not a charm that came back on one.
   */
  const readBack = async () => {
    const was = running.state === "says" ? running.version : null
    const { changed, version } = await versionAfterReboot(() => api.version(), was)
    if (changed) setRunning(version === null ? { state: "too-old" } : { state: "says", version })
    return changed
  }

  /**
   * One image over the link, however the phone came by it, and the versions read again once the
   * charm is back. `load` is where the bytes and the hash come from: the host's package, or a file
   * the reader picked.
   */
  const send = async (load: () => Promise<{ image: Uint8Array; sha256Hex: string }>) => {
    // The status poll holds a link of its own every two seconds; an upload needs the charm to itself.
    setWatching(false)
    setBusy("update")
    setSaid(null)
    setProgress(null)
    try {
      const { image, sha256Hex } = await load()
      setProgress({ sent: 0, total: image.length })
      await api.upload(image, sha256Hex, setProgress)
      setSaid(FIRMWARE_SENT)
      if (await readBack()) return
      // The charm never answered on the new build: the offer is read again too, since a merge may
      // have published another version while this one was being tried.
      setSaid(FIRMWARE_NOT_BACK)
      await firmware.reload()
    } catch (error) {
      setSaid(message(error))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  /**
   * The published image, checked against the version this row read: the bytes and their hash are
   * what the link would send, so a package that moved between the two reads is refused here rather
   * than by the charm after the whole image.
   */
  const sendPublished = () =>
    send(async () => {
      if (!published) throw new Error("The published firmware is not known yet.")
      const image = await getCharmFirmwareImage(hostForActiveBot(profile))
      const sha256Hex = await sha256Of(image)
      if (image.length === published.size && sha256Hex === published.sha256)
        return { image, sha256Hex }
      // The tag may have moved between the row's read and this one: the version it names now is
      // the one these bytes have to match before anything goes over the link.
      const again = await firmware.reload()
      const fresh = again?.state === "published" ? again.firmware : undefined
      if (fresh && fresh.size === image.length && fresh.sha256 === sha256Hex)
        return { image, sha256Hex }
      throw new Error(PUBLISHED_CHANGED)
    })

  /**
   * A file from the phone: its bytes, and the SHA-256 computed here over them — that hash is the
   * whole trust anchor, so what the charm checks is what this phone read. A file too big for a slot
   * is refused before a byte goes over the link: the slot the host publishes where it names one, this
   * phone's own constant otherwise.
   */
  const sendFile = async (picked: File) => {
    if (picked.size > (published?.slot ?? CHARM_SLOT_BYTES)) {
      setSaid(FILE_TOO_BIG)
      return
    }
    await send(async () => {
      const image = new Uint8Array(await picked.arrayBuffer())
      return { image, sha256Hex: await sha256Of(image) }
    })
  }

  return (
    <>
      {said && <Caption>{said}</Caption>}
      <Group>
        <div className={headerRowClass}>
          <LinkIcon link="wifi" />
          <RowText title="Wi-Fi" subtitle={wifiWords(links?.wifi, record)} />
        </div>
        <form
          className={formRowClass}
          onSubmit={(event) => {
            event.preventDefault()
            void saveWifi()
          }}
        >
          <Field
            id="charm-wifi-ssid"
            label="Network name"
            placeholder="Home"
            autoCapitalize="none"
            value={ssid}
            disabled={busy !== null}
            onChange={(event) => setSsid(event.target.value)}
          />
          <SecretField
            id="charm-wifi-pass"
            label="Passphrase"
            placeholder="Nothing, for an open network"
            value={pass}
            disabled={busy !== null}
            onChange={setPass}
          />
          <div className="flex items-center gap-2">
            <Button
              id="charm-wifi-save"
              type="submit"
              disabled={busy !== null || ssid.trim() === ""}
            >
              {busy === "wifi" ? "Saving…" : "Save"}
            </Button>
            <Button
              id="charm-wifi-forget"
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void forgetNetwork()}
            >
              <WifiOffIcon />
              Forget
            </Button>
          </div>
        </form>
      </Group>
      <Group>
        <div className={headerRowClass}>
          <LinkIcon link="tailnet" />
          <RowText title="Tailnet" subtitle={tailnetWords(links?.tailnet, tailnet)} />
        </div>
        <form
          className={formRowClass}
          onSubmit={(event) => {
            event.preventDefault()
            void saveKey()
          }}
        >
          <SecretField
            id="charm-tailnet-key"
            label="Auth key"
            placeholder="tskey-auth-…"
            value={key}
            disabled={busy !== null}
            onChange={setKey}
          />
          <div className="flex items-center gap-2">
            <Button
              id="charm-tailnet-save"
              type="submit"
              disabled={busy !== null || key.trim() === ""}
            >
              {busy === "tailnet" ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </Group>
      <Group>
        <div className={headerRowClass}>
          <CloudDownloadIcon className="size-5 shrink-0 text-muted-foreground" />
          <RowText title="Firmware" subtitle={firmwareWords(versions)} />
        </div>
        <div className={formRowClass}>
          <div className="flex flex-wrap items-center gap-2">
            {offers && published && (
              <Button
                id="charm-update-start"
                type="button"
                disabled={busy !== null}
                onClick={() => void sendPublished()}
              >
                {busy === "update" && progress
                  ? updateProgressWords(progress)
                  : `Update to ${published.version}`}
              </Button>
            )}
            <Button
              id="charm-update-pick"
              type="button"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => file.current?.click()}
            >
              <FileUpIcon />
              Choose a file…
            </Button>
            {/* A web file input is the whole Android picker: the WebView opens the system's own. */}
            <input
              ref={file}
              id="charm-update-file"
              type="file"
              className="hidden"
              onChange={(event) => {
                const input = event.currentTarget
                const picked = input.files?.[0]
                // Cleared so the same file picked again fires `change`: a second try at a failed
                // upload is exactly when a reader picks the file they just picked.
                input.value = ""
                if (picked) void sendFile(picked)
              }}
            />
          </div>
        </div>
      </Group>
      {checkSaid && <Caption>{checkSaid}</Caption>}
      <Caption>{FIRMWARE_CAPTION}</Caption>
      {downloading && downloading.state !== CharmUpdateState.Idle && (
        <Caption>{updateWords(downloading)}</Caption>
      )}
      <Caption>
        The image goes over the charm's own link, and the charm checks it against the SHA-256 it was
        given before it keeps it. A passphrase stays on the charm across a reboot: a charm whose
        flash isn't sealed says so, and warns that anyone holding it can read the passphrase off the
        chip.
      </Caption>
    </>
  )
}

/**
 * The paired section's first row: its name with a mark for each link that is down, and its level as
 * the line beneath — the row's subtitle, as every row in this page's groups keeps its value. Its own
 * component so a test can draw it with props and no radio, as the battery row and the waking group
 * already are. The level is drawn always, unlike the glass's, because a settings page has no band to
 * pull — and a mark is drawn only for a link the page has read and found down, since a mark for a
 * fact nobody has read would be a guess.
 */
export function CharmStatusRow({
  charm,
  status,
  battery,
}: {
  charm: CharmSeen
  /** The page's own read of the charm's link, and the last report it answered with. */
  status: CharmRead<CharmNetworkReport>
  /** What the charm last said its charge was. */
  battery?: CharmBatterySeen
}) {
  return (
    <div className={rowClass}>
      <RowText
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{charm.name}</span>
            {linksDown(status).map((link) => {
              const Mark = LINK_MARKS[link]
              return (
                <Mark
                  key={link}
                  role="img"
                  aria-label={LINK_DOWN_WORDS[link]}
                  className="size-4 shrink-0 text-muted-foreground"
                />
              )
            })}
          </span>
        }
        subtitle={batteryWords(battery)}
      />
    </div>
  )
}

export function CharmSettings() {
  const charm = usePairedCharm()
  const profiles = useLiveQuery(listProfiles, [])
  /** The bot whose host publishes the firmware: the row's own read of it is that host's record. */
  const profile = useLiveQuery(getActiveProfile, [])
  const labels = useBotLabels()
  const [busy, setBusy] = useState<"pair" | "sync" | "test" | "wake" | "battery" | null>(null)
  /** The page's own read of the charm's links: the status row and the Network section both draw it. */
  const { read: status, refresh: refreshStatus } = useCharmReport()
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [batteryNote, setBatteryNote] = useState<string | undefined>(undefined)
  const [forgetting, setForgetting] = useState(false)
  const [picking, setPicking] = useState(false)
  const sending = useRef(false)

  // The glass's own settings as this phone holds them, put back to the charm's defaults where the
  // stored copy says something it could not have chosen.
  const wake = charmWakeOf(charm?.wake)

  // A change goes at once, in its own connection: a switch that waited for the next sync would look
  // broken for as long as the reader does not sync. The phone's copy is written first, so the switch
  // stays where the reader put it even when the charm is out of reach.
  const applyWake = async (next: CharmWake) => {
    setBusy("wake")
    setFailure(null)
    try {
      await setCharmWake(next)
    } catch (error) {
      setFailure(message(error))
    } finally {
      setBusy(null)
    }
  }

  // A failed read is the row's own line, not the page's banner: the battery is the only thing that
  // row is about, and a charm whose firmware predates the op should say so where the level goes.
  const refreshBattery = async () => {
    if (!charm || sending.current) return
    sending.current = true
    setBusy("battery")
    try {
      await readCharmBattery()
      setBatteryNote(undefined)
    } catch (error) {
      setBatteryNote(message(error))
    } finally {
      sending.current = false
      setBusy(null)
    }
  }

  // One reading when the section opens: the charm is the only thing that knows its charge, and an
  // old reading is drawn with its age rather than pretended to be now. The row's tap asks again, and
  // a sync asks after it finishes.
  const deviceId = charm?.deviceId
  useEffect(() => {
    if (!deviceId) return
    void readCharmBattery()
      .then(() => setBatteryNote(undefined))
      .catch((error) => setBatteryNote(message(error)))
  }, [deviceId])

  if (!charmAvailable())
    return (
      <Banner tone="info">
        A Gots Charm pairs with the Android app over Bluetooth. Open Gots on your phone to set one
        up.
      </Banner>
    )

  const pair = async () => {
    setBusy("pair")
    setFailure(null)
    try {
      const next = await pairCharm()
      tell.success(`Paired with ${next.name}`)
    } catch (error) {
      // Closing the picker is a choice, not a failure.
      if (!/cancel/i.test(message(error))) setFailure(message(error))
    } finally {
      setBusy(null)
    }
  }

  // The charm's own order, so the picker lists bots as the carousel does.
  const sources = botsByLabel(profiles ?? [], labels).filter((p) => !p.disabled)
  const pet = charm?.pet
  const petProfile = sources.find((p) => p.id === pet?.botId)
  const petName = petProfile ? labelOf(labels, petProfile) : undefined

  // `choice` is what the sheet has just written, for the sends that follow a tap: the store the
  // charm is read from re-renders after this call, not before it.
  const sync = async (choice?: CharmPetChoice) => {
    // `busy` is a render behind, so two taps in one tick would both reach the radio.
    if (sending.current || !profiles) return
    sending.current = true
    setBusy("sync")
    setFailure(null)
    setProgress(null)
    try {
      const bots = await charmBots(sources, labels)
      const settings = petSettingsFrom(
        choice ?? pet,
        sources.map((p) => p.id),
      )
      // Pictures are the character's, so the pet's are drawn from its profile's botId.
      const petBot = sources.find((p) => p.id === settings.petBotId)
      const poses = settings.enabled && petBot ? await charmPoses(petBot.botId) : []
      const done = await syncToCharm(bots, setProgress, { pet: { settings, poses } })
      tell.success(done.total === 1 ? "1 bot on your charm" : `${done.total} bots on your charm`)
      if (done.petRefused && settings.enabled)
        tell.info("Your bots synced. This charm's firmware has no pet mode yet.")
      // A sync just spent a connection and the charm is awake on the other end: the battery is
      // cheap to ask now, and the row is one sync fresher for it.
      await readCharmBattery().catch(quietly("reading the charm's battery"))
    } catch (error) {
      setFailure(message(error))
    } finally {
      sending.current = false
      setBusy(null)
      setProgress(null)
    }
  }

  const applyPet = async (choice: CharmPetChoice) => {
    setCharmPet(choice)
    await sync(choice)
  }

  const choosePet = async (botId: string) => {
    setPicking(false)
    await applyPet({ enabled: true, botId })
  }

  // A bare tap on with no pet picked takes the first bot; a pet whose bot has gone is not one.
  const togglePet = async (on: boolean) => {
    const botId =
      petSettingsFrom(
        pet,
        sources.map((p) => p.id),
      ).petBotId || sources[0]?.id
    if (on && !botId) {
      setFailure("Add a bot first: the pet is one of your bots.")
      return
    }
    await applyPet({ enabled: on, botId })
  }

  const count = sources.length

  // The first bot the charm holds, which is the one a test alert names: the same order a sync sends.
  const first = botsByLabel(profiles ?? [], labels).filter((profile) => !profile.disabled)[0]

  const test = async () => {
    if (!first) return
    setBusy("test")
    setFailure(null)
    try {
      await sendTestAlert(first)
      tell.success("Sent a test alert")
    } catch (error) {
      setFailure(message(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      {failure && <Banner tone="error">{failure}</Banner>}
      {charm ? (
        <>
          <Group>
            <CharmStatusRow charm={charm} status={status} battery={charm.battery} />
            <BatteryRow note={batteryNote} busy={busy !== null} onRefresh={refreshBattery} />
            <button
              type="button"
              className={rowClass}
              onClick={() => sync()}
              disabled={busy !== null || count === 0}
            >
              <RefreshCwIcon
                className={`size-5 shrink-0 text-muted-foreground ${busy === "sync" ? "animate-spin" : ""}`}
              />
              <RowText
                title={busy === "sync" ? "Syncing…" : "Sync"}
                subtitle={
                  progress
                    ? `${progress.done} of ${progress.total} bots`
                    : count === 0
                      ? "No bots to send"
                      : count === 1
                        ? "Sends your bot and its picture"
                        : `Sends your ${count} bots and their pictures`
                }
              />
            </button>
          </Group>
          <WakingGroup wake={wake} busy={busy !== null} onChange={applyWake} />
          <Group>
            <SwitchRow
              id="charm-pet-mode"
              icon={PawPrintIcon}
              title="Pet mode"
              subtitle={petSubtitle(pet, petName)}
              checked={Boolean(pet?.enabled && petProfile)}
              disabled={busy !== null || !profiles}
              onCheckedChange={togglePet}
            />
            {pet?.enabled && (
              <ValueRow
                title="The pet"
                purpose="Feed it and play with it on the charm"
                value={petName}
                muted={!petName}
                onClick={() => setPicking(true)}
                disabled={busy !== null}
              />
            )}
            <button
              type="button"
              className={rowClass}
              onClick={test}
              disabled={busy !== null || !first}
            >
              <BellRingIcon className="size-5 shrink-0 text-muted-foreground" />
              <RowText
                title={busy === "test" ? "Sending…" : "Send a test alert"}
                subtitle={
                  first
                    ? "Buzzes your charm as if your first bot needed an approval"
                    : "No bots on your charm to test with"
                }
              />
            </button>
          </Group>
          <CharmNetwork
            profile={profile}
            record={charm.wifi}
            tailnet={charm.tailnet}
            read={status}
            refresh={refreshStatus}
          />
          <Group>
            <ActionRow
              icon={UnlinkIcon}
              title="Forget this charm"
              onClick={() => setForgetting(true)}
            />
          </Group>
          <Caption>
            Keep the charm close while it syncs. Afterwards it shows your bots on its own, with the
            phone away. It holds names and pictures only, never keys or server addresses.
          </Caption>
          <PickSurface open={picking} onOpenChange={setPicking} title="The pet">
            <PickList
              label="Your bots"
              searchable={false}
              selected={pet?.botId}
              options={sources.map((profile) => ({
                id: profile.id,
                label: labelOf(labels, profile),
              }))}
              onPick={choosePet}
            />
          </PickSurface>
          <ConfirmDestructive
            open={forgetting}
            onOpenChange={setForgetting}
            title="Forget this charm?"
            description="This phone stops syncing to it. The charm keeps the bots it has. To pair again, remove it from Android's Bluetooth settings too."
            confirmLabel="Forget"
            onConfirm={async () => {
              forgetCharm()
              tell.success("Charm forgotten")
            }}
          />
        </>
      ) : (
        <>
          <Group>
            <button type="button" className={rowClass} onClick={pair} disabled={busy !== null}>
              <LinkIcon link="bluetooth" />
              <RowText
                title={busy === "pair" ? "Pairing…" : "Pair a charm"}
                subtitle="Turn the charm on and keep it close"
              />
            </button>
          </Group>
          <Caption>
            Pick “Gots Charm”, then type the six-digit code it shows. You only pair once.
          </Caption>
        </>
      )}
    </>
  )
}

/**
 * The glass's own settings: whether two taps wake it, and how long it stays lit. Its own component
 * so a test can mount it with props and no radio, as the chrome's rows already are.
 */
export function WakingGroup({
  wake,
  busy,
  onChange,
}: {
  wake: CharmWake
  busy: boolean
  onChange: (wake: CharmWake) => void
}) {
  const [picking, setPicking] = useState(false)
  return (
    <>
      <Group>
        <SwitchRow
          id="charm-double-tap"
          icon={HandIcon}
          title="Double tap to wake"
          subtitle={doubleTapSubtitle(wake.doubleTap)}
          checked={wake.doubleTap}
          disabled={busy}
          onCheckedChange={(on) => onChange({ ...wake, doubleTap: on })}
        />
        <ValueRow
          title={QUIET_TITLE}
          purpose="After your last tap, flick or button"
          value={quietWords(wake.quietSeconds)}
          onClick={() => setPicking(true)}
          disabled={busy}
        />
      </Group>
      <PickSurface open={picking} onOpenChange={setPicking} title={QUIET_TITLE}>
        <PickList
          label="Quiet time"
          searchable={false}
          selected={String(wake.quietSeconds)}
          options={CHARM_QUIET_PRESETS.map((seconds) => ({
            id: String(seconds),
            label: quietWords(seconds),
          }))}
          onPick={(id) => {
            setPicking(false)
            const picked = CHARM_QUIET_PRESETS.find((seconds) => String(seconds) === id)
            if (picked && picked !== wake.quietSeconds) onChange({ ...wake, quietSeconds: picked })
          }}
        />
      </PickSurface>
    </>
  )
}

/**
 * The control that asks the charm for its charge. What the charm answered is the status row's line,
 * so this row says what a tap does — and, when an ask failed, why it did.
 */
export function BatteryRow({
  note,
  busy,
  onRefresh,
}: {
  /** Why the last ask failed, in words: the row's line while it stands. */
  note?: string
  busy: boolean
  onRefresh: () => void
}) {
  return (
    <button type="button" className={rowClass} onClick={onRefresh} disabled={busy}>
      <BatteryMediumIcon className="size-5 shrink-0 text-muted-foreground" />
      <RowText title="Battery" subtitle={note ?? BATTERY_ASK} />
    </button>
  )
}
